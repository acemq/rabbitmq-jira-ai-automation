import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase, type Customer, type TicketJob } from '../../lib/supabase.js';

export const maxDuration = 60; // seconds — pipeline needs embed + Claude + Jira calls
import { retrieveRelevantChunks } from '../../lib/knowledge-base.js';
import { generateResponse } from '../../lib/claude-client.js';
import { parseClassification, parseResponseText } from '../../lib/classifier.js';
import { getComments, postComment, addLabel } from '../../lib/jira-client.js';
import { sendAlert, sendSuccessAlert } from '../../lib/alerting.js';

const MAX_RETRY = parseInt(process.env.MAX_RETRY_COUNT ?? '3', 10);
const RETRY_BACKOFF = parseInt(process.env.RETRY_BACKOFF_MINUTES ?? '5', 10);
const JIRA_USER_EMAIL = process.env.JIRA_USER_EMAIL ?? '';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel automatically validates CRON_SECRET for cron routes
  // Additional auth check for safety
  const authHeader = req.headers.authorization;
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Atomically claim the next ready job
  const { data: job, error: claimError } = await supabase.rpc(
    'claim_next_ticket_job'
  ) as { data: TicketJob | null; error: unknown };

  // Fallback if RPC not available: manual claim
  let ticketJob: TicketJob | null = job;
  if (claimError) {
    const claimed = await claimNextJob();
    ticketJob = claimed;
  }

  if (!ticketJob) {
    return res.status(200).json({ message: 'No jobs ready' });
  }

  console.log(`[process-tickets] Processing job ${ticketJob.id} for ${ticketJob.jira_issue_key}`);

  try {
    await processJob(ticketJob);
    return res.status(200).json({ message: 'Processed', issueKey: ticketJob.jira_issue_key });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errName = err instanceof Error ? err.constructor.name : 'Unknown';
    console.error(`[process-tickets] Job ${ticketJob.id} failed [${errName}]:`, message);
    if (err instanceof Error && err.stack) console.error('[process-tickets] Stack:', err.stack.split('\n').slice(0, 5).join(' | '));
    await handleJobFailure(ticketJob, message);
    return res.status(200).json({ message: 'Job failed, retry scheduled' });
  }
}

/**
 * Manual atomic claim when the RPC is not available.
 * Uses optimistic locking via status update.
 */
async function claimNextJob(): Promise<TicketJob | null> {
  const now = new Date().toISOString();

  // Find the next ready job
  const { data: candidates } = await supabase
    .from('ticket_jobs')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_for', now)
    .order('scheduled_for', { ascending: true })
    .limit(1);

  if (!candidates || candidates.length === 0) return null;

  const candidate = candidates[0] as TicketJob;

  // Atomically claim it
  const { data: claimed, error } = await supabase
    .from('ticket_jobs')
    .update({ status: 'processing', processed_at: now })
    .eq('id', candidate.id)
    .eq('status', 'pending') // Only claim if still pending
    .select()
    .single();

  if (error || !claimed) return null;
  return claimed as TicketJob;
}

async function processJob(job: TicketJob): Promise<void> {
  // Load customer context
  let customer: Customer | null = null;
  if (job.customer_id) {
    const { data } = await supabase
      .from('customers')
      .select('*')
      .eq('id', job.customer_id)
      .single();
    customer = data as Customer | null;
  }

  // Build ticket text for embedding
  const ticketText = [job.summary, job.description_plaintext]
    .filter(Boolean)
    .join('\n\n');

  // Retrieve relevant KB chunks
  console.log(`[process-tickets] Embedding ticket text for ${job.jira_issue_key}...`);
  const chunks = await retrieveRelevantChunks(ticketText, job.customer_id);
  console.log(`[process-tickets] Retrieved ${chunks.length} KB chunks for ${job.jira_issue_key}`);

  // Collision detection — skip if Tyler already commented
  console.log(`[process-tickets] Fetching Jira comments for ${job.jira_issue_key}...`);
  const comments = await getComments(job.jira_issue_key);
  const alreadyResponded = comments.some(
    (c) => c.author?.emailAddress === JIRA_USER_EMAIL
  );
  if (alreadyResponded) {
    console.log(`[process-tickets] Tyler already commented on ${job.jira_issue_key} — skipping`);
    await supabase
      .from('ticket_jobs')
      .update({ status: 'completed', completed_at: new Date().toISOString(), error_message: 'Skipped: manual response already present' })
      .eq('id', job.id);
    return;
  }

  // Generate response via Claude
  console.log(`[process-tickets] Calling Claude for ${job.jira_issue_key}...`);
  const { rawOutput, promptTokens, completionTokens, latencyMs } =
    await generateResponse(
      {
        issueKey: job.jira_issue_key,
        issueType: job.issue_type,
        priority: job.priority,
        reporterName: job.reporter_name,
        summary: job.summary,
        descriptionPlaintext: job.description_plaintext,
      },
      customer,
      chunks
    );

  const classification = parseClassification(rawOutput);
  const responseText = parseResponseText(rawOutput);

  console.log(
    `[process-tickets] Classification: ${classification.mode} (${classification.confidence}) — ${classification.reason}`
  );

  // Post comment to Jira
  const { id: commentId } = await postComment(job.jira_issue_key, responseText);

  // Add auto-responded label
  await addLabel(job.jira_issue_key, 'auto-responded').catch((e) =>
    console.warn('[process-tickets] Failed to add label:', e)
  );

  // Mark job completed
  await supabase
    .from('ticket_jobs')
    .update({
      status: 'completed',
      response_mode: classification.mode,
      response_confidence: classification.confidence,
      response_text: responseText,
      jira_comment_id: commentId,
      completed_at: new Date().toISOString(),
    })
    .eq('id', job.id);

  // Write audit log
  await supabase.from('response_log').insert({
    ticket_job_id: job.id,
    claude_model: 'claude-sonnet-4-20250514',
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    api_latency_ms: latencyMs,
    retrieved_chunk_ids: chunks.map((c) => c.chunk_id),
    retrieved_chunk_count: chunks.length,
    customer_context_included: customer !== null,
    response_mode: classification.mode,
    response_confidence: classification.confidence,
    classification_reason: classification.reason,
  });

  console.log(`[process-tickets] Completed ${job.jira_issue_key} — comment ${commentId}`);

  // Success alert
  await sendSuccessAlert(`Response posted for ${job.jira_issue_key}`, {
    issueKey: job.jira_issue_key,
    summary: job.summary,
    mode: classification.mode,
    confidence: classification.confidence,
    reason: classification.reason,
    kbChunksUsed: chunks.length,
    customerContext: customer ? customer.display_name : 'unknown',
    promptTokens,
    completionTokens,
    latencyMs,
    jiraCommentId: commentId,
  });
}

async function handleJobFailure(job: TicketJob, errorMessage: string): Promise<void> {
  const newRetryCount = (job.retry_count ?? 0) + 1;

  if (newRetryCount >= MAX_RETRY) {
    // Permanently failed
    await supabase
      .from('ticket_jobs')
      .update({
        status: 'failed',
        retry_count: newRetryCount,
        error_message: errorMessage,
      })
      .eq('id', job.id);

    await sendAlert(`Ticket job permanently failed after ${MAX_RETRY} retries`, {
      jobId: job.id,
      issueKey: job.jira_issue_key,
      error: errorMessage,
    });
  } else {
    // Schedule retry with backoff
    const retryAt = new Date();
    retryAt.setMinutes(retryAt.getMinutes() + RETRY_BACKOFF);

    await supabase
      .from('ticket_jobs')
      .update({
        status: 'pending',
        retry_count: newRetryCount,
        error_message: errorMessage,
        scheduled_for: retryAt.toISOString(),
      })
      .eq('id', job.id);

    console.log(`[process-tickets] Scheduled retry ${newRetryCount}/${MAX_RETRY} for ${job.jira_issue_key} at ${retryAt.toISOString()}`);
  }
}
