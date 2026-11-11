CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','operator','viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE client (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  encrypted_profile bytea NOT NULL,        -- envelope-encrypted JSON
  wrapped_dek bytea NOT NULL,
  retention_days int NOT NULL DEFAULT 365,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE client_assignment (
  user_id uuid REFERENCES app_user(id),
  client_id uuid REFERENCES client(id),
  PRIMARY KEY (user_id, client_id)
);
CREATE TABLE client_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  kind text NOT NULL, object_key text NOT NULL, sha256 text NOT NULL,
  replaced_by uuid REFERENCES client_document(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE consent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  scope text NOT NULL,                      -- e.g. 'category:jobs','data:references'
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  recorded_by uuid REFERENCES app_user(id)
);

CREATE TABLE site (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  official_domain text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  registration_url text,
  category text NOT NULL CHECK (category IN ('subscription','rewards','membership','employment','other')),
  description text,
  eligibility text, geo_restrictions text, cost text, recurring_fees text,
  application_type text,
  automation_policy text NOT NULL DEFAULT 'unknown' CHECK (automation_policy IN ('unknown','allowed','api_only','manual_only')),
  compatibility_status text NOT NULL DEFAULT 'untested' CHECK (compatibility_status IN ('untested','supported','partial','broken','manual_only')),
  adapter_id text, adapter_version text,
  last_verified_at timestamptz, last_successful_test_at timestamptz,
  discovery_source text NOT NULL,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  user_notes text,                          -- preserved from imports
  catalog_state text NOT NULL DEFAULT 'candidate' CHECK (catalog_state IN ('candidate','approved','rejected','research'))
);
CREATE TABLE site_fact (                    -- verified vs AI-derived provenance
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES site(id),
  field text NOT NULL, value text,
  provenance text NOT NULL CHECK (provenance IN ('check','ai_unverified','user','import')),
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE site_relation (
  from_site uuid REFERENCES site(id), to_site uuid REFERENCES site(id),
  reason text NOT NULL, confidence numeric(3,2) NOT NULL,
  state text NOT NULL DEFAULT 'suggested' CHECK (state IN ('suggested','accepted','rejected')),
  PRIMARY KEY (from_site, to_site)
);
CREATE TABLE site_import (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL, original_rows jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE match (
  client_id uuid REFERENCES client(id), site_id uuid REFERENCES site(id),
  score numeric(5,2) NOT NULL, reasons jsonb NOT NULL, missing_data jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (client_id, site_id)
);
CREATE TABLE batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  approval_policy text NOT NULL CHECK (approval_policy IN ('per_application','batch_defined')),
  approved_by uuid REFERENCES app_user(id), approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE application (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES batch(id),
  client_id uuid NOT NULL REFERENCES client(id),
  site_id uuid NOT NULL REFERENCES site(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','in_progress','form_filled','awaiting_approval','awaiting_human','submitting','submitted','confirmed','failed','skipped','cancelled')),
  progress jsonb NOT NULL DEFAULT '{}',
  UNIQUE (client_id, site_id)
);
CREATE TABLE application_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES application(id),
  kind text NOT NULL CHECK (kind IN ('submit_response','confirmation_page','confirmation_number','email_receipt')),
  detail jsonb NOT NULL, captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE authorization_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid REFERENCES application(id), batch_id uuid REFERENCES batch(id),
  kind text NOT NULL CHECK (kind IN ('submit','billing','legal_declaration','marketing_optin')),
  detail jsonb, granted_by uuid NOT NULL REFERENCES app_user(id), granted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
  user_id uuid, client_id uuid, action text NOT NULL, detail jsonb
);

-- Row-level security scaffold (enabled once app sets app.current_user)
ALTER TABLE client ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_assigned ON client USING (
  EXISTS (SELECT 1 FROM client_assignment a WHERE a.client_id = client.id
          AND a.user_id = nullif(current_setting('app.current_user', true),'')::uuid)
  OR current_setting('app.current_role', true) = 'admin');
