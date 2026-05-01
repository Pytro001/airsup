-- Sourcing candidates: AI/admin-curated supplier suggestions for a project,
-- pending admin approval before they become real matches.
--
-- Source values:
--   'platform'   = matched from existing factories table (no LLM call needed)
--   'jd'         = found via Claude web search restricted to jd.com
--   'cantonfair' = found via Claude web search restricted to cantonfair.org.cn / cantonfair.net

CREATE TABLE IF NOT EXISTS sourcing_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('platform', 'jd', 'cantonfair')),
  factory_id INT REFERENCES factories(id) ON DELETE SET NULL,
  supplier_url TEXT,
  supplier_name TEXT NOT NULL,
  supplier_location TEXT,
  reasoning TEXT,
  raw JSONB DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sourcing_candidates_project_status
  ON sourcing_candidates(project_id, status);

CREATE INDEX IF NOT EXISTS idx_sourcing_candidates_created
  ON sourcing_candidates(created_at DESC);

-- RLS off (admin-only access via service-role key in backend).
ALTER TABLE sourcing_candidates ENABLE ROW LEVEL SECURITY;
