import { supabase, type KbChunk } from './supabase.js';
import { embed } from './embeddings.js';

const SIMILARITY_THRESHOLD = parseFloat(
  process.env.KB_SIMILARITY_THRESHOLD ?? '0.3'
);
const MAX_CHUNKS = parseInt(process.env.KB_MAX_CHUNKS ?? '15', 10);

/**
 * Retrieves the most relevant KB chunks for a given ticket text.
 * Customer-specific chunks are boosted by +0.15 in the DB function.
 */
export async function retrieveRelevantChunks(
  ticketText: string,
  customerId: string | null
): Promise<KbChunk[]> {
  const queryEmbedding = await embed(ticketText);

  const { data, error } = await supabase.rpc('search_knowledge_base', {
    query_embedding: queryEmbedding,
    p_customer_id: customerId,
    p_limit: MAX_CHUNKS,
    p_similarity_threshold: SIMILARITY_THRESHOLD,
  });

  if (error) {
    console.error('[knowledge-base] search_knowledge_base error:', error);
    return [];
  }

  return (data ?? []) as KbChunk[];
}

/**
 * Upserts a document record, returning the document ID.
 * Skips if content_hash matches (no change).
 * Returns { id, skipped }.
 */
export async function upsertDocument(doc: {
  customer_id: string | null;
  source_type: string;
  source_id: string;
  title: string;
  content_hash: string;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string; skipped: boolean }> {
  // Check existing
  const { data: existing } = await supabase
    .from('kb_documents')
    .select('id, content_hash')
    .eq('source_type', doc.source_type)
    .eq('source_id', doc.source_id)
    .single();

  if (existing && existing.content_hash === doc.content_hash) {
    return { id: existing.id as string, skipped: true };
  }

  const payload = {
    customer_id: doc.customer_id,
    source_type: doc.source_type,
    source_id: doc.source_id,
    title: doc.title,
    content_hash: doc.content_hash,
    metadata: doc.metadata ?? {},
    is_active: true,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    // Update existing document
    const { error } = await supabase
      .from('kb_documents')
      .update(payload)
      .eq('id', existing.id);
    if (error) throw new Error(`Failed to update kb_document: ${error.message}`);

    // Delete old chunks so they get re-embedded
    await supabase.from('kb_chunks').delete().eq('document_id', existing.id);

    return { id: existing.id as string, skipped: false };
  }

  // Insert new document
  const { data: inserted, error } = await supabase
    .from('kb_documents')
    .insert(payload)
    .select('id')
    .single();

  if (error || !inserted) {
    throw new Error(`Failed to insert kb_document: ${error?.message}`);
  }

  return { id: inserted.id as string, skipped: false };
}

/**
 * Inserts embedding chunks for a document.
 */
export async function insertChunks(
  documentId: string,
  customerId: string | null,
  chunks: Array<{
    chunk_index: number;
    content: string;
    embedding: number[];
    token_count?: number;
    metadata?: Record<string, unknown>;
  }>
): Promise<void> {
  if (chunks.length === 0) return;

  const rows = chunks.map((c) => ({
    document_id: documentId,
    customer_id: customerId,
    chunk_index: c.chunk_index,
    content: c.content,
    embedding: c.embedding,
    token_count: c.token_count ?? null,
    metadata: c.metadata ?? {},
  }));

  const { error } = await supabase.from('kb_chunks').insert(rows);
  if (error) throw new Error(`Failed to insert kb_chunks: ${error.message}`);
}
