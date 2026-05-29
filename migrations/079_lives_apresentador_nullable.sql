-- Migration 079: lives.apresentador_id e live_apresentadores.apresentador_id podem ser null
-- para lives manuais onde a apresentadora não tem conta de usuário vinculada.
-- O campo ainda é FK para users(id) quando preenchido (TikTok lives), mas
-- entradas manuais usam apresentadoras.id resolvido para user_id (null se sem conta).
ALTER TABLE lives ALTER COLUMN apresentador_id DROP NOT NULL;
ALTER TABLE live_apresentadores ALTER COLUMN apresentador_id DROP NOT NULL;
