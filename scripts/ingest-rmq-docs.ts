/**
 * RabbitMQ official documentation scraper.
 * Crawls ~40 key pages from rabbitmq.com/docs, converts to text,
 * chunks by section, embeds, and stores as global KB.
 *
 * Run via: npm run ingest-rmq-docs
 * Also called by: api/cron/ingest-rmq-docs.ts
 */

import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { supabase } from '../lib/supabase.js';
import { chunkText, embedBatch, hashContent } from '../lib/embeddings.js';
import { upsertDocument, insertChunks } from '../lib/knowledge-base.js';

const DOCS_PAGES = [
  'https://www.rabbitmq.com/docs/clustering',
  'https://www.rabbitmq.com/docs/quorum-queues',
  'https://www.rabbitmq.com/docs/classic-queues',
  'https://www.rabbitmq.com/docs/streams',
  'https://www.rabbitmq.com/docs/publishers',
  'https://www.rabbitmq.com/docs/consumers',
  'https://www.rabbitmq.com/docs/confirms',
  'https://www.rabbitmq.com/docs/reliability',
  'https://www.rabbitmq.com/docs/monitoring',
  'https://www.rabbitmq.com/docs/management',
  'https://www.rabbitmq.com/docs/networking',
  'https://www.rabbitmq.com/docs/ssl',
  'https://www.rabbitmq.com/docs/access-control',
  'https://www.rabbitmq.com/docs/authentication',
  'https://www.rabbitmq.com/docs/ldap',
  'https://www.rabbitmq.com/docs/vhosts',
  'https://www.rabbitmq.com/docs/parameters',
  'https://www.rabbitmq.com/docs/configure',
  'https://www.rabbitmq.com/docs/rabbitmq-env-conf',
  'https://www.rabbitmq.com/docs/runtime',
  'https://www.rabbitmq.com/docs/memory-use',
  'https://www.rabbitmq.com/docs/disk-alarms',
  'https://www.rabbitmq.com/docs/flow-control',
  'https://www.rabbitmq.com/docs/lazy-queues',
  'https://www.rabbitmq.com/docs/priority',
  'https://www.rabbitmq.com/docs/dlx',
  'https://www.rabbitmq.com/docs/ttl',
  'https://www.rabbitmq.com/docs/queues',
  'https://www.rabbitmq.com/docs/exchanges',
  'https://www.rabbitmq.com/docs/bindings',
  'https://www.rabbitmq.com/docs/connections',
  'https://www.rabbitmq.com/docs/channels',
  'https://www.rabbitmq.com/docs/shovel',
  'https://www.rabbitmq.com/docs/federation',
  'https://www.rabbitmq.com/docs/plugins',
  'https://www.rabbitmq.com/docs/cli',
  'https://www.rabbitmq.com/docs/man/rabbitmqctl.8',
  'https://www.rabbitmq.com/docs/upgrade',
  'https://www.rabbitmq.com/docs/production-checklist',
  'https://www.rabbitmq.com/docs/troubleshooting',
];

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

// Keep code blocks intact
turndown.addRule('pre', {
  filter: 'pre',
  replacement: (_content: string, node: unknown) => {
    const el = node as { textContent: string | null };
    const code = el.textContent ?? '';
    return `\n\`\`\`\n${code}\n\`\`\`\n`;
  },
});

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'RabbitMQ-Support-KB-Scraper/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn(`[ingest-rmq-docs] HTTP ${res.status} for ${url}`);
      return null;
    }
    return res.text();
  } catch (e) {
    console.warn(`[ingest-rmq-docs] Fetch failed for ${url}:`, e);
    return null;
  }
}

function extractMainContent(html: string, url: string): string {
  const $ = cheerio.load(html);

  // Remove navigation, headers, footers, sidebars
  $('nav, header, footer, .sidebar, .nav, .navigation, .toc, script, style').remove();

  // Try common main content selectors
  const main =
    $('main').first() ||
    $('article').first() ||
    $('.content').first() ||
    $('body');

  const contentHtml = main.html() ?? '';
  const markdown = turndown.turndown(contentHtml);

  // Prepend URL as context
  return `# Source: ${url}\n\n${markdown}`.trim();
}

/**
 * Section-aware chunking: split on H2/H3 headings, keeping code blocks intact.
 */
function chunkBySection(text: string): string[] {
  // Split on H2/H3 markdown headings
  const sections = text.split(/(?=\n#{1,3} )/);
  const chunks: string[] = [];

  for (const section of sections) {
    if (section.trim().length < 50) continue;

    // If section is small enough, keep as-is
    if (section.length <= 3200) {
      chunks.push(section.trim());
    } else {
      // Split large sections further, but don't break code blocks
      const subChunks = chunkText(section, 3000, 200);
      chunks.push(...subChunks);
    }
  }

  return chunks.filter((c) => c.trim().length > 0);
}

export async function ingestRmqDocs(): Promise<{
  processed: number;
  skipped: number;
  failed: number;
  chunksCreated: number;
}> {
  const logEntry = await supabase
    .from('ingestion_log')
    .insert({ source_type: 'rmq_official_docs', status: 'running' })
    .select('id')
    .single();
  const logId = logEntry.data?.id as string;

  let processed = 0, skipped = 0, failed = 0, chunksCreated = 0;

  try {
    for (const url of DOCS_PAGES) {
      try {
        console.log(`[ingest-rmq-docs] Fetching: ${url}`);
        const html = await fetchPage(url);
        if (!html) { failed++; continue; }

        const text = extractMainContent(html, url);
        if (!text || text.length < 100) { skipped++; continue; }

        const contentHash = await hashContent(text);
        const pageTitle = url.split('/').pop() ?? url;

        const { id: docId, skipped: wasSkipped } = await upsertDocument({
          customer_id: null,
          source_type: 'rmq_official_docs',
          source_id: url,
          title: `RabbitMQ Docs: ${pageTitle}`,
          content_hash: contentHash,
          metadata: { url },
        });

        if (wasSkipped) {
          console.log(`[ingest-rmq-docs] Unchanged: ${url}`);
          skipped++;
          continue;
        }

        const chunks = chunkBySection(text);
        const embeddings = await embedBatch(chunks);

        await insertChunks(
          docId,
          null, // global — no customer
          chunks.map((content, i) => ({
            chunk_index: i,
            content,
            embedding: embeddings[i],
            token_count: Math.ceil(content.length / 4),
          }))
        );

        chunksCreated += chunks.length;
        processed++;
        console.log(`[ingest-rmq-docs] ✓ ${pageTitle} — ${chunks.length} chunks`);

        // Polite delay between requests
        await new Promise((r) => setTimeout(r, 500));
      } catch (e) {
        console.error(`[ingest-rmq-docs] Failed ${url}:`, e);
        failed++;
      }
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
const isMain = process.argv[1]?.endsWith('ingest-rmq-docs.ts');
if (isMain) {
  ingestRmqDocs()
    .then((r) => {
      console.log('[ingest-rmq-docs] Done:', r);
      process.exit(0);
    })
    .catch((e) => {
      console.error('[ingest-rmq-docs] Fatal:', e);
      process.exit(1);
    });
}
