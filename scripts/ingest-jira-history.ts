/**
 * Historical Jira ticket ingestion pipeline.
 * Fetches resolved tickets, structures as Q&A pairs, embeds, stores in Supabase.
 *
 * Run via: npm run ingest-jira-history
 * Also called by: api/cron/ingest-jira-history.ts
 */

import { supabase } from '../lib/supabase.js';
import { embedBatch, hashContent } from '../lib/embeddings.js';
import { upsertDocument, insertChunks } from '../lib/knowledge-base.js';
import { getResolvedTickets, getOrgFieldId } from '../lib/jira-client.js';
import { adfToPlaintext } from '../lib/adf-to-plaintext.js';

const PROJECT_KEY = process.env.JIRA_PROJECT_KEY ?? 'SUP';

interface JiraComment {
  author: { emailAddress: string; displayName: string };
  body: unknown;
  created: string;
}

interface JiraIssue {
  id: string;
  key: string;
  fields: Record<string, unknown>;
}

function extractPlaintext(field: unknown): string {
  if (!field) return '';
  if (typeof field === 'string') return field;
  try {
    return adfToPlaintext(field).trim();
  } catch {
    return '';
  }
}

function formatTicketAsQA(issue: JiraIssue): string {
  const fields = issue.fields;
  const summary = fields.summary as string ?? '';
  const description = extractPlaintext(fields.description);
  const comments = (fields.comment as { comments: JiraComment[] })?.comments ?? [];

  const tylerEmail = process.env.JIRA_USER_EMAIL ?? '';
  const lines: string[] = [];

  lines.push(`## Ticket: ${issue.key}`);
  lines.push(`**Subject:** ${summary}`);

  if (description) {
    lines.push(`\n**Customer Issue:**\n${description}`);
  }

  // Extract Tyler's responses as the "answer" content
  const tylerComments = comments.filter(
    (c) => c.author?.emailAddress === tylerEmail
  );

  if (tylerComments.length > 0) {
    lines.push('\n**Resolution / Response:**');
    for (const comment of tylerComments) {
      const text = extractPlaintext(comment.body);
      if (text) lines.push(text);
    }
  }

  // Resolution field
  const resolution = fields.resolution as Record<string, unknown> | null;
  if (resolution?.name) {
    lines.push(`\n**Resolution:** ${resolution.name}`);
  }

  return lines.join('\n').trim();
}

async function findCustomerByOrgId(orgId: string | null): Promise<string | null> {
  if (!orgId) return null;
  const { data } = await supabase
    .from('customers')
    .select('id')
    .eq('jira_organization_id', orgId)
    .eq('is_active', true)
    .single();
  return data?.id as string ?? null;
}

export async function ingestJiraHistory(): Promise<{
  processed: number;
  skipped: number;
  failed: number;
  chunksCreated: number;
}> {
  const logEntry = await supabase
    .from('ingestion_log')
    .insert({ source_type: 'jira_historical', status: 'running' })
    .select('id')
    .single();
  const logId = logEntry.data?.id as string;

  let processed = 0, skipped = 0, failed = 0, chunksCreated = 0;
  const orgFieldId = getOrgFieldId();

  try {
    let startAt = 0;
    const maxResults = 50;
    let hasMore = true;

    while (hasMore) {
      const { issues, total } = await getResolvedTickets(PROJECT_KEY, 365, startAt, maxResults);

      for (const rawIssue of issues) {
        const issue = rawIssue as JiraIssue;
        try {
          const fields = issue.fields;
          const orgField = fields[orgFieldId] as Array<Record<string, unknown>> | null;
          const orgId = orgField?.[0]?.id as string ?? null;
          const customerId = await findCustomerByOrgId(orgId);

          const text = formatTicketAsQA(issue);
          if (!text || text.length < 50) { skipped++; continue; }

          const contentHash = await hashContent(text);
          const { id: docId, skipped: wasSkipped } = await upsertDocument({
            customer_id: customerId,
            source_type: 'jira_historical',
            source_id: issue.id,
            title: `${issue.key}: ${fields.summary as string ?? ''}`,
            content_hash: contentHash,
            metadata: { issueKey: issue.key, orgId },
          });

          if (wasSkipped) { skipped++; continue; }

          // Each ticket is typically one chunk
          const chunks = [text];
          const embeddings = await embedBatch(chunks);

          await insertChunks(
            docId,
            customerId,
            chunks.map((content, i) => ({
              chunk_index: i,
              content,
              embedding: embeddings[i],
              token_count: Math.ceil(content.length / 4),
            }))
          );

          chunksCreated += chunks.length;
          processed++;
        } catch (e) {
          console.error(`[ingest-jira-history] Failed issue ${(rawIssue as JiraIssue).key}:`, e);
          failed++;
        }
      }

      startAt += issues.length;
      hasMore = startAt < total && issues.length === maxResults;
      console.log(`[ingest-jira-history] Progress: ${startAt}/${total}`);
    }
  } finally {
    await supabase
      .from('ingestion_log')
      .update({
        status: 'completed',
        documents_processed: processed,
        documents_skipped: skipped,
        documents_failed: failed,
        chunks_created: chunksCreated,
        completed_at: new Date().toISOString(),
      })
      .eq('id', logId);
  }

  return { processed, skipped, failed, chunksCreated };
}

// Run as script
const isMain = process.argv[1]?.endsWith('ingest-jira-history.ts');
if (isMain) {
  ingestJiraHistory()
    .then((r) => {
      console.log('[ingest-jira-history] Done:', r);
      process.exit(0);
    })
    .catch((e) => {
      console.error('[ingest-jira-history] Fatal:', e);
      process.exit(1);
    });
}
