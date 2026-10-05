// Gate único de integração SQL isolada. Cada fixture cria e fecha seu próprio
// banco em memória; nenhuma delas usa DATABASE_URL ou dados de produção.
await import('./assiduidade_union.pglite.mjs')
await import('./marca_condicoes_schema.pglite.mjs')
await import('./marca_condicoes_service.pglite.mjs')
await import('./client_brand_lifecycle.pglite.mjs')
await import('./financeiro_liquidacoes_schema.pglite.mjs')
await import('./financeiro_liquidacoes_read.pglite.mjs')
await import('./financeiro_liquidacoes_command.pglite.mjs')
await import('./financeiro_perdas_schema.pglite.mjs')
await import('./financeiro_fechamentos.pglite.mjs')

console.log('PASS: all PGlite integration fixtures')
