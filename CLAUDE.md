# Livelab Back — CLAUDE.md

API da franquia de live-commerce Livelab (Blumenau/SC). Leia também `AGENTS.md` (uso do `graft/`, o grafo de contexto do repo — consulte-o antes de grepar).

## Stack
- **Runtime:** Node.js 20 + Fastify (ESM)
- **Banco:** PostgreSQL com Row Level Security (RLS) por `tenant_id`
- **Auth:** JWT (access + refresh) e chaves de API (`X-API-Key`, com escopo), plugin em `src/plugins/auth.js`
- **Testes:** vitest

## Branch e deploy (produção)
- **Branch de produção: `codex/blumenau-operational-fase1`.** O merge nela publica no Railway: `preDeployCommand` roda `node apply_migrations.js` e o healthcheck é `GET /readyz`. Merge nessa branch só com ok do dono.
- `master` é a branch default do GitHub, mas está **defasada** (centenas de commits atrás). Não use como base.
- Conferir produção: `https://liveshop-saas-api-production.up.railway.app/readyz` → `{"ok":true}`.
- O Render (`livelabackend.onrender.com`) está morto; não usar.

## Comandos
```bash
npm ci
npm run dev                 # nodemon src/server.js
npx vitest run              # suíte unitária (~1800 testes)
node --check apply_migrations.js
```

Testes com Postgres real (`test/*.pg.test.js`) só rodam com `TEST_PG_URL` e precisam de `--no-file-parallelism`:
```bash
# banco do zero: schema base + todas as migrations
ALLOW_FRESH_SCHEMA_SETUP=true DATABASE_URL=postgres://... node scripts/setup_fresh_schema.js
DATABASE_URL=postgres://... node apply_migrations.js
TEST_PG_URL=postgres://... npx vitest run --no-file-parallelism test/*.pg.test.js
```
`npm run test:integration` (PGlite) falha em `assiduidade_union` (`l.arquivada_em`) desde antes de out/2026; não é regressão sua.

## Migrations
- SQL numeradas em `migrations/`. **Última: `179_condicoes_comissao_janela.sql` → a próxima é `180_*`.**
- Toda migration nova precisa entrar **no fim** de `MIGRATIONS_LIST` em `apply_migrations.js`; senão não roda.
- Cada arquivo roda numa transação e deve ser **idempotente** (`IF NOT EXISTS`, `DO $$ … $$` para constraints). Teste aplicando duas vezes.
- Migration que altera/apaga dado de produção guarda backup em tabela própria com RLS ligada (ex.: `migr176_lives_cliente_id_backup`, `receita_titulos_removidos_178`) e documenta o rollback em `docs/ops/`.
- Antes de criar, confira se outra branch aberta não usa o mesmo número (em out/2026 duas entregas criaram 174–176 diferentes).

## Modelo de negócio
- Franqueados são tenants isolados — apresentadoras, clientes e cabines NÃO são compartilhados.
- Apresentadoras pertencem a 1 franqueado fixo.
- Painel master (`franqueador_master`) enxerga todos os tenants.
- **Cadastro unificado:** a marca é a entidade; cliente é a ficha 1:1 de uma marca `tipo='cliente'`. Endpoint `GET/POST/PATCH /v1/cadastros` (`src/routes/cadastros.js`, `src/services/cadastros.js`). Criação/edição pelas telas ainda usa `/v1/clientes` e `/v1/marcas`. `lives.cliente_id` é herdado da marca por gatilho (migration 175).

## Dinheiro — regras que não podem quebrar
- **Só marca que gera receita vira receita:** `marcaGeraReceitaSql()` em `src/lib/receita-marca-sql.js` = `tipo = 'cliente'` e não-sistema. Marca afiliada/própria/parceira/sistema não gera fixo nem comissão de franquia (caso "Rosa do Deserto").
- **Marca → franqueadora:** fixo e/ou `gmv × comissao_franquia_pct/100`, conforme `tipo_cobranca` da condição comercial vigente (`marca_condicoes_comerciais`, versionada por competência).
- **Janela de comissão:** `comissao_janela_inicio_dia` (1–28, default 1 = mês civil). Com N > 1, a competência é o mês em que a janela começa. Mudar a janela de uma versão que já tem títulos → 400 `JANELA_RETROATIVA` (crie nova versão).
- **Fim de contrato:** cancelar/arquivar cliente ou marca grava `marcas.data_fim` e apaga só os `receita_titulos` futuros sem pagamento (`src/lib/marca-lifecycle-sql.js`). Marca pausada continua cobrando.
- **Apresentadora:** remuneração do mês = fixo + comissão + adicionais (`src/services/remuneracao-apresentadoras.js`). A comissão é o GMV rateado × percentual da faixa, que vem de `src/services/presenter-commission.js` (faixas, mínimo e override de fim de semana). O cálculo por live é feito em `src/services/commission-engine.js`, com upsert em `vendas_atribuidas`, que entra como `status_aprovacao = 'pendente_aprovacao'`.
- Item perdido/cancelado não aceita pagamento (409); reative antes de dar baixa.
- Escritas que mudam dinheiro devem invalidar o cache do tenant (`invalidateTenant` em `src/lib/dashboard-cache.js`).
- Referência completa: `docs/financeiro.md` e `docs/api-automacao.md`.

## Padrões de código
```js
// Toda rota usa withTenant + tenant_id do JWT
app.get('/v1/rota', { preHandler: [app.authenticate, app.requirePapel(ROLES)] }, async (request) => {
  const { tenant_id } = request.user
  return app.withTenant(tenant_id, async (db) => {
    const result = await db.query('SELECT ... WHERE tenant_id = $1::uuid', [tenant_id])
    return result.rows
  })
})
```

## Ao adicionar uma nova rota
1. Criar `src/routes/nome.js` exportando `async function nomeRoutes(app)`.
2. Importar e registrar em `src/app.js`: `await app.register(nomeRoutes)`.
3. Migration se houver mudança de schema (ver acima).
4. Permissões em `src/config/role_groups.js`; se a rota aceitar chave de API, liberar na allowlist de `src/plugins/auth.js`.

## Documentos úteis
- `docs/financeiro.md` — regras do financeiro (receita, DRE, caixa, perdas, cadastro unificado).
- `docs/ops/` — runbook de deploy, backup/restore, consultas de diagnóstico e scripts de rollback.
- `docs/specs/` — specs ainda não implementadas (ex.: briefing do cliente).
