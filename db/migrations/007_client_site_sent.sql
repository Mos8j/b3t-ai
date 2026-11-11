-- "sent" = the software sent the form but the site did not clearly confirm (or wants an email confirmation).
ALTER TABLE client_site DROP CONSTRAINT client_site_status_check;
ALTER TABLE client_site ADD CONSTRAINT client_site_status_check CHECK (status IN ('proposed','approved','skipped','staff_fill','done','sent'));
