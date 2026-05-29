-- B10: Add 'apresentador' and 'gerente' roles to the users table CHECK constraint.
-- The original constraint only allows: franqueador_master, franqueado, cliente_parceiro.
-- We drop the old constraint and replace it with one that includes the new roles.

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_papel_check;

ALTER TABLE users
  ADD CONSTRAINT users_papel_check
  CHECK (papel IN (
    'franqueador_master',
    'franqueado',
    'cliente_parceiro',
    'gerente',
    'apresentador'
  ));
