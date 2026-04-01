import OpenAI from 'openai';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;

/**
 * Generates an embedding vector for a single text string.
 */
export async function embed(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: MODEL,
    input: text.trim(),
    dimensions: DIMENSIONS,
  });
  return response.data[0].embedding;
}

/**
 * Generates embedding vectors for multiple texts in a single API call.
 * OpenAI supports up to 2048 inputs per request.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await openai.embeddings.create({
    model: MODEL,
    input: texts.map((t) => t.trim()),
    dimensions: DIMENSIONS,
  });

  // Preserve original order
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/**
 * Splits text into chunks of approximately maxTokens (using rough char-based estimate).
 * Tries to split on paragraph boundaries first, then sentence boundaries.
 * Target: 500–800 tokens. At ~4 chars/token, that's ~2000–3200 chars.
 */
export function chunkText(text: string, maxChars = 3000, overlapChars = 200): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 2 <= maxChars) {
      current = current ? `${current}\n\n${trimmed}` : trimmed;
    } else {
      if (current) {
        chunks.push(current);
        // Carry over last overlap chars for context continuity
        const tail = current.slice(-overlapChars);
        current = tail ? `${tail}\n\n${trimmed}` : trimmed;
      } else {
        // Single paragraph larger than maxChars — split by sentence
        const sentences = trimmed.match(/[^.!?]+[.!?]+/g) ?? [trimmed];
        for (const sentence of sentences) {
          if (current.length + sentence.length + 1 <= maxChars) {
            current = current ? `${current} ${sentence}` : sentence;
          } else {
            if (current) chunks.push(current);
            current = sentence;
          }
        }
      }
    }
  }

  if (current) chunks.push(current);
  return chunks.filter((c) => c.trim().length > 0);
}

/**
 * Simple SHA-256 hash of text content for change detection.
 */
export async function hashContent(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
