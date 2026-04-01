/**
 * Manual file ingestion CLI.
 * For documents not accessible via MCPs.
 *
 * Usage:
 *   npm run ingest-files -- --file ./path/to/file.txt --customer "Acme Corp" --type manual_upload
 *   npm run ingest-files -- --dir ./path/to/docs/ --customer "Acme Corp" --type internal_runbook
 *
 * Options:
 *   --file <path>       Single file to ingest
 *   --dir <path>        Directory of files to ingest
 *   --customer <name>   Customer display name (optional — global if omitted)
 *   --type <type>       source_type value (default: manual_upload)
 */

import { createRequire } from 'module';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import { supabase } from '../lib/supabase.js';
import { chunkText, embedBatch, hashContent } from '../lib/embeddings.js';
import { upsertDocument, insertChunks } from '../lib/knowledge-base.js';

const require = createRequire(import.meta.url);

// Parse CLI args
function parseArgs(): { file?: string; dir?: string; customer?: string; type: string } {
  const args = process.argv.slice(2);
  const result: { file?: string; dir?: string; customer?: string; type: string } = {
    type: 'manual_upload',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file') result.file = args[++i];
    else if (args[i] === '--dir') result.dir = args[++i];
    else if (args[i] === '--customer') result.customer = args[++i];
    else if (args[i] === '--type') result.type = args[++i];
  }

  return result;
}

async function extractText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;
    const buf = readFileSync(filePath);
    const parsed = await pdfParse(buf);
    return parsed.text;
  }

  if (ext === '.docx') {
    const mammoth = require('mammoth') as {
      extractRawText: (opts: { path: string }) => Promise<{ value: string }>;
    };
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  // txt, md, etc.
  return readFileSync(filePath, 'utf-8');
}

async function ingestFile(
  filePath: string,
  customerId: string | null,
  sourceType: string
): Promise<{ skipped: boolean; chunks: number }> {
  const text = await extractText(filePath);
  if (!text || text.trim().length < 50) {
    console.warn(`[ingest-files] Skipping empty/tiny file: ${filePath}`);
    return { skipped: true, chunks: 0 };
  }

  const contentHash = await hashContent(text);
  const title = basename(filePath);

  const { id: docId, skipped } = await upsertDocument({
    customer_id: customerId,
    source_type: sourceType,
    source_id: filePath,
    title,
    content_hash: contentHash,
  });

  if (skipped) {
    console.log(`[ingest-files] Unchanged: ${title}`);
    return { skipped: true, chunks: 0 };
  }

  const chunks = chunkText(text);
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

  console.log(`[ingest-files] ✓ ${title} — ${chunks.length} chunks`);
  return { skipped: false, chunks: chunks.length };
}

async function findCustomerId(customerName: string): Promise<string | null> {
  const { data } = await supabase
    .from('customers')
    .select('id, display_name')
    .ilike('display_name', customerName)
    .single();

  if (!data) {
    console.warn(`[ingest-files] Customer not found: "${customerName}"`);
    return null;
  }

  return data.id as string;
}

async function main() {
  const args = parseArgs();

  if (!args.file && !args.dir) {
    console.error('Usage: --file <path> | --dir <path> [--customer <name>] [--type <type>]');
    process.exit(1);
  }

  const customerId = args.customer ? await findCustomerId(args.customer) : null;
  if (args.customer && !customerId) {
    console.error(`Customer "${args.customer}" not found in database. Run bootstrap-customers first.`);
    process.exit(1);
  }

  const filePaths: string[] = [];

  if (args.file) {
    filePaths.push(args.file);
  } else if (args.dir) {
    const entries = readdirSync(args.dir);
    for (const entry of entries) {
      const full = join(args.dir, entry);
      if (statSync(full).isFile()) {
        const ext = extname(entry).toLowerCase();
        if (['.txt', '.md', '.pdf', '.docx'].includes(ext)) {
          filePaths.push(full);
        }
      }
    }
  }

  console.log(`Processing ${filePaths.length} file(s)...`);
  let processed = 0, skipped = 0, totalChunks = 0;

  for (const fp of filePaths) {
    const { skipped: wasSkipped, chunks } = await ingestFile(fp, customerId, args.type);
    if (wasSkipped) skipped++;
    else { processed++; totalChunks += chunks; }
  }

  console.log(`\nDone: ${processed} processed, ${skipped} skipped, ${totalChunks} total chunks`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
