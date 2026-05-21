-- Unifica vínculos operacionais entre agenda, lives, marcas e GMV.
ALTER TABLE marcas
  ADD COLUMN IF NOT EXISTS logo_url TEXT;

ALTER TABLE lives
  ADD COLUMN IF NOT EXISTS marca_id UUID REFERENCES marcas(id) ON DELETE SET NULL;

ALTER TABLE agenda_eventos
  ADD COLUMN IF NOT EXISTS live_id UUID REFERENCES lives(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lives_tenant_marca
  ON lives(tenant_id, marca_id)
  WHERE marca_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agenda_eventos_live_id
  ON agenda_eventos(live_id)
  WHERE live_id IS NOT NULL;

UPDATE lives l
   SET marca_id = ae.marca_id
  FROM agenda_eventos ae
 WHERE l.marca_id IS NULL
   AND l.agenda_evento_id = ae.id
   AND l.tenant_id = ae.tenant_id
   AND ae.marca_id IS NOT NULL;

UPDATE lives l
   SET marca_id = (
     SELECT va2.marca_id
       FROM vendas_atribuidas va2
      WHERE va2.tenant_id = l.tenant_id
        AND va2.origem = 'live'
        AND va2.origem_id = l.id
        AND va2.marca_id IS NOT NULL
      ORDER BY va2.atualizado_em DESC NULLS LAST, va2.criado_em DESC NULLS LAST
      LIMIT 1
   )
 WHERE l.marca_id IS NULL
   AND EXISTS (
     SELECT 1
       FROM vendas_atribuidas va2
      WHERE va2.tenant_id = l.tenant_id
        AND va2.origem = 'live'
        AND va2.origem_id = l.id
        AND va2.marca_id IS NOT NULL
   );

UPDATE lives l
   SET marca_id = (
     SELECT m2.id
       FROM marcas m2
      WHERE m2.tenant_id = l.tenant_id
        AND m2.cliente_id = l.cliente_id
        AND m2.status = 'ativa'
      ORDER BY m2.criado_em ASC
      LIMIT 1
   )
 WHERE l.marca_id IS NULL
   AND l.cliente_id IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM marcas m2
      WHERE m2.tenant_id = l.tenant_id
        AND m2.cliente_id = l.cliente_id
        AND m2.status = 'ativa'
   );

UPDATE agenda_eventos ae
   SET live_id = l.id
  FROM lives l
 WHERE ae.live_id IS NULL
   AND l.agenda_evento_id = ae.id
   AND l.tenant_id = ae.tenant_id;
