-- 139: turnos de apresentadora dentro de um evento de agenda (revezamento).
--
-- Produto: em lives grandes mais de uma apresenta ("Ana 14h-16h, Bia 16h-18h").
-- agenda_eventos.apresentadora_id e FK escalar (migration 085:7) — nao ha onde
-- gravar quem apresenta QUANDO.
--
-- Modelo: UMA live, N turnos. Nao N eventos irmaos: agenda_autostart.js:130-136
-- pula evento cuja cabine ja tem live_atual_id e depois de 60min (STALE_THRESHOLD_
-- MINUTES) o evento vira stale para sempre — a segunda apresentadora nunca entraria
-- em live nenhuma.
--
-- agenda_eventos.apresentadora_id NAO e removida: vira ESPELHO da apresentadora do
-- turno principal (mesmo padrao de percentual_rateio na migration 135). Assim
-- agenda_autostart (:155-162), syncAgendaEventForLive (lives.js:261-312) e o
-- `a.nome AS apresentadora_nome` do GET /v1/agenda (agenda.js:347) seguem
-- funcionando sem alteracao.
--
-- SO DDL ADITIVA: nao le, nao valida e nao reescreve nenhuma linha existente.
-- Nenhum numero historico se move. Reversivel por DROP TABLE.
--
-- Sem backfill de proposito: evento antigo continua sem turno e cai no caminho
-- escalar de hoje. Backfillar criaria turno para eventos cujo espelho e reescrito
-- por syncAgendaEventForLive a cada PATCH de live com marca.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS agenda_evento_apresentadoras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  agenda_evento_id UUID NOT NULL REFERENCES agenda_eventos(id) ON DELETE CASCADE,
  apresentadora_id UUID NOT NULL REFERENCES apresentadoras(id),
  data_inicio TIMESTAMPTZ NOT NULL,
  data_fim TIMESTAMPTZ NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Espelha o CHECK de agenda_eventos (migration 080:83) na granularidade do turno.
  CONSTRAINT agenda_evento_apresentadoras_periodo_check CHECK (data_fim > data_inicio),
  -- A mesma apresentadora pode ter DOIS turnos no mesmo evento (manha e noite); o
  -- que nao pode e o mesmo turno duplicado. Ao semear o rateio, turnos da mesma
  -- pessoa sao COLAPSADOS numa linha so, porque live_apresentadoras_v2 tem
  -- UNIQUE (live_id, apresentadora_id) (migration 080:108).
  CONSTRAINT agenda_evento_apresentadoras_turno_unico
    UNIQUE (agenda_evento_id, apresentadora_id, data_inicio)
);

CREATE INDEX IF NOT EXISTS idx_agenda_evento_apresentadoras_evento
  ON agenda_evento_apresentadoras (agenda_evento_id);

-- Lookup de conflito: "esta apresentadora esta ocupada nesta janela?"
CREATE INDEX IF NOT EXISTS idx_agenda_evento_apresentadoras_conflito
  ON agenda_evento_apresentadoras (tenant_id, apresentadora_id, data_inicio, data_fim);

ALTER TABLE agenda_evento_apresentadoras ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agenda_evento_apresentadoras_tenant ON agenda_evento_apresentadoras;
CREATE POLICY agenda_evento_apresentadoras_tenant ON agenda_evento_apresentadoras
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON TABLE agenda_evento_apresentadoras IS
  'Turnos de apresentadora num evento de agenda (revezamento). Vira o rateio inicial de live_apresentadoras_v2 quando a live abre — ver src/lib/agenda-turnos.js. RLS por tenant nao valida o tenant da FK: quem escreve e src/routes/agenda.js, que confere via ensureAgendaRefs.';
