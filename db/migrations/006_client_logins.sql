-- Logins (username and password) the software made up for a client on a website. Sealed with the client's own key; only admins can read them.
CREATE TABLE client_login (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id),
  site_id uuid NOT NULL REFERENCES site(id),
  encrypted_login bytea NOT NULL,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_login_by_client ON client_login (client_id, created_at DESC);
