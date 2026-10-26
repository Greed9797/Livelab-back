# CRM API

This guide records the CRM contract in the deployed backend commit
`894e903b57610b8a38431b3a1e220ecbe4499089`.

## Authentication and tenant scope

Send the existing session JWT as a bearer token:

```http
Authorization: Bearer <access-token>
```

Every lead query is scoped to the `tenant_id` in the authenticated session.
The API does not accept a client-supplied tenant ID for these routes. Read
routes require the `READ_LEADS` role group; mutations require `WRITE_LEADS`.
The role groups are defined in `src/config/role_groups.js`.

## Routes

| Method and path | Access | Behavior |
| --- | --- | --- |
| `GET /v1/crm/summary` | Read | Returns tenant CRM totals, pipeline stages, sources, and alerts. |
| `GET /v1/leads` | Read | Lists non-expired tenant leads; accepts optional `etapa`. |
| `GET /v1/leads/meus` | Read | Lists leads assigned to the current tenant that are not won or lost. |
| `GET /v1/leads/duplicados` | Read | Finds possible duplicates by `email`, `whatsapp`, or `nome`. |
| `GET /v1/leads/:id` | Read | Returns one lead with structured contacts, tasks, and stage history. |
| `POST /v1/leads` | Write | Creates a lead in the current tenant. |
| `PATCH /v1/leads/:id` | Write | Updates CRM fields and records stage changes. |
| `DELETE /v1/leads/:id` | Write | Deletes a tenant lead; returns `204` on success. |
| `POST /v1/leads/:id/contato` | Write | Adds a structured contact history entry. |
| `POST /v1/leads/:id/tarefa` | Write | Adds a structured task to a lead. |
| `POST /v1/leads/:id/ganhar` | Write | Converts a lead to an active client and contract. |

The canonical stage values are `lead_novo`, `contato_iniciado`,
`reuniao_agendada`, `proposta_enviada`, `em_negociacao`,
`aguardando_assinatura`, `ganho`, and `perdido`. A lead marked `perdido` must
include a non-empty `motivo_perda`.

## Lead fields

Create and update requests accept the supported CRM fields, including
`nome`, `nicho`, `cidade`, `estado`, `valor_oportunidade`,
`responsavel_nome`, `origem`, `crm_etapa`, `observacoes_internas`,
`motivo_perda`, `contato_email`, `contato_whatsapp`, and `dados_extras`.
Creation requires `nome` and also accepts `fat_estimado`; the update schema
does not accept `fat_estimado`. The API validates request bodies and returns HTTP
400 for invalid values. For an update, send at least one supported field.

Example:

```http
POST /v1/leads
Content-Type: application/json
Authorization: Bearer <access-token>

{
  "nome": "Loja Exemplo",
  "cidade": "Curitiba",
  "estado": "PR",
  "crm_etapa": "lead_novo",
  "valor_oportunidade": 2500,
  "origem": "indicação"
}
```

## Contacts and tasks

`POST /v1/leads/:id/contato` accepts `tipo` and `resumo`. The server adds the
authenticated user's identity and timestamp to the contact history.

`POST /v1/leads/:id/tarefa` accepts `titulo`, with optional `descricao`,
`responsavel_id`, `responsavel_nome`, `due_date`, and `concluida`. The server
uses the current user's name as the default responsible name.

## Convert a lead

`POST /v1/leads/:id/ganhar` accepts an optional `pacote_id`. In a database
transaction, it creates an active client and contract, then stores the client
ID in `convertido_cliente_id` and changes the lead stage to `ganho`. It returns
`{ "ok": true, "cliente_id": "..." }` after commit. A lead with an existing
`convertido_cliente_id` returns HTTP 409, preventing duplicate conversion.

Conversion is a local database operation. It does not synchronize the new
client with an external CRM automatically.

## Errors

Invalid payloads return HTTP 400. A missing lead in the active tenant returns
HTTP 404. Repeating a conversion for an already converted lead returns HTTP
409. Requests without a valid session or required role are rejected by the
shared authentication and authorization hooks.
