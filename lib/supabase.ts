import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!process.env.SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY is required');

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: { persistSession: false },
  }
);

// Type definitions mirroring the DB schema

export interface Customer {
  id: string;
  jira_organization_id: string;
  jira_organization_name: string;
  display_name: string;
  rabbitmq_version: string | null;
  erlang_version: string | null;
  cluster_size: number | null;
  deployment_type: string | null;
  os_info: string | null;
  cloud_provider: string | null;
  use_case_summary: string | null;
  environment_notes: string | null;
  fireflies_contact_email: string | null;
  gdrive_folder_id: string | null;
  sla_tier: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TicketJob {
  id: string;
  jira_issue_id: string;
  jira_issue_key: string;
  jira_project_key: string;
  customer_id: string | null;
  summary: string;
  description: string | null;
  description_plaintext: string | null;
  reporter_email: string | null;
  reporter_name: string | null;
  organization_id: string | null;
  organization_name: string | null;
  issue_type: string | null;
  priority: string | null;
  labels: string[];
  status: 'pending' | 'processing' | 'completed' | 'failed';
  scheduled_for: string;
  delay_minutes: number;
  response_mode: string | null;
  response_confidence: string | null;
  response_text: string | null;
  jira_comment_id: string | null;
  error_message: string | null;
  retry_count: number;
  created_at: string;
  processed_at: string | null;
  completed_at: string | null;
}

export interface KbChunk {
  chunk_id: string;
  content: string;
  similarity: number;
  source_type: string;
  document_title: string;
  chunk_metadata: Record<string, unknown>;
  is_customer_specific: boolean;
}
