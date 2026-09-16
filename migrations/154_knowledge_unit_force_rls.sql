-- Migration 154 — enforce tenant RLS for the Base library.
-- Table owners bypass RLS in PostgreSQL unless FORCE is explicit. The API also
-- filters tenant_id, but forcing RLS closes accidental owner/bypass paths.
ALTER TABLE knowledge_unit_categories FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_materials FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_material_attachments FORCE ROW LEVEL SECURITY;
