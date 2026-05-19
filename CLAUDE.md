# Livelab Back — CLAUDE.md

## Stack
- **Runtime:** Node.js + Fastify
- **Banco:** PostgreSQL com Row Level Security (RLS) por `tenant_id`
- **Auth:** JWT (access + refresh token), plugin em `src/plugins/auth.js`
- **Migrations:** SQL numeradas em `migrations/` — próxima: `085_*`

## Modelo de negócio
- Franqueados são tenants isolados — apresentadoras, clientes e cabines NÃO são compartilhados
- Apresentadoras pertencem a 1 franqueado fixo
- Painel master (`franqueador_master`) enxerga todos os tenants

## Comissão (regras atuais)
- **Marca → Franqueadora:** `MAX(marca.valor_fixo_minimo, gmv × marca.comissao_franqueadora_pct/100)`
- **Apresentadora:** `MAX(apresentadora.valor_fixo_mensal, Σ(gmv × faixa_pct))` — faixa determinada pelo GMV acumulado do mês
- Engine: `src/services/commission-engine.js` — disparado no encerramento de live
- Resultado salvo em `vendas_atribuidas` com workflow de aprovação (`status_aprovacao`)

## Tabelas principais
| Tabela | Descrição |
|---|---|
| `tenants` | Franquias/franqueados |
| `users` | Usuários com papel (franqueador_master, franqueado, operacional, apresentador, cliente_parceiro) |
| `apresentadoras` | Perfil operacional — tem `user_id` FK para users |
| `cabines` | Estações de live por franqueado |
| `lives` | Sessões de live — FK para cabine, apresentadora, cliente |
| `marcas` | Marcas promovidas (tipo: cliente\|afiliada) — com comissão configurável |
| `vendas_atribuidas` | Registro de comissões calculadas por live/video |
| `apresentadora_faixas_comissao` | Faixas progressivas de GMV → % comissão por apresentadora |
| `metas_apresentadora` | Meta mensal de GMV por apresentadora |
| `metas_supervisor` | Meta consolidada do franqueado |

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

## Rotas disponíveis
- `POST/GET/PATCH/DELETE /v1/apresentadoras` — CRUD + faixas em `/v1/apresentadoras/:id/faixas`
- `GET /v1/ranking/apresentadoras?mes=YYYY-MM` — ranking por ganho total
- `GET/PUT/DELETE /v1/metas` — metas mensais (apresentadora + supervisor)
- `GET /v1/marcas` — marcas com comissão configurável (valor_fixo_minimo, comissao_franqueadora_pct)
- `GET /v1/comissoes/*` — consulta e aprovação de comissões
- `GET /v1/lives` — lives com GMV e comissão calculada
- `GET /v1/agenda` — agenda de eventos por cabine

## Ao adicionar uma nova rota
1. Criar `src/routes/nome.js` exportando `async function nomeRoutes(app)`
2. Importar e registrar em `src/app.js`: `await app.register(nomeRoutes)`
3. Criar migration SQL se houver mudança de schema: `migrations/NNN_descricao.sql`
4. Adicionar permissões em `src/config/role_groups.js`
