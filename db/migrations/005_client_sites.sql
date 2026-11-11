-- Which sites each client is going to join, and what staff decided about each one.
-- status: proposed (suggested by the software), approved (staff OK it), skipped, staff_fill (staff will fill this one by hand), done (staff say it is finished).
-- "done" is marked by a person and is not verified by the software.
CREATE TABLE client_site (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES site(id),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','skipped','staff_fill','done')),
  note text,
  decided_by uuid REFERENCES app_user(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, site_id)
);
CREATE INDEX client_site_by_client ON client_site (client_id, status);
