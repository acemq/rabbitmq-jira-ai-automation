/**
 * Bootstrap customers from customer-manifest.json into Supabase.
 * Run once, then update the manifest and re-run as customers are added.
 *
 * Usage: npm run bootstrap-customers
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { supabase } from '../lib/supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CustomerManifestEntry {
  jira_organization_id: string;
  jira_organization_name: string;
  display_name: string;
  rabbitmq_version?: string;
  erlang_version?: string;
  cluster_size?: number;
  deployment_type?: string;
  os_info?: string;
  cloud_provider?: string;
  use_case_summary?: string;
  environment_notes?: string;
  fireflies_contact_email?: string;
  gdrive_folder_id?: string;
  sla_tier?: string;
}

interface CustomerManifest {
  customers: CustomerManifestEntry[];
}

async function bootstrapCustomers() {
  const manifestPath = join(__dirname, '../knowledge-base/customer-manifest.json');

  let manifest: CustomerManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as CustomerManifest;
  } catch (e) {
    console.error('Could not read customer-manifest.json:', e);
    console.error('Expected path:', manifestPath);
    process.exit(1);
  }

  const customers = manifest.customers ?? [];
  console.log(`Bootstrapping ${customers.length} customers...`);

  let upserted = 0, failed = 0;

  for (const entry of customers) {
    if (!entry.jira_organization_id || !entry.display_name) {
      console.warn('Skipping entry missing required fields:', entry);
      failed++;
      continue;
    }

    const { error } = await supabase
      .from('customers')
      .upsert(
        {
          jira_organization_id: entry.jira_organization_id,
          jira_organization_name: entry.jira_organization_name,
          display_name: entry.display_name,
          rabbitmq_version: entry.rabbitmq_version ?? null,
          erlang_version: entry.erlang_version ?? null,
          cluster_size: entry.cluster_size ?? null,
          deployment_type: entry.deployment_type ?? null,
          os_info: entry.os_info ?? null,
          cloud_provider: entry.cloud_provider ?? null,
          use_case_summary: entry.use_case_summary ?? null,
          environment_notes: entry.environment_notes ?? null,
          fireflies_contact_email: entry.fireflies_contact_email ?? null,
          gdrive_folder_id: entry.gdrive_folder_id ?? null,
          sla_tier: entry.sla_tier ?? 'standard',
          is_active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'jira_organization_id' }
      );

    if (error) {
      console.error(`Failed to upsert ${entry.display_name}:`, error.message);
      failed++;
    } else {
      console.log(`✓ ${entry.display_name} (org: ${entry.jira_organization_id})`);
      upserted++;
    }
  }

  console.log(`\nDone: ${upserted} upserted, ${failed} failed`);
}

bootstrapCustomers().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
