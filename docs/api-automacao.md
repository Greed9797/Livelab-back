# API de automação — Livelab

Contrato da entrada de máquina: o que uma automação (bot, workflow, script) pode
fazer na API do Livelab e como. Foi escrito para caber inteiro no prompt de um
agente.

Base: `https://liveshop-saas-api-production.up.railway.app`

## Autenticação

Toda chamada leva a chave no cabeçalho:

```
X-API-Key: llk_...
```

A chave já está presa a uma unidade (tenant). Não existe parâmetro para escolher
outra: a automação só enxerga e escreve na unidade da própria chave.

A chave é criada e revogada por um administrador logado no painel
(`POST /v1/api-keys`, `POST /v1/api-keys/:id/revogar`). Uma chave não cria nem
revoga outra chave — nem a si mesma.

Respostas de recusa:

| Código | O que aconteceu |
|---|---|
| 401 | Chave inexistente, revogada ou vencida |
| 403 | A chave é válida, mas essa rota não está liberada para chave |
| 413 | Arquivo maior que o teto desta entrada |
| 429 | Muitas chamadas por minuto (a cota é por chave) |

## O que a chave alcança

Só o que está nesta lista. Qualquer outra rota responde 403, inclusive `DELETE`
de qualquer coisa, financeiro, boletos, contratos, usuários e configurações.

| Método | Rota | Para quê |
|---|---|---|
| `POST` | `/v1/analytics/imports/ingest` | Mandar o relatório do TikTok e aplicar |
| `POST` | `/v1/analytics/imports/preview` | Só analisar, sem aplicar |
| `GET` | `/v1/analytics/imports/:id` | Ver o lote e o estado de cada linha |
| `GET` | `/v1/lives` · `/v1/lives/:id` | Ler lives |
| `POST` `PATCH` | `/v1/lives` · `/v1/lives/:id` | Criar e editar live |
| `GET` `POST` `PATCH` | `/v1/marcas` | Ler e cadastrar marca |
| `GET` `POST` `PATCH` | `/v1/apresentadoras` | Ler e cadastrar apresentadora |
| `GET` | `/v1/comissoes` | Ler comissão calculada |

## Mandar o relatório do TikTok

`POST /v1/analytics/imports/ingest` aceita o arquivo de dois jeitos. Os dois
valem; use o que for mais fácil do lado de quem chama.

**Como JSON**, com o arquivo em base64:

```bash
curl -X POST "$BASE/v1/analytics/imports/ingest" \
  -H "X-API-Key: $CHAVE" \
  -H "Content-Type: application/json" \
  -d '{"filename":"live-performance.csv","content_base64":"TUFSQ0Es..."}'
```

Um CSV também pode ir como texto puro, em `content`, sem base64.

**Como multipart**, mandando o arquivo do jeito que veio do TikTok:

```bash
curl -X POST "$BASE/v1/analytics/imports/ingest" \
  -H "X-API-Key: $CHAVE" \
  -F "file=@live-performance.xlsx" \
  -F "marca_id=<uuid>" \
  -F "apresentadora_id=<uuid>"
```

Campos aceitos (em `-F`, na query string ou no JSON):

| Campo | Quando é obrigatório |
|---|---|
| `marca_id` | Sempre, no relatório **Creator Live Performance** (TikTok Studio), que não traz a marca no arquivo |
| `apresentadora_id` | Idem |
| `criar_lives` | Opcional. `true` faz o import criar live nova para a linha que não casou com nenhuma existente. Sem ele, essa linha fica pendente |

Formatos: CSV e XLSX, dos dois relatórios (TikTok Ads e Creator Live
Performance). O tipo é detectado pelo cabeçalho do arquivo — não precisa dizer
qual é. Nome de coluna com acento, maiúscula diferente ou variação conhecida é
tolerado.

Teto: **1.000 linhas por chamada**. Acima disso vem 413 e o arquivo precisa ser
dividido — tudo acontece numa requisição só, e um arquivo grande não termina
antes de a conexão ser cortada.

### A resposta

```json
{
  "ok": true,
  "duplicado": false,
  "batch_id": "…",
  "total_rows": 12,
  "applied_rows": 9,
  "gmv_preservado_rows": 1,
  "failed_rows": [],
  "pendentes": [
    { "row_index": 4, "marca": "HAAG", "data": "2026-08-19",
      "motivo": "mais de uma live candidata com sobreposicao parecida" }
  ]
}
```

- `applied_rows` — linhas que entraram: GMV, métricas e comissão gravados.
- `pendentes` — **linhas que a automação não aplicou de propósito.** Casamento
  fraco ou ambíguo não é decidido sozinho: elas ficam no lote, aparecem na tela
  de importação do painel e esperam uma pessoa resolver. Se alguém perguntar o
  que faltou, é esta lista.
- `gmv_preservado_rows` — lives cujo GMV alguém já tinha corrigido à mão. A
  correção humana vence a planilha, então esse valor foi mantido.
- `failed_rows` — linhas que deram erro na gravação, com o motivo. O lote
  continua reaplicável: as que já entraram não entram de novo.

### Reenviar o mesmo arquivo não duplica nada

O arquivo é identificado por uma impressão digital do conteúdo. Se o mesmo
arquivo voltar dentro de 24 horas, a resposta vem com `"duplicado": true` e o
`batch_id` do envio anterior — sem gravar nada de novo. Não é erro, e não há
motivo para tentar outra vez.

Um arquivo com uma linha a mais é um arquivo diferente e será processado
normalmente; as lives que já receberam dados não são duplicadas, porque o
casamento continua valendo.

## Cadastrar marca e apresentadora

```bash
curl -X POST "$BASE/v1/marcas" \
  -H "X-API-Key: $CHAVE" -H "Content-Type: application/json" \
  -d '{"nome":"Marca Nova","tipo":"afiliada","status":"ativa"}'
```

Antes de criar, procure pelo nome em `GET /v1/marcas` — "Haag" e "HAAG" viram
duas marcas diferentes se ninguém olhar, e a partir daí o GMV do mês se divide
entre as duas sem que nada acuse o problema.

## O que fica registrado

Toda escrita feita por chave entra no log de auditoria identificada como tal,
com o nome da chave. Quem olhar o histórico de uma live consegue distinguir o
que a automação fez do que uma pessoa fez.
