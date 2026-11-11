ALTER TABLE client ADD COLUMN owner_id uuid REFERENCES app_user(id);
CREATE INDEX client_owner_idx ON client (owner_id) WHERE deleted_at IS NULL;

WITH creators AS (
  SELECT DISTINCT ON (client_id) client_id, user_id
  FROM audit_log
  WHERE action = 'client.create' AND client_id IS NOT NULL AND user_id IS NOT NULL
  ORDER BY client_id, id
)
UPDATE client c SET owner_id = creators.user_id
FROM creators JOIN app_user u ON u.id = creators.user_id
WHERE c.id = creators.client_id;

-- Leave ambiguous legacy records available only to admins.
WITH single_owner AS (
  SELECT client_id, (array_agg(user_id))[1] AS user_id
  FROM client_assignment GROUP BY client_id HAVING count(*) = 1
)
UPDATE client c SET owner_id = single_owner.user_id
FROM single_owner WHERE c.id = single_owner.client_id AND c.owner_id IS NULL;

DROP POLICY client_assigned ON client;
CREATE POLICY client_owner ON client USING (
  owner_id = nullif(current_setting('app.current_user', true), '')::uuid
  OR current_setting('app.current_role', true) = 'admin'
);
