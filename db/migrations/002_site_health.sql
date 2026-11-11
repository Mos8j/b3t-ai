-- Soft removal: removed sites keep their row, reason and history, and can be restored.
ALTER TABLE site ADD COLUMN removed_at timestamptz;
ALTER TABLE site ADD COLUMN removed_reason text;

CREATE TABLE site_test_run (
  id bigserial PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES site(id),
  ran_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('reachability','form_test')),
  outcome text NOT NULL CHECK (outcome IN ('ok','dns_gone','bad_certificate','page_missing','bot_blocked','timeout','form_failed')),
  detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX site_test_run_site ON site_test_run (site_id, ran_at);
