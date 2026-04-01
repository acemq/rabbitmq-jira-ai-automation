/**
 * Fireflies transcript ingestion pipeline.
 * Fetches recent transcripts via Fireflies MCP, matches to customers,
 * chunks by topic/Q&A boundaries, embeds, and stores in Supabase.
 *
 * Run via: npm run ingest-fireflies
 * Also called by: api/cron/ingest-fireflies.ts
 */

import { supabase } from '../lib/supabase.js';
import { embed, embedBatch, chunkText, hashContent } from '../lib/embeddings.js';
import { upsertDocument, insertChunks } from '../lib/knowledge-base.js';
import { extractEnvironmentMetadata } from '../lib/claude-client.js';

// ---------------------------------------------------------------------------
// Fireflies MCP client — thin wrapper around the MCP tool responses.
// In production these are called via the Fireflies MCP server.
// For now, stubs are provided so the pipeline compiles and runs;
// replace with actual MCP SDK calls when wiring up the MCP server.
// ---------------------------------------------------------------------------

interface FirefliesTranscript {
  id: string;
  title: string;
  date: number; // epoch ms
  summary?: { overview?: string };
  sentences?: Array<{ speaker_name: string; raw_text: string }>;
  participants?: Array<{ email: string; name: string }>;
}

async function fetchRecentTranscripts(): Promise<FirefliesTranscript[]> {
  // TODO: Replace with actual Fireflies MCP call:
  // const result = await mcpClient.call('fireflies_get_transcripts', { limit: 50 });
  console.log('[ingest-fireflies] NOTE: Fireflies MCP not yet wired — using stub');
  return [];
}

async function fetchTranscriptDetail(id: string): Promise<FirefliesTranscript | null> {
  // TODO: Replace with actual Fireflies MCP call:
  // const result = await mcpClient.call('fireflies_get_transcript', { id });
  console.log(`[ingest-fireflies] NOTE: fetchTranscriptDetail stub for ${id}`);
  return null;
}

// ---------------------------------------------------------------------------
// Clean and structure transcript text
// ---------------------------------------------------------------------------

function transcriptToText(transcript: FirefliesTranscript): string {
  const lines: string[] = [];

  if (transcript.summary?.overview) {
    lines.push(`Summary: ${transcript.summary.overview}\n`);
  }

  if (transcript.sentences && transcript.sentences.length > 0) {
    let currentSpeaker = '';
    for (const s of transcript.sentences) {
      // Remove filler words
      const clean = s.raw_text
        .replace(/\b(um|uh|like|you know|sort of|kind of)\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (!clean) continue;

      if (s.speaker_name !== currentSpeaker) {
        currentSpeaker = s.speaker_name;
        lines.push(`\n${currentSpeaker}: ${clean}`);
      } else {
        lines.push(clean);
      }
    }
  }

  return lines.join('\n').trim();
}

/**
 * Topic-aware chunking: split on speaker turns and natural topic boundaries.
 * Keeps Q&A pairs together by not splitting mid-exchange.
 */
function chunkTranscript(text: string): string[] {
  // First try topic-based splits (double newlines between speakers)
  const speakerBlocks = text.split(/\n(?=[A-Z][^:]+:)/);

  // Group into chunks of ~3000 chars (matching embeddings.ts default)
  const chunks: string[] = [];
  let current = '';

  for (const block of speakerBlocks) {
    if (current.length + block.length <= 3000) {
      current = current ? `${current}\n${block}` : block;
    } else {
      if (current) chunks.push(current.trim());
      current = block;
    }
  }
  if (current) chunks.push(current.trim());

  // Fall back to generic chunking if transcript is very short
  if (chunks.length === 0) {
    return chunkText(text);
  }

  return chunks.filter((c) => c.length > 50);
}

// ---------------------------------------------------------------------------
// Match transcript to customer by attendee email
// ---------------------------------------------------------------------------

async function findCustomerByEmail(emails: string[]): Promise<string | null> {
  if (emails.length === 0) return null;

  const { data } = await supabase
    .from('customers')
    .select('id, fireflies_contact_email')
    .eq('is_active', true);

  if (!data) return null;

  for (const customer of data) {
    const contactEmail = customer.fireflies_contact_email as string | null;
    if (contactEmail && emails.includes(contactEmail.toLowerCase())) {
      return customer.id as string;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main ingestion logic
// ---------------------------------------------------------------------------

export async function ingestFireflies(): Promise<{
  processed: number;
  skipped: number;
  failed: number;
  chunksCreated: number;
}> {
  const logEntry = await supabase
    .from('ingestion_log')
    .insert({ source_type: 'fireflies_transcript', status: 'running' })
    .select('id')
    .single();
  const logId = logEntry.data?.id as string;

  let processed = 0, skipped = 0, failed = 0, chunksCreated = 0;

  try {
    const transcripts = await fetchRecentTranscripts();
    console.log(`[ingest-fireflies] Found ${transcripts.length} transcripts`);

    for (const t of transcripts) {
      try {
        const detail = await fetchTranscriptDetail(t.id) ?? t;
        const attendeeEmails = (detail.participants ?? []).map((p) =>
          p.email.toLowerCase()
        );
        const customerId = await findCustomerByEmail(attendeeEmails);

        const text = transcriptToText(detail);
        if (!text) { skipped++; continue; }

        const contentHash = await hashContent(text);
        const { id: docId, skipped: wasSkipped } = await upsertDocument({
          customer_id: customerId,
          source_type: 'fireflies_transcript',
          source_id: t.id,
          title: t.title || `Transcript ${new Date(t.date).toLocaleDateString()}`,
          content_hash: contentHash,
          metadata: {
            date: t.date,
            participants: detail.participants ?? [],
          },
        });

        if (wasSkipped) { skipped++; continue; }

        // Chunk transcript
        const chunks = chunkTranscript(text);

        // Extract environment metadata if customer found
        if (customerId && chunks.length > 0) {
          const sampleText = chunks.slice(0, 3).join('\n\n');
          const envData = await extractEnvironmentMetadata(sampleText);
          const updates: Record<string, unknown> = {};
          if (envData.rabbitmq_version) updates.rabbitmq_version = envData.rabbitmq_version;
          if (envData.erlang_version) updates.erlang_version = envData.erlang_version;
          if (envData.cluster_size) updates.cluster_size = envData.cluster_size;
          if (envData.deployment_type) updates.deployment_type = envData.deployment_type;
          if (envData.os_info) updates.os_info = envData.os_info;
          if (envData.cloud_provider) updates.cloud_provider = envData.cloud_provider;
          if (envData.use_case_summary) updates.use_case_summary = envData.use_case_summary;
          if (envData.environment_notes) updates.environment_notes = envData.environment_notes;

          if (Object.keys(updates).length > 0) {
            updates.updated_at = new Date().toISOString();
            await supabase.from('customers').update(updates).eq('id', customerId);
            console.log(`[ingest-fireflies] Updated customer ${customerId} with env data`);
          }
        }

        // Embed and store chunks
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
        console.log(`[ingest-fireflies] ✓ ${t.title} — ${chunks.length} chunks`);
      } catch (e) {
        console.error(`[ingest-fireflies] Failed transcript ${t.id}:`, e);
        failed++;
      }
    }
  } finally {
    await supabase
      .from('ingestion_log')
      .update({
        status: failed > 0 && processed === 0 ? 'failed' : 'completed',
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
const isMain = process.argv[1]?.endsWith('ingest-fireflies.ts');
if (isMain) {
  ingestFireflies()
    .then((r) => {
      console.log('[ingest-fireflies] Done:', r);
      process.exit(0);
    })
    .catch((e) => {
      console.error('[ingest-fireflies] Fatal:', e);
      process.exit(1);
    });
}
