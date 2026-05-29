-- Migration 011: Manuais e documentos da franqueadora
CREATE TABLE IF NOT EXISTS manuais (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo        TEXT        NOT NULL,
  url           TEXT        NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sem RLS — manuais são públicos para todos os usuários autenticados

-- Seed com documentos iniciais
INSERT INTO manuais (titulo, url, atualizado_em) VALUES
  ('Manual de Operações LiveShop',       'https://example.com/manuais/operacoes.pdf',      NOW()),
  ('Guia de Configuração de Cabines',    'https://example.com/manuais/cabines.pdf',         NOW()),
  ('Treinamento de Apresentadores',      'https://example.com/manuais/apresentadores.pdf',  NOW()),
  ('Manual de Vendas e Negociação',      'https://example.com/manuais/vendas.pdf',          NOW()),
  ('Política de Franquia',               'https://example.com/manuais/franquia.pdf',        NOW())
ON CONFLICT DO NOTHING;
