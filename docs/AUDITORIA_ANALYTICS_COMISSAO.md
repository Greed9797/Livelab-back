# Auditoria Técnica — Analytics, Comissão, Metas e Relatório

Data: 2026-06-10 · Escopo: backend (`liveshop_saas_api-backend-`) + frontend Flutter (`-liveshop_saas-frontend-`)
Fase 1 do plano de 8 fases (painel operacional cliente/marca).

## 1. O que existe hoje

### Backend

| Área | Arquivo | Linhas | Estado |
|---|---|---|---|
| Analytics dashboard | `src/routes/analytics.js` | 130, 155-213 | GMV mensal 12m, vendas, ticket (226-231), horas/dia, ranking top 10 apresentadores |
| Analytics resumo franqueado | `src/routes/analytics.js` | 2, 28-90 | GMV hoje, audiência, ranking closers/clientes, heatmap, eficiência cabines |
| Cliente dashboard | `src/routes/cliente_dashboard.js` | 176-184, 316-957 | ~40 pontos `COALESCE(...,0)` — dado ausente vira 0 |
| Comissão (criação manual) | `src/routes/cabines.js` | 965-972 | `contratos.comissao_pct` via JOIN cabines→contratos |
| Comissão (edição) | `src/routes/cabines.js` | 1033-1042, 1055 | idem |
| Comissão (encerramento) | `src/routes/cabines.js` | 1156-1171 | idem; grava `lives.comissao_calculada` |
| Cadastro apresentadora | `src/routes/apresentadoras.js` | 11, 65, 92 | `comissao_pct` cadastrável — **nunca usado em cálculo** (campo morto) |
| Meta mensal | `src/routes/cliente_portal.js` | 82-118 | `cliente_metas.meta_gmv` (mensal) — sem meta_gmv_hora |
| Billing | `src/jobs/billing_engine.js` | 61-119 | soma `lives.comissao_calculada` → boleto Asaas |
| Testes comissão | `test/lives_manual.test.js` | 59-160 | cobre `fat_gerado * pct/100` via contrato |

### Frontend (Flutter)

| Área | Arquivo | Linhas | Estado |
|---|---|---|---|
| KPIs topo cliente | `lib/screens/painel_cliente/cliente_dashboard_screen.dart` | 333-376 | Faturamento, Lives, Horas, Ticket médio |
| Cards de lives | idem | 1458-1650 | duração, GMV, itens, pedidos, viewers, comentários, likes, shares, ROAS, investido |
| null → 0 | `lib/providers/cliente_dashboard_provider.dart` | 11-18 | `_toDouble`/`_toInt` retornam 0 em null |
| Model live | idem | 248-331 | sem comissão, clicks, status operacional, problema, próxima ação |
| Design system | `lib/design_system/` | — | cores semânticas success/warning/danger/info prontas p/ badges |

### Schema (migrations 001-051, próxima = 052)

| Tabela | Tem | Falta |
|---|---|---|
| `lives` (007, 029, 050) | status (em_andamento/encerrada/cancelada), fat_gerado, comissao_calculada, final_* (viewers/likes/comments/shares/orders) | clicks, status_operacional, problema, proxima_acao, comissao_apresentadora_pct, comissao_apresentadora_valor |
| `contratos` (004) | comissao_pct, valor_fixo | — (comissão LiveLab continua aqui) |
| `apresentadoras` (039) | comissao_pct, fixo, meta_diaria_gmv | — (campo existe, falta usar) |
| `clientes` (003+) | meta_diaria_gmv, status | meta_gmv_hora, margem_pct |
| `cliente_metas` (045) | meta_gmv mensal, UNIQUE(cliente,ano,mes) | **RLS ausente** (e sem tenant_id) |
| `live_snapshots` (013, 029) | viewer_count, gmv, total_orders, gifts, shares | clicks |
| `live_apresentadores` (043) | N:N live↔apresentador | **RLS ausente** |

## 2. Gaps confirmados (vs. painel desejado)

1. **"Não informado" vira 0** — backend `COALESCE(...,0)` + frontend `_toDouble/_toInt`→0. Impossível distinguir "sem venda" de "não medido".
2. **Comissão única** — só LiveLab (contrato). Comissão da apresentadora não existe no cálculo nem no dado da live.
3. **Sem regra fim de semana** — nenhum código de sábado/domingo 2% (grep weekend/sabado/domingo/getDay: só alinhamento de segunda em `cliente_portal.js:134`).
4. **Sem meta_gmv_hora** — só meta mensal (`cliente_metas.meta_gmv`) e `meta_diaria_gmv`.
5. **Sem status operacional / diagnóstico / próxima ação** — nem coluna, nem motor, nem UI.
6. **Sem clicks** — funil views→cliques→pedidos impossível.
7. **Sem margem** — nem coluna nem cálculo.
8. **Sem PDF** — nenhuma dependência (pdfkit/puppeteer no back; pdf/printing no pubspec) nem rota de relatório. O gerador precisa ser criado.
9. **RLS ausente** em `cliente_metas` e `live_apresentadores` (achado de segurança colateral — corrigir na migration 052).

## 3. Decisões de implementação (fases 2-8)

- `comissao_livelab` = `contratos.comissao_pct` (fonte única, sem duplicar em clientes — evita divergência).
- `comissao_apresentadora`: pct = `apresentadoras.comissao_pct`; **se a live inicia em sábado/domingo (America/Sao_Paulo), pct = 2%** (override). Valor gravado na live no encerramento/edição, igual ao padrão da comissão LiveLab.
- `meta_gmv_hora` em `clientes`, default 500. `margem_pct` nullable (obrigatória p/ status OK).
- API passa a retornar **null real** para campo não informado (clicks, margem, comissão não configurada) — zero só quando medido como zero.
- Motor de status: função pura `calcularStatusOperacional()` — Dados incompletos > Crítico > Atenção > OK.
- Frontend e PDF consomem a verdade do backend, sem recalcular regra.

## 4. Ordem das fases

| Fase | Entrega | Risco |
|---|---|---|
| 1 | Este doc | — |
| 2 | Migration 052 (colunas + RLS faltante) | médio (aditivo, nullable) |
| 3 | Comissão dupla + regra fim de semana + testes | alto (billing) |
| 4 | Motor de status (função pura + testes) | baixo |
| 5 | Métricas operacionais no backend (null real, GMV/h vs meta) | médio |
| 6 | Endpoint sessões de live | médio |
| 7 | Frontend primeira dobra + tabela sessões + "não informado" | médio |
| 8 | Relatório PDF | baixo |
