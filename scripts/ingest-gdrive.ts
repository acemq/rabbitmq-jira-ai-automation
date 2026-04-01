/**
 * Google Drive document ingestion pipeline.
 * Fetches customer deliverables from Drive folders, extracts text,
 * chunks, embeds, and stores in Supabase.
 *
 * Run via: npm run ingest-gdrive
 * Also called by: api/cron/ingest-gdrive.ts
 */

import { createRequire } from 'module';
import { supabase, type Customer } from '../lib/supabase.js';
import { chunkText, embedBatch, hashContent } from '../lib/embeddings.js';
import { upsertDocument, insertChunks } from '../lib/knowledge-base.js';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Google Drive MCP stubs — replace with actual MCP calls
// ---------------------------------------------------------------------------

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

async function listDriveFiles(_folderId: string): Promise<DriveFile[]> {
  // TODO: Replace with actual Google Drive MCP call:
  // const result = await mcpClient.call('drive_list_files', { folderId });
  console.log('[ingest-gdrive] NOTE: Google Drive MCP not yet wired — using stub');
  return [];
}

async function fetchDriveFileContent(_fileId: string, mimeType: string): Promise<string> {
  // TODO: Replace with actual Google Drive MCP / export call
  // For Google Docs: export as text/plain
  // For PDFs: fetch binary and parse with pdf-parse
  // For DOCX: fetch binary and parse with mammoth
  console.log(`[ingest-gdrive] NOTE: fetchDriveFileContent stub for mimeType ${mimeType}`);
  return '';
}

// ---------------------------------------------------------------------------
// Content extraction helpers
// ---------------------------------------------------------------------------

async function extractText(fileId: string, mimeType: string): Promise<string> {
  const content = await fetchDriveFileContent(fileId, mimeType);
  if (!content) return '';

  if (mimeType === 'application/pdf') {
    // pdf-parse expects a Buffer
    const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;
    const buf = Buffer.from(content, 'base64');
    const parsed = await pdfParse(buf);
    return parsed.text;
  }

  if (
    mimeType ===
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const mammoth = require('mammoth') as {
      extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
    };
    const buf = Buffer.from(content, 'base64');
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value;
  }

  // Google Docs text export, plain text, markdown
  return content;
}

// ---------------------------------------------------------------------------
// Main ingestion logic
// ---------------------------------------------------------------------------

export async function ingestGdrive(): Promise<{
  processed: number;
  skipped: number;
  failed: number;
  chunksCreated: number;
}> {
  const logEntry = await supabase
    .from('ingestion_log')
    .insert({ source_type: 'gdrive_deliverable', status: 'running' })
    .select('id')
    .single();
  const logId = logEntry.data?.id as string;

  let processed = 0, skipped = 0, failed = 0, chunksCreated = 0;

  try {
    // Get all active customers with a Drive folder configured
    const { data: customers } = await supabase
      .from('customers')
      .select('id, display_name, gdrive_folder_id')
      .eq('is_active', true)
      .not('gdrive_folder_id', 'is', null);

    for (const customer of (customers as Customer[]) ?? []) {
      if (!customer.gdrive_folder_id) continue;

      console.log(`[ingest-gdrive] Processing customer: ${customer.display_name}`);
      const files = await listDriveFiles(customer.gdrive_folder_id);

      for (const file of files) {
        try {
          const text = await extractText(file.id, file.mimeType);
          if (!text || text.length < 50) { skipped++; continue; }

          const contentHash = await hashContent(text);
          const { id: docId, skipped: wasSkipped } = await upsertDocument({
            customer_id: customer.id,
            source_type: 'gdrive_deliverable',
            source_id: file.id,
            title: file.name,
            content_hash: contentHash,
            metadata: { mimeType: file.mimeType, modifiedTime: file.modifiedTime },
          });

          if (wasSkipped) { skipped++; continue; }

          const chunks = chunkText(text);
          const embeddings = await embedBatch(chunks);

          await insertChunks(
            docId,
            customer.id,
            chunks.map((content, i) => ({
              chunk_index: i,
              content,
              embedding: embeddings[i],
              token_count: Math.ceil(content.length / 4),
            }))
          );

          chunksCreated += chunks.length;
          processed++;
          console.log(`[ingest-gdrive] ✓ ${file.name} — ${chunks.length} chunks`);
        } catch (e) {
          console.error(`[ingest-gdrive] Failed file ${file.name}:`, e);
          failed++;
        }
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
const isMain = process.argv[1]?.endsWith('ingest-gdrive.ts');
if (isMain) {
  ingestGdrive()
    .then((r) => {
      console.log('[ingest-gdrive] Done:', r);
      process.exit(0);
    })
    .catch((e) => {
      console.error('[ingest-gdrive] Fatal:', e);
      process.exit(1);
    });
}
