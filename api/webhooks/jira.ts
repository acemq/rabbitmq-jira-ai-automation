import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../../lib/supabase.js';
import { adfToPlaintext } from '../../lib/adf-to-plaintext.js';
import { randomDelayMinutes, scheduledFor } from '../../lib/delay.js';
import { getOrgFieldId } from '../../lib/jira-client.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate webhook secret
  const secret = req.query.secret as string;
  if (!process.env.JIRA_WEBHOOK_SECRET || secret !== process.env.JIRA_WEBHOOK_SECRET) {
    console.warn('[webhook/jira] Invalid or missing secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body as Record<string, unknown>;

  // Only handle issue_created events
  const webhookEvent = body.webhookEvent as string;
  if (!webhookEvent?.includes('issue_created') && !webhookEvent?.includes('jira:issue_created')) {
    return res.status(200).json({ message: 'Event ignored' });
  }

  const issue = body.issue as Record<string, unknown> | undefined;
  if (!issue) {
    console.warn('[webhook/jira] Missing issue field in payload');
    return res.status(400).json({ error: 'Missing issue in payload' });
  }

  const fields = issue.fields as Record<string, unknown>;
  const issueId = issue.id as string;
  const issueKey = issue.key as string;

  if (!issueId || !issueKey) {
    return res.status(400).json({ error: 'Missing issue id/key' });
  }

  // Extract fields
  const projectKey = (fields.project as Record<string, unknown>)?.key as string ?? '';
  const summary = (fields.summary as string) ?? '(No summary)';
  const description = fields.description ?? null;
  const issueType = (fields.issuetype as Record<string, unknown>)?.name as string ?? null;
  const priority = (fields.priority as Record<string, unknown>)?.name as string ?? null;
  const labels = (fields.labels as string[]) ?? [];

  const reporter = fields.reporter as Record<string, unknown> | null;
  const reporterEmail = reporter?.emailAddress as string ?? null;
  const reporterName = reporter?.displayName as string ?? null;

  // Organization from custom field
  const orgFieldId = getOrgFieldId();
  const orgField = fields[orgFieldId] as Array<Record<string, unknown>> | null;
  const organization = orgField?.[0] ?? null;
  const organizationId = organization?.id as string ?? null;
  const organizationName = organization?.name as string ?? null;

  // Convert ADF description to plaintext
  let descriptionPlaintext: string | null = null;
  try {
    descriptionPlaintext = description ? adfToPlaintext(description).trim() || null : null;
  } catch (e) {
    console.warn('[webhook/jira] ADF parsing failed, falling back to summary only:', e);
    descriptionPlaintext = null;
  }

  // Look up customer by organization ID
  let customerId: string | null = null;
  if (organizationId) {
    const { data: customer } = await supabase
      .from('customers')
      .select('id')
      .eq('jira_organization_id', organizationId)
      .eq('is_active', true)
      .single();
    customerId = customer?.id ?? null;
  }

  // Check for duplicate (same jira_issue_id already pending/processing)
  const { data: existing } = await supabase
    .from('ticket_jobs')
    .select('id')
    .eq('jira_issue_id', issueId)
    .in('status', ['pending', 'processing'])
    .maybeSingle();

  if (existing) {
    console.log(`[webhook/jira] Duplicate job for ${issueKey} — already queued`);
    return res.status(200).json({ message: 'Already queued' });
  }

  // Generate random delay
  const delayMinutes = randomDelayMinutes();
  const scheduled = scheduledFor(delayMinutes);

  // Insert ticket job
  const { error } = await supabase.from('ticket_jobs').insert({
    jira_issue_id: issueId,
    jira_issue_key: issueKey,
    jira_project_key: projectKey,
    customer_id: customerId,
    summary,
    description: description ? JSON.stringify(description) : null,
    description_plaintext: descriptionPlaintext,
    reporter_email: reporterEmail,
    reporter_name: reporterName,
    organization_id: organizationId,
    organization_name: organizationName,
    issue_type: issueType,
    priority,
    labels,
    status: 'pending',
    scheduled_for: scheduled.toISOString(),
    delay_minutes: delayMinutes,
  });

  if (error) {
    // Unique constraint violation = race condition duplicate — safe to ignore
    if (error.code === '23505') {
      console.log(`[webhook/jira] Race condition duplicate for ${issueKey}`);
      return res.status(200).json({ message: 'Already queued' });
    }
    console.error('[webhook/jira] Failed to insert ticket_job:', error);
    return res.status(500).json({ error: 'Failed to queue ticket' });
  }

  console.log(`[webhook/jira] Queued ${issueKey} — delay: ${delayMinutes}m, scheduled: ${scheduled.toISOString()}`);
  return res.status(200).json({ message: 'Queued', issueKey, delayMinutes });
}
