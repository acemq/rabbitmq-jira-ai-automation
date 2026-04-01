import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Customer, KbChunk } from './supabase.js';

if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 2048;
const TEMPERATURE = 0.3;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(
  join(__dirname, '../prompts/system-prompt.md'),
  'utf-8'
);
const EXTRACTION_PROMPT = readFileSync(
  join(__dirname, '../prompts/extraction-prompt.md'),
  'utf-8'
);

interface TicketContext {
  issueKey: string;
  issueType: string | null;
  priority: string | null;
  reporterName: string | null;
  summary: string;
  descriptionPlaintext: string | null;
}

function formatCustomerContext(customer: Customer | null): string {
  if (!customer) {
    return `## CUSTOMER CONTEXT
Unknown customer — no organization matched. Using general KB only.`;
  }

  const fields = [
    `Company: ${customer.display_name}`,
    `RabbitMQ Version: ${customer.rabbitmq_version ?? 'Unknown'}`,
    `Erlang Version: ${customer.erlang_version ?? 'Unknown'}`,
    `Cluster Size: ${customer.cluster_size != null ? `${customer.cluster_size} nodes` : 'Unknown'}`,
    `Deployment Type: ${customer.deployment_type ?? 'Unknown'}`,
    `OS: ${customer.os_info ?? 'Unknown'}`,
    `Cloud Provider: ${customer.cloud_provider ?? 'Unknown'}`,
    `Use Case: ${customer.use_case_summary ?? 'Unknown'}`,
    ...(customer.environment_notes ? [`Environment Notes: ${customer.environment_notes}`] : []),
  ];

  return `## CUSTOMER CONTEXT\n${fields.join('\n')}`;
}

function formatKbContext(chunks: KbChunk[]): string {
  if (chunks.length === 0) {
    return `## RELEVANT KNOWLEDGE BASE CONTEXT\nNo relevant KB chunks found.`;
  }

  const formatted = chunks
    .map((c, i) => {
      const tag = c.is_customer_specific ? '[CUSTOMER-SPECIFIC]' : '[GENERAL]';
      const source = `Source: ${c.source_type} — ${c.document_title}`;
      return `### Chunk ${i + 1} ${tag}\n${source}\nSimilarity: ${c.similarity.toFixed(3)}\n\n${c.content}`;
    })
    .join('\n\n---\n\n');

  return `## RELEVANT KNOWLEDGE BASE CONTEXT\n\n${formatted}`;
}

function formatTicket(ticket: TicketContext): string {
  return `## SUPPORT TICKET
Issue Key: ${ticket.issueKey}
Type: ${ticket.issueType ?? 'Unknown'}
Priority: ${ticket.priority ?? 'Unknown'}
Reporter: ${ticket.reporterName ?? 'Unknown'}
Subject: ${ticket.summary}

Description:
${ticket.descriptionPlaintext ?? '(No description provided)'}`;
}

/**
 * Builds the full user prompt and calls Claude.
 * Returns the raw Claude output (contains <classification> and <response> blocks).
 */
export async function generateResponse(
  ticket: TicketContext,
  customer: Customer | null,
  chunks: KbChunk[]
): Promise<{
  rawOutput: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}> {
  const userPrompt = [
    formatCustomerContext(customer),
    '',
    formatKbContext(chunks),
    '',
    formatTicket(ticket),
  ].join('\n');

  const start = Date.now();

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const latencyMs = Date.now() - start;
  const rawOutput = message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  return {
    rawOutput,
    promptTokens: message.usage.input_tokens,
    completionTokens: message.usage.output_tokens,
    latencyMs,
  };
}

/**
 * Extracts environment metadata from a transcript using Claude.
 * Returns a partial Customer object with only the fields Claude found.
 */
export async function extractEnvironmentMetadata(
  transcriptText: string
): Promise<Partial<Customer>> {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    temperature: 0,
    system: EXTRACTION_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Extract environment details from this text:\n\n${transcriptText.slice(0, 8000)}`,
      },
    ],
  });

  const raw = message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('')
    .trim();

  try {
    return JSON.parse(raw) as Partial<Customer>;
  } catch {
    console.warn('[claude-client] Could not parse extraction JSON:', raw);
    return {};
  }
}
