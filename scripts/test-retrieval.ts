/**
 * Interactive retrieval test — run a query against the KB and see what comes back.
 *
 * Usage:
 *   npm run test-retrieval -- --query "quorum queue memory issue" --customer "Acme Corp"
 *   npm run test-retrieval -- --query "TLS configuration"
 */

import { supabase } from '../lib/supabase.js';
import { retrieveRelevantChunks } from '../lib/knowledge-base.js';

function parseArgs(): { query: string; customer?: string } {
  const args = process.argv.slice(2);
  const result: { query: string; customer?: string } = { query: '' };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--query') result.query = args[++i];
    else if (args[i] === '--customer') result.customer = args[++i];
  }

  return result;
}

async function main() {
  const args = parseArgs();

  if (!args.query) {
    console.error('Usage: --query "<search text>" [--customer "<name>"]');
    process.exit(1);
  }

  let customerId: string | null = null;
  if (args.customer) {
    const { data } = await supabase
      .from('customers')
      .select('id, display_name')
      .ilike('display_name', args.customer)
      .single();

    if (!data) {
      console.warn(`Customer "${args.customer}" not found — searching global KB only`);
    } else {
      customerId = data.id as string;
      console.log(`Customer: ${data.display_name as string} (${customerId})`);
    }
  }

  console.log(`\nQuery: "${args.query}"\n`);
  console.log('Retrieving...\n');

  const chunks = await retrieveRelevantChunks(args.query, customerId);

  if (chunks.length === 0) {
    console.log('No relevant chunks found.');
    return;
  }

  console.log(`Found ${chunks.length} chunks:\n`);
  console.log('='.repeat(80));

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const tag = c.is_customer_specific ? '[CUSTOMER-SPECIFIC]' : '[GENERAL]';
    console.log(`\n## Chunk ${i + 1} ${tag}`);
    console.log(`Source: ${c.source_type} — ${c.document_title}`);
    console.log(`Similarity: ${c.similarity.toFixed(4)}`);
    console.log('-'.repeat(40));
    // Print first 500 chars of content
    console.log(c.content.slice(0, 500) + (c.content.length > 500 ? '...' : ''));
  }

  console.log('\n' + '='.repeat(80));
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
