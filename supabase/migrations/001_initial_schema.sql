-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CUSTOMERS: Maps Jira organizations to customer context
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jira_organization_id VARCHAR(255) UNIQUE NOT NULL,
  jira_organization_name VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  rabbitmq_version VARCHAR(50),
  erlang_version VARCHAR(50),
  cluster_size INTEGER,
  deployment_type VARCHAR(50),
  os_info VARCHAR(255),
  cloud_provider VARCHAR(50),
  use_case_summary TEXT,
  environment_notes TEXT,
  fireflies_contact_email VARCHAR(255),
  gdrive_folder_id VARCHAR(255),
  sla_tier VARCHAR(50) DEFAULT 'standard',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- KB_DOCUMENTS: Tracks source documents before chunking
CREATE TABLE kb_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  source_type VARCHAR(50) NOT NULL,
  source_id VARCHAR(500),
  title VARCHAR(500) NOT NULL,
  file_path VARCHAR(1000),
  content_hash VARCHAR(64),
  metadata JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  ingested_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_kb_documents_customer ON kb_documents(customer_id);
CREATE INDEX idx_kb_documents_source ON kb_documents(source_type, source_id);
CREATE UNIQUE INDEX idx_kb_documents_dedup ON kb_documents(source_type, source_id) WHERE source_id IS NOT NULL;

-- KB_CHUNKS: Embedded text chunks for vector similarity search
CREATE TABLE kb_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536) NOT NULL,
  token_count INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_kb_chunks_customer ON kb_chunks(customer_id);
CREATE INDEX idx_kb_chunks_document ON kb_chunks(document_id);
CREATE INDEX idx_kb_chunks_embedding ON kb_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- TICKET_JOBS: Database-backed delayed job queue
CREATE TABLE ticket_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jira_issue_id VARCHAR(50) NOT NULL,
  jira_issue_key VARCHAR(50) NOT NULL,
  jira_project_key VARCHAR(20) NOT NULL,
  customer_id UUID REFERENCES customers(id),
  summary TEXT NOT NULL,
  description TEXT,
  description_plaintext TEXT,
  reporter_email VARCHAR(255),
  reporter_name VARCHAR(255),
  organization_id VARCHAR(255),
  organization_name VARCHAR(255),
  issue_type VARCHAR(100),
  priority VARCHAR(50),
  labels JSONB DEFAULT '[]',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  scheduled_for TIMESTAMPTZ NOT NULL,
  delay_minutes INTEGER NOT NULL,
  response_mode VARCHAR(20),
  response_confidence VARCHAR(10),
  response_text TEXT,
  jira_comment_id VARCHAR(50),
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_ticket_jobs_pending ON ticket_jobs(status, scheduled_for) WHERE status = 'pending';
CREATE INDEX idx_ticket_jobs_jira_issue ON ticket_jobs(jira_issue_id);
CREATE UNIQUE INDEX idx_ticket_jobs_dedup ON ticket_jobs(jira_issue_id) WHERE status IN ('pending', 'processing');

-- RESPONSE_LOG: Audit trail
CREATE TABLE response_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_job_id UUID NOT NULL REFERENCES ticket_jobs(id),
  claude_model VARCHAR(100),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  api_latency_ms INTEGER,
  retrieved_chunk_ids UUID[],
  retrieved_chunk_count INTEGER,
  customer_context_included BOOLEAN,
  response_mode VARCHAR(20),
  response_confidence VARCHAR(10),
  classification_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- INGESTION_LOG: Tracks KB ingestion runs
CREATE TABLE ingestion_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL,
  documents_processed INTEGER DEFAULT 0,
  documents_skipped INTEGER DEFAULT 0,
  documents_failed INTEGER DEFAULT 0,
  chunks_created INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- HELPER FUNCTION: Customer-scoped KB search with boosting
CREATE OR REPLACE FUNCTION search_knowledge_base(
  query_embedding VECTOR(1536),
  p_customer_id UUID,
  p_limit INTEGER DEFAULT 15,
  p_similarity_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  chunk_id UUID,
  content TEXT,
  similarity FLOAT,
  source_type VARCHAR,
  document_title VARCHAR,
  chunk_metadata JSONB,
  is_customer_specific BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id AS chunk_id,
    kc.content,
    (1 - (kc.embedding <=> query_embedding)) +
      CASE WHEN kc.customer_id = p_customer_id THEN 0.15 ELSE 0 END AS similarity,
    kd.source_type,
    kd.title AS document_title,
    kc.metadata AS chunk_metadata,
    (kc.customer_id = p_customer_id) AS is_customer_specific
  FROM kb_chunks kc
  JOIN kb_documents kd ON kd.id = kc.document_id
  WHERE (kc.customer_id = p_customer_id OR kc.customer_id IS NULL)
    AND kd.is_active = true
    AND (1 - (kc.embedding <=> query_embedding)) >= p_similarity_threshold
  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;
