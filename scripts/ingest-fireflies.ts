/**
 * Fireflies transcript ingestion pipeline.
 * Fetches transcripts via Fireflies GraphQL API, matches to customers by title,
 * chunks by speaker turns, embeds, and stores in Supabase.
 *
 * Customer attribution uses the same title-matching rules as the Drive organizer
 * script, mapped to display_names in the customers table.
 *
 * Run via: npm run ingest-fireflies
 * Also called by: api/cron/ingest-fireflies.ts
 */

import { supabase } from '../lib/supabase.js';
import { embedBatch, chunkText, hashContent } from '../lib/embeddings.js';
import { upsertDocument, insertChunks } from '../lib/knowledge-base.js';
import { extractEnvironmentMetadata } from '../lib/claude-client.js';

if (!process.env.FIREFLIES_API_KEY) throw new Error('FIREFLIES_API_KEY is required');

const FIREFLIES_API = 'https://api.fireflies.ai/graphql';
const API_KEY = process.env.FIREFLIES_API_KEY;

// ---------------------------------------------------------------------------
// Fireflies GraphQL types
// ---------------------------------------------------------------------------

interface FirefliesTranscript {
  id: string;
  title: string;
  date: number; // epoch ms
  summary?: { overview?: string };
  sentences?: Array<{ speaker_name: string; raw_text: string }>;
  participants?: string[]; // array of email strings
}

// ---------------------------------------------------------------------------
// Fireflies API helpers
// ---------------------------------------------------------------------------

async function firefliesQuery<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(FIREFLIES_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Fireflies API error ${res.status}: ${await res.text()}`);
  }

  const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Fireflies GraphQL error: ${json.errors.map(e => e.message).join(', ')}`);
  }

  return json.data as T;
}

async function fetchRecentTranscripts(limit = 50, skip = 0): Promise<FirefliesTranscript[]> {
  const data = await firefliesQuery<{ transcripts: FirefliesTranscript[] }>(`
    query GetTranscripts($limit: Int, $skip: Int) {
      transcripts(limit: $limit, skip: $skip) {
        id
        title
        date
        participants
        summary { overview }
      }
    }
  `, { limit, skip });

  return data.transcripts ?? [];
}

async function fetchTranscriptDetail(id: string): Promise<FirefliesTranscript | null> {
  try {
    const data = await firefliesQuery<{ transcript: FirefliesTranscript }>(`
      query GetTranscript($id: String!) {
        transcript(id: $id) {
          id
          title
          date
          participants
          summary { overview }
          sentences { speaker_name raw_text }
        }
      }
    `, { id });

    return data.transcript ?? null;
  } catch (e) {
    console.warn(`[ingest-fireflies] Could not fetch detail for ${id}:`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Title-based customer routing
// Mirrors the rules in the Google Drive organizer Apps Script.
// Maps meeting title substrings → customer display_name in Supabase.
// null = internal/coaching/other (store without customer_id)
// ---------------------------------------------------------------------------

const TITLE_RULES: Array<{ match: string; customer: string | null }> = [
  // ── Delivery / active support customers ──────────────────────────────────
  { match: 'pagonxt',          customer: 'PagoNXT' },
  { match: 'pargo',            customer: 'PagoNXT' },
  { match: 'jeses - pago',     customer: 'PagoNXT' },
  { match: 'adeptia',          customer: 'Adeptia' },
  { match: 'mitek',            customer: 'MiTek' },
  { match: 'playtech',         customer: 'Playtech' },
  { match: 'lucidya',          customer: 'Lucidya' },
  { match: 'fres',             customer: 'First Rate' },
  { match: 'mark evans',       customer: 'First Rate' },
  { match: 'siemens',          customer: 'Siemens' },
  { match: 'daimler',          customer: 'Daimler Truck (DTNA)' },
  { match: 'drw holdings',     customer: 'DRW Holdings' },
  { match: 'drwholdings',      customer: 'DRW Holdings' },
  { match: 'acemq-drw',        customer: 'DRW Holdings' },
  { match: 'scott-felipe drw', customer: 'DRW Holdings' },
  { match: 'adb safegate',     customer: 'ADB Safegate' },
  { match: 'adbsafegate',      customer: 'ADB Safegate' },
  { match: 'acemq-adb',        customer: 'ADB Safegate' },
  { match: 'sculptor',         customer: 'Sculptor' },
  { match: 'tastytrade',       customer: 'tastytrade' },
  { match: 'kurt wagner',      customer: 'tastytrade' },
  { match: 'flvs',             customer: 'FLVS' },
  { match: 'rolando',          customer: 'FLVS' },
  { match: 'western midstream', customer: 'Western Midstream' },
  { match: 'wes-acemq',        customer: 'Western Midstream' },
  { match: 'oocl',             customer: 'OOCL' },
  { match: 'tulip',            customer: 'Tulip' },
  { match: 'candescent',       customer: 'Candescent' },
  { match: 'td synnex',        customer: 'TD Synnex' },
  { match: 'adp - engagement', customer: 'ADP' },
  { match: 'acemq-adp',        customer: 'ADP' },
  { match: 'atlas',            customer: 'Atlas' },

  // ── Sales prospects (in Supabase customers) ───────────────────────────────
  { match: 'woodmen',          customer: 'Woodmen' },
  { match: 'shaw systems',     customer: 'Shaw Systems' },
  { match: 'acemq shaw',       customer: 'Shaw Systems' },
  { match: 'shift4',           customer: 'Shift4' },
  { match: 'gmt2024',          customer: 'Shift4' },
  { match: 'hexagon',          customer: 'Hexagon' },
  { match: 'pindrop',          customer: 'Pindrop' },
  { match: 'acemq-fcti',       customer: 'FCTI' },
  { match: 'acemq-abim',       customer: 'ABIM' },
  { match: 'acemq - abim',     customer: 'ABIM' },
  { match: 'lucidya',          customer: 'Lucidya' },

  // ── All internal / coaching / HR / partner → no customer ─────────────────
  { match: 'morning sync',     customer: null },
  { match: 'morning 3-',       customer: null },
  { match: 'acemq sync',       customer: null },
  { match: 'ai strategy',      customer: null },
  { match: 'sales sync',       customer: null },
  { match: 'sdr ',             customer: null },
  { match: 'sdr-',             customer: null },
  { match: 'coaching',         customer: null },
  { match: 'interview',        customer: null },
  { match: 'randall/tyler',    customer: null },
  { match: 'randall-tyler',    customer: null },
  { match: 'randall and tyler', customer: null },
  { match: 'ace8',             customer: null },
  { match: 'sussi',            customer: null },
  { match: 'suma',             customer: null },
  { match: 'duczer',           customer: null },
  { match: 'broadcom',         customer: null },
  { match: 'carahsoft',        customer: null },
  { match: 'webinar',          customer: null },
  { match: 'liam',             customer: null },
  { match: 'swiftree',         customer: null },
];

function resolveCustomerName(title: string): string | null | undefined {
  const lower = title.toLowerCase();
  for (const rule of TITLE_RULES) {
    if (lower.includes(rule.match.toLowerCase())) {
      return rule.customer; // null = internal (known), undefined = unmatched
    }
  }
  return undefined; // unmatched — will try email fallback
}

// ---------------------------------------------------------------------------
// Customer lookup in Supabase
// ---------------------------------------------------------------------------

let customerCache: Array<{ id: string; display_name: string; fireflies_contact_email: string | null }> | null = null;

async function loadCustomers() {
  if (customerCache) return customerCache;
  const { data } = await supabase
    .from('customers')
    .select('id, display_name, fireflies_contact_email')
    .eq('is_active', true);
  customerCache = (data ?? []) as Array<{ id: string; display_name: string; fireflies_contact_email: string | null }>;
  return customerCache!;
}

async function findCustomerByName(name: string): Promise<string | null> {
  const customers = await loadCustomers();
  const lower = name.toLowerCase();
  const match = customers.find(
    c => c.display_name.toLowerCase().includes(lower) || lower.includes(c.display_name.toLowerCase())
  );
  return match?.id ?? null;
}

async function findCustomerByEmail(emails: string[]): Promise<string | null> {
  if (emails.length === 0) return null;
  const lowerEmails = emails.map(e => e.toLowerCase());
  const customers = await loadCustomers();
  for (const c of customers) {
    if (c.fireflies_contact_email && lowerEmails.includes(c.fireflies_contact_email.toLowerCase())) {
      return c.id;
    }
  }
  return null;
}

async function resolveCustomerId(title: string, participantEmails: string[]): Promise<string | null> {
  const nameHint = resolveCustomerName(title);

  if (nameHint === null) return null;           // internal meeting, known
  if (nameHint !== undefined) {
    const id = await findCustomerByName(nameHint);
    if (id) return id;
  }

  // Fallback: try matching by attendee email domain
  return findCustomerByEmail(participantEmails);
}

// ---------------------------------------------------------------------------
// Transcript text formatting
// ---------------------------------------------------------------------------

function transcriptToText(transcript: FirefliesTranscript): string {
  const lines: string[] = [];

  if (transcript.summary?.overview) {
    lines.push(`Summary: ${transcript.summary.overview}\n`);
  }

  if (transcript.sentences && transcript.sentences.length > 0) {
    let currentSpeaker = '';
    for (const s of transcript.sentences) {
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

function chunkTranscript(text: string): string[] {
  const speakerBlocks = text.split(/\n(?=[A-Z][^:]+:)/);
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

  if (chunks.length === 0) return chunkText(text);
  return chunks.filter((c) => c.length > 50);
}

// ---------------------------------------------------------------------------
// Main ingestion
// ---------------------------------------------------------------------------

export async function ingestFireflies(daysBack = 90): Promise<{
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
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    let skip = 0;
    const pageSize = 50;
    let hasMore = true;

    while (hasMore) {
      const transcripts = await fetchRecentTranscripts(pageSize, skip);
      if (transcripts.length === 0) break;

      // Filter by date client-side (API fromDate param unreliable on older plans)
      const recent = transcripts.filter(t => {
        if (!t.date) return true;
        return new Date(t.date).toISOString().split('T')[0] >= since;
      });

      console.log(`[ingest-fireflies] Page skip=${skip}: ${transcripts.length} total, ${recent.length} within ${daysBack}d`);

      for (const t of recent) {
        try {
          const detail = await fetchTranscriptDetail(t.id) ?? t;
          const emails = (detail.participants ?? []).map(e => e.toLowerCase());
          const customerId = await resolveCustomerId(detail.title ?? t.title, emails);

          const text = transcriptToText(detail);
          if (!text || text.length < 100) { skipped++; continue; }

          const contentHash = await hashContent(text);
          const { id: docId, skipped: wasSkipped } = await upsertDocument({
            customer_id: customerId,
            source_type: 'fireflies_transcript',
            source_id: t.id,
            title: t.title || `Transcript ${new Date(t.date).toLocaleDateString()}`,
            content_hash: contentHash,
            metadata: {
              date: t.date,
              participants: detail.participants ?? [],  // string[]
            },
          });

          if (wasSkipped) { skipped++; continue; }

          const chunks = chunkTranscript(text);

          // Extract environment metadata from customer calls
          if (customerId && chunks.length > 0) {
            const sampleText = chunks.slice(0, 3).join('\n\n');
            try {
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
              }
            } catch {
              // env extraction is best-effort
            }
          }

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
          console.log(`[ingest-fireflies] ✓ "${t.title}" → customer=${customerId ?? 'none'} (${chunks.length} chunks)`);
        } catch (e) {
          console.error(`[ingest-fireflies] Failed ${t.id} "${t.title}":`, e);
          failed++;
        }
      }

      // Stop paginating if all remaining transcripts are older than our window
      const oldestOnPage = transcripts[transcripts.length - 1];
      if (oldestOnPage?.date && new Date(oldestOnPage.date).toISOString().split('T')[0] < since) {
        hasMore = false;
      } else {
        hasMore = transcripts.length === pageSize;
        skip += pageSize;
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
  // Default: 365 days back for initial full ingest; cron uses 90
  const daysBack = parseInt(process.env.DAYS_BACK ?? '365', 10);
  ingestFireflies(daysBack)
    .then((r) => {
      console.log('[ingest-fireflies] Done:', r);
      process.exit(0);
    })
    .catch((e) => {
      console.error('[ingest-fireflies] Fatal:', e);
      process.exit(1);
    });
}
