-- Cold outreach system: 24/7 automated discovery + email to factories in CN/US/EU
-- with the goal of pushing them through /start onboarding on airsup.dev.
--
-- Pipeline:
--   cold_targets (discovered)   → quality check → status='qualified' OR 'disqualified'
--   cold_targets (qualified)    → send first email → cold_emails row + status='contacted'
--   cold_emails (replied)       → LLM drafts reply → cold_emails row (sent)
--   target onboards on airsup   → status='converted'

CREATE TABLE IF NOT EXISTS cold_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  website TEXT,
  email TEXT,
  contact_name TEXT,
  category TEXT NOT NULL,
  region TEXT NOT NULL CHECK (region IN ('CN', 'US', 'EU', 'OTHER')),
  country TEXT,
  discovered_via TEXT,
  quality_score INT,
  quality_notes JSONB DEFAULT '{}'::jsonb,
  named_customers TEXT[] DEFAULT ARRAY[]::TEXT[],
  status TEXT NOT NULL DEFAULT 'discovered'
    CHECK (status IN ('discovered','qualified','disqualified','contacted','replying','converted','dead','unsubscribed')),
  unsub_token TEXT UNIQUE DEFAULT encode(gen_random_bytes(12), 'hex'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  qualified_at TIMESTAMPTZ,
  contacted_at TIMESTAMPTZ,
  last_event_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cold_targets_email ON cold_targets(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cold_targets_website ON cold_targets(website) WHERE website IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cold_targets_status ON cold_targets(status, last_event_at);

CREATE TABLE IF NOT EXISTS cold_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id UUID NOT NULL REFERENCES cold_targets(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  subject TEXT,
  body TEXT NOT NULL,
  message_id TEXT,
  in_reply_to TEXT,
  from_email TEXT,
  to_email TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  processed BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_cold_emails_target ON cold_emails(target_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_cold_emails_unprocessed ON cold_emails(processed, direction) WHERE processed = FALSE;
CREATE INDEX IF NOT EXISTS idx_cold_emails_message_id ON cold_emails(message_id) WHERE message_id IS NOT NULL;

ALTER TABLE cold_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE cold_emails ENABLE ROW LEVEL SECURITY;
