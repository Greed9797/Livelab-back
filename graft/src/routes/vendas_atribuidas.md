# src/routes/vendas_atribuidas.js

- calcularComissoesAtribuidas · function · L21-L76 — async function calcularComissoesAtribuidas(db, { tenantId, marcaId, apresentadoraId, origem, origemId, data, gmv, comissaoApresentadora, comissaoFranquia, comissaoFranqueadora, })
- upsertVendaAtribuida · function · L78-L139 — async function upsertVendaAtribuida(db, payload)
- movimentoFinanceiroFechado · function · L143-L154 — async function movimentoFinanceiroFechado(db, venda, tenantId)
- sincronizarSnapshotDaVenda · function · L157-L160 — async function sincronizarSnapshotDaVenda(db, tenantId, venda)
- recalcularVendasAtribuidasApresentadora · function · L167-L251 — async function recalcularVendasAtribuidasApresentadora(db, { tenantId, apresentadoraId, mesReferencia })
- vendasAtribuidasRoutes · function · L253-L369 — async function vendasAtribuidasRoutes(app)
- add · function · L264-L267 — add = (sql, value)
