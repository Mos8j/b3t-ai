-- How each site is handled (found by checking its page), plus a pool of candidate sites waiting to fill empty slots.
ALTER TABLE site ADD COLUMN handling text NOT NULL DEFAULT 'unchecked' CHECK (handling IN ('unchecked','simple','staff','unknown'));
ALTER TABLE site ADD COLUMN handling_reason text;
ALTER TABLE site ADD COLUMN fingerprint text[];
ALTER TABLE site ADD COLUMN analyzed_at timestamptz;
UPDATE site SET handling = 'staff', handling_reason = 'sensitive site (credit, banking or insurance)' WHERE automation_policy = 'manual_only';

CREATE TABLE site_candidate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL UNIQUE,
  name text NOT NULL,
  url text NOT NULL,
  category text NOT NULL CHECK (category IN ('subscription','rewards','membership','employment','other')),
  handling text NOT NULL CHECK (handling IN ('simple','staff','unknown')),
  handling_reason text,
  fingerprint text[] NOT NULL DEFAULT '{}',
  score numeric(4,3) NOT NULL DEFAULT 0,
  source text NOT NULL CHECK (source IN ('search','pasted')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','promoted','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_candidate_pick ON site_candidate (state, handling, score DESC);
