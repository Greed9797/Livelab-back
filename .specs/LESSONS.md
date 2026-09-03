# LESSONS - auto-maintained by scripts/lessons.py

> Machine-owned. Do NOT hand-edit. Changes are overwritten on the next `lessons.py` write.
> Canonical state lives in `.specs/lessons.json`. Edit lessons only via the script.
> promote_threshold=2 distinct features · window_days=45 · quarantine_threshold=2

## Confirmed (load these at Specify/Design)

Corroborated across multiple features. Safe to apply as guidance.

_none_

## Candidates (under observation - do NOT load as guidance yet)

Seen once or not yet corroborated. Tracked, not trusted.

### L-001 - Antes de escrever AC de escrita para uma rota, abrir o handler: POST /v1/apresentadoras era 410 para todo papel e o AC nasceu inviável.
- signal: `spec_deviation` · recurrence: 1 feature(s) · scope: `src/routes` · harmful: 0
- features: bot-tag-e-cli
- evidence: SPEC_DEVIATION BOT-02 (src/routes/apresentadoras.js:307) (src/routes)
- last seen: 2026-09-03T21:15:44Z

### L-002 - AC que cita campo por nome precisa conferir em qual rota o campo é gravado; status_publicacao só gera revisão em /publicar, fora da allowlist.
- signal: `spec_precision_gap` · recurrence: 1 feature(s) · scope: `.specs` · harmful: 0
- features: bot-tag-e-cli
- evidence: spec.md P1 tag BOT AC7 (.specs)
- last seen: 2026-09-03T21:15:44Z

### L-003 - Doc e allowlist divergem em silêncio (POST /v1/analytics/imports não existia); teste que compara a tabela publicada com chaveAlcancaRota nos dois sentidos pega isso.
- signal: `ac_gap` · recurrence: 1 feature(s) · scope: `src/plugins/auth.js` · harmful: 0
- features: bot-tag-e-cli
- evidence: test/cli_livelab.test.js:139 (allowlist vs docs) (src/plugins/auth.js)
- last seen: 2026-09-03T21:15:44Z

## Quarantined (failed when applied - ignore)

A confirmed lesson that recurred alongside failure. Kept for the maintainer to review.

_none_
