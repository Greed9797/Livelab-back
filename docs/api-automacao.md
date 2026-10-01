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

Toda chave tem um **escopo**, escolhido na criação e fixo depois:

| Escopo | Papel da chave | Alcança |
|---|---|---|
| `operacional` (padrão) | `automacao` | Lives, marcas, apresentadoras, import do TikTok — a lista logo abaixo |
| `financeiro` | `automacao_financeiro` | Só lançamentos financeiros — ver [Financeiro](#financeiro) |

Um escopo não enxerga as rotas do outro: a chave operacional leva 403 em todo o
financeiro, e a financeira leva 403 em lives, marcas, apresentadoras e usuários.
Quem precisa dos dois cria duas chaves.

Respostas de recusa:

| Código | O que aconteceu |
|---|---|
| 401 | Chave inexistente, revogada ou vencida |
| 403 | A chave é válida, mas essa rota não está liberada para chave |
| 413 | Arquivo maior que o teto desta entrada |
| 429 | Muitas chamadas por minuto (a cota é por chave) |

## O que a chave alcança (escopo operacional)

Só o que está nesta lista. Qualquer outra rota responde 403, inclusive `DELETE`
de qualquer coisa, financeiro (que tem chave própria, de escopo `financeiro`),
contratos, usuários e configurações.

| Método | Rota | Para quê |
|---|---|---|
| `POST` | `/v1/analytics/imports/ingest` | Mandar o relatório do TikTok e aplicar |
| `POST` | `/v1/analytics/imports/preview` | Só analisar, sem aplicar |
| `GET` | `/v1/analytics/imports/:id` | Ver o lote e o estado de cada linha |
| `GET` | `/v1/analytics/imports` | Listar lotes de import |
| `GET` | `/v1/lives` · `/v1/lives/:id` | Ler lives |
| `POST` | `/v1/lives/manual` | Cadastrar live já encerrada (data, hora, GMV, pedidos) |
| `POST` | `/v1/lives` | Iniciar live ao vivo numa cabine |
| `PATCH` | `/v1/lives/:id` | Editar live |
| `GET` `POST` `PATCH` | `/v1/marcas` · `/v1/marcas/:id` | Ler, cadastrar e editar marca |
| `GET` `PATCH` | `/v1/apresentadoras` · `/v1/apresentadoras/:id` | Ler e editar apresentadora (não há cadastro por API: apresentadora nasce do convite de usuário no painel) |
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

## Cadastrar live já encerrada

`POST /v1/lives/manual` registra uma live que já aconteceu, com o número
fechado. A comissão da apresentadora é calculada na hora.

```bash
curl -X POST "$BASE/v1/lives/manual" \
  -H "X-API-Key: $CHAVE" -H "Content-Type: application/json" \
  -d '{"cabine_id":"<uuid>","marca_id":"<uuid>","apresentador_id":"<uuid>",
       "data":"2026-09-01","hora_inicio":"19:00","hora_fim":"22:00",
       "fat_gerado":"12500.00","qtd_pedidos":140}'
```

Campos: `cabine_id`, `data` (AAAA-MM-DD), `hora_inicio` e `hora_fim` (HH:MM,
horário de São Paulo), `fat_gerado` e `qtd_pedidos` são obrigatórios; `marca_id`
ou `cliente_id` identifica de quem é a live; `apresentador_id`, `apresentador2_id`,
`resumo` e os `manual_*` (views, likes, comments, shares, orders, gmv) são
opcionais. `POST /v1/lives` (sem `/manual`) é outra coisa: abre uma live ao vivo
numa cabine agora.

## Cadastrar marca

```bash
curl -X POST "$BASE/v1/marcas" \
  -H "X-API-Key: $CHAVE" -H "Content-Type: application/json" \
  -d '{"nome":"Marca Nova","tipo":"afiliada","status":"ativa"}'
```

Antes de criar, procure pelo nome em `GET /v1/marcas` — "Haag" e "HAAG" viram
duas marcas diferentes se ninguém olhar, e a partir daí o GMV do mês se divide
entre as duas sem que nada acuse o problema.

## O que fica registrado: a tag BOT

Tudo que a chave **cria** nasce com `origem_dados = "bot"`: live (por `manual`,
por `iniciar` ou criada pelo `ingest`), marca, lote de import e revisão de GMV.
O campo volta em todo `GET` e o painel mostra o chip **BOT** nesses registros.
Mandar `origem_dados` no body não muda nada: quem decide é a chave.

O que uma pessoa criou continua `manual` mesmo que a chave edite depois — a
edição fica no histórico de GMV (`GET /v1/lives/:id/historico-gmv`, linha com
`origem_dados = "bot"`) e no log de auditoria, identificada com o nome da chave.

## Financeiro

Chave de escopo `financeiro` (papel `automacao_financeiro`). Serve para uma
automação ler os lançamentos e lançar/baixar custos e receitas — conciliar um
extrato, importar contas a pagar, marcar o que foi pago. Ela **não** alcança
nada do escopo operacional (lives, marcas, apresentadoras, usuários).

> **Segurança.** Esta chave move dinheiro previsto e pago: cria custos, dá baixa
> em contas, marca receitas como recebidas e muda o caixa e o DRE da unidade.
> Trate-a como senha de banco: guarde só num cofre de segredos (variável de
> ambiente do servidor da automação, secret manager), nunca em código,
> planilha, chat ou log. Se vazar — ou houver dúvida — revogue na hora
> (`POST /v1/api-keys/:id/revogar`) e crie outra. Toda ação dela fica no log de
> auditoria com `via = "api_key"` e o nome da chave.

### Criar a chave

Só um administrador logado (`franqueador_master`, `franqueado` ou `gerente`)
cria chave — com o token de sessão dele, não com outra chave:

```bash
curl -X POST "$BASE/v1/api-keys" \
  -H "Authorization: Bearer $TOKEN_DO_ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"nome":"Conciliação bancária","escopo":"financeiro"}'
```

```json
{ "id": "…", "nome": "Conciliação bancária", "prefixo": "llk_…", "papel": "automacao_financeiro",
  "escopo": "financeiro", "criado_em": "…", "expira_em": null, "chave": "llk_…" }
```

`chave` aparece **só nesta resposta** — o banco guarda apenas o hash. Perdeu,
crie outra e revogue esta. `expira_em` (ISO 8601) é opcional; sem ele a chave
não vence. Sem `escopo`, a chave nasce operacional. `GET /v1/api-keys` lista as
chaves com `papel` e `escopo`.

### Rotas liberadas

Os ids nas rotas têm formato fixo; qualquer outro leva 403 antes de chegar à
rota:

| Placeholder | Formato |
|---|---|
| `:id` | uuid |
| `:vid` | uuid, `calc:<marca_uuid>:<AAAA-MM>:<fixo\|comissao>` (receita só calculada) ou `rec:<recorrente_uuid>:<AAAA-MM>` (custo recorrente ainda não gerado) |
| `:mes` | `AAAA-MM`, mês de 01 a 12 |
| `:componente` | `fixo` ou `variavel` |

| Método | Rota | Para quê |
|---|---|---|
| `GET` | `/v1/financeiro/lancamentos` | Receitas + custos + apresentadoras + imposto, com status. Query: `mes` ou `inicio`/`fim` (AAAA-MM), `natureza` (`receita`\|`custo`), `status`, `grupo`, `classe`, `origem`, `q` |
| `GET` | `/v1/financeiro/caixa` | Saldo de caixa. Query: `ate` (AAAA-MM-DD) |
| `GET` | `/v1/financeiro/receita` | Receita do mês (competência × vencimento). Query: `mes` |
| `GET` | `/v1/financeiro/dre/mes` | DRE do mês. Query: `mes` |
| `GET` | `/v1/financeiro/resumo` | Resumo da unidade. Query: `inicio`/`fim` (AAAA-MM) ou `mes`+`ano` |
| `GET` | `/v1/financeiro/fluxo-caixa` | Fluxo de caixa do mês. Query: `mes`, `saldo_inicial` |
| `GET` | `/v1/financeiro/receitas` | Títulos a receber das marcas. Query: `mes` ou `inicio`/`fim`, `status`, `componente`, `marca_id`, `cliente_id` |
| `GET` | `/v1/financeiro/receitas-avulsas` | Receitas fora das marcas. Query: `mes` ou `inicio`/`fim`, `grupo`, `status` |
| `GET` | `/v1/financeiro/custos` | Custos (pontuais, parcelas e recorrentes). Query: `mes` ou `inicio`/`fim` |
| `GET` | `/v1/financeiro/custos-recorrentes` | Cadastro dos recorrentes |
| `GET` | `/v1/financeiro/apresentadoras-pagamentos` | Fixo/variável das apresentadoras. Query: `mes` |
| `POST` | `/v1/financeiro/custos` | Custo pontual |
| `POST` | `/v1/financeiro/custos/parcelado` | Custo em N parcelas |
| `POST` | `/v1/financeiro/custos-recorrentes` | Custo recorrente (aluguel, assinatura) |
| `POST` | `/v1/financeiro/custos/gerar?mes=` | Materializa os recorrentes do mês (idempotente) |
| `POST` | `/v1/financeiro/custos/importar` | Carga em massa idempotente, com `dry_run` |
| `POST` | `/v1/financeiro/receitas/gerar?mes=` | Materializa os títulos a receber do mês |
| `POST` | `/v1/financeiro/receitas-avulsas` | Receita avulsa (serviço, reembolso, aporte) |
| `PATCH` | `/v1/financeiro/custos/:vid` | Editar custo |
| `PATCH` | `/v1/financeiro/custos/:vid/pagar` · `/desfazer` | Baixa do custo / desfazer baixa |
| `PATCH` | `/v1/financeiro/custos-recorrentes/:id` | Editar recorrente (inclusive `ativo: false` para encerrar) |
| `PATCH` | `/v1/financeiro/receitas/:vid/receber` · `/desfazer` | Baixa do título a receber / desfazer |
| `PATCH` | `/v1/financeiro/receitas-avulsas/:id` | Editar receita avulsa |
| `PATCH` | `/v1/financeiro/receitas-avulsas/:id/receber` · `/desfazer` | Baixa / desfazer |
| `PATCH` | `/v1/financeiro/apresentadoras-pagamentos/:id/:mes/:componente/pagar` · `/desfazer` | Pagar fixo ou variável da apresentadora (`:id` = apresentadora) |
| `PATCH` | `/v1/financeiro/impostos/:mes/pagar` · `/desfazer` | Pagar o imposto do mês / desfazer |

No `:vid`, use o `:` sem codificar (`calc:…`). Se o cliente HTTP codificar
como `%3A`, também funciona.

### O que NÃO é liberado, e por quê

| Fora | Motivo |
|---|---|
| `DELETE` de qualquer coisa | Apagar lançamento some com a trilha do dinheiro. A automação corrige com `PATCH` ou desfaz a baixa; apagar é de gente no painel |
| `/v1/financeiro/config` (GET e PATCH) | Saldo de abertura, data de corte e alíquota do imposto mudam o caixa e o DRE de todos os meses de uma vez |
| `/v1/financeiro/apresentadoras-pagamentos/config` e as rotas sem `:componente` | Regra de vencimento das apresentadoras é configuração; as rotas legadas foram substituídas pela versão com componente |
| `/v1/asaas/*` | Gateway de pagamento e conciliação bancária mexem com credencial e cobrança real |
| `/v1/api-keys*` | Uma chave não cria nem revoga chave |
| `/v1/financeiro/operacional`, `/faturamento`, visão franqueadora, fechamento e adicionais de apresentadoras, relatórios CSV, recálculo de comissão | Fora do caso de uso (lançar e baixar); leitura consolidada fica para quem está no painel |
| Contratos, configurações, usuários, lives, marcas, apresentadoras | Outro escopo — não é para isso que a chave existe |

### Exemplos

Listar os lançamentos de setembro (só custos em aberto):

```bash
curl "$BASE/v1/financeiro/lancamentos?mes=2026-09&natureza=custo&status=pendente" \
  -H "X-API-Key: $CHAVE_FIN"
```

Cada item traz `id`, `origem` (`marca_fixo`, `marca_comissao`, `avulsa`,
`manual`, `recorrente`, `parcela`, `apresentadora`, `imposto`), `valor_previsto`,
`valor_pago`, `status` e `virtual`. O `id` diz qual rota dá a baixa:

| `origem` / formato do `id` | Baixa |
|---|---|
| `marca_fixo`, `marca_comissao` — uuid ou `calc:…` | `PATCH /v1/financeiro/receitas/:vid/receber` |
| `avulsa` — uuid | `PATCH /v1/financeiro/receitas-avulsas/:id/receber` |
| `manual`, `parcela`, `recorrente` — uuid ou `rec:…` | `PATCH /v1/financeiro/custos/:vid/pagar` |
| `apresentadora` — `apresentadora:<uuid>:<AAAA-MM>:<componente>` | `PATCH /v1/financeiro/apresentadoras-pagamentos/<uuid>/<AAAA-MM>/<componente>/pagar` |
| `imposto` — `imposto:<AAAA-MM>` | `PATCH /v1/financeiro/impostos/<AAAA-MM>/pagar` |

Criar custo pontual:

```bash
curl -X POST "$BASE/v1/financeiro/custos" \
  -H "X-API-Key: $CHAVE_FIN" -H "Content-Type: application/json" \
  -d '{"descricao":"Conta de energia","valor":"450.90","grupo":"estrutural",
       "competencia":"2026-09","data_vencimento":"2026-09-15","observacao":"Celesc"}'
```

Campos: `descricao` e `valor` (> 0) obrigatórios, e pelo menos um de
`competencia` (AAAA-MM ou AAAA-MM-DD) e `data_vencimento` (AAAA-MM-DD).
`grupo`: `operacional`, `estrutural`, `diversos` (padrão), `investimento`,
`prolabore`, `marketing`, `ferramentas`, `cartao`, `aporte`, `outros`.
Opcionais: `observacao`, `classe_custo` (`fixo`\|`variavel`), e `valor_pago` +
`data_pagamento` para já nascer pago.

Criar custo recorrente:

```bash
curl -X POST "$BASE/v1/financeiro/custos-recorrentes" \
  -H "X-API-Key: $CHAVE_FIN" -H "Content-Type: application/json" \
  -d '{"nome":"Aluguel da sala","valor":3500,"grupo":"estrutural",
       "dia_vencimento":10,"mes_offset":0,"inicio":"2026-09-01","fim":null}'
```

`nome`, `valor` e `inicio` obrigatórios; `dia_vencimento` (1–31, padrão 5),
`mes_offset` (0 = vence no mês da competência, 1 = no seguinte), `fim`,
`descricao`, `ativo` e `classe_custo` opcionais. O recorrente aparece em todo
mês como `rec:<id>:<AAAA-MM>` até ser gerado (`POST /v1/financeiro/custos/gerar?mes=2026-09`)
ou baixado — a baixa materializa o lançamento sozinha.

Custo parcelado (cartão):

```bash
curl -X POST "$BASE/v1/financeiro/custos/parcelado" \
  -H "X-API-Key: $CHAVE_FIN" -H "Content-Type: application/json" \
  -d '{"descricao":"Notebook","parcelas":10,"valor_total":"6990.00",
       "grupo":"cartao","competencia":"2026-09","data_vencimento":"2026-09-05"}'
```

`parcelas` (1–120) e **um** de `valor_total` ou `valor_parcela`. As parcelas
saem como `Notebook (1/10)`, `(2/10)`… em meses seguidos.

Lançar receita avulsa:

```bash
curl -X POST "$BASE/v1/financeiro/receitas-avulsas" \
  -H "X-API-Key: $CHAVE_FIN" -H "Content-Type: application/json" \
  -d '{"descricao":"Workshop de live commerce","grupo":"servico",
       "valor_previsto":"1200.00","data_vencimento":"2026-09-20","competencia":"2026-09"}'
```

`descricao`, `valor_previsto` e `data_vencimento` obrigatórios. `grupo`:
`servico`, `reembolso`, `outros` (padrão) ou `aporte` (entrada de caixa que não
é receita operacional — fica fora do DRE e da base do imposto). Opcionais:
`competencia`, `observacao`, `valor_pago` + `data_pagamento`. Campo
desconhecido é recusado (400).

Dar baixa — pagar custo (sem corpo = valor previsto, hoje):

```bash
curl -X PATCH "$BASE/v1/financeiro/custos/<uuid>/pagar" \
  -H "X-API-Key: $CHAVE_FIN" -H "Content-Type: application/json" \
  -d '{"valor_pago":"450.90","data_pagamento":"2026-09-14"}'

# recorrente ainda não gerado: a baixa materializa o lançamento
curl -X PATCH "$BASE/v1/financeiro/custos/rec:<recorrente_uuid>:2026-09/pagar" \
  -H "X-API-Key: $CHAVE_FIN" -H "Content-Type: application/json" -d '{}'
```

Receber receita de marca — título já gerado (uuid) ou só calculado (`calc:`):

```bash
curl -X PATCH "$BASE/v1/financeiro/receitas/calc:<marca_uuid>:2026-09:fixo/receber" \
  -H "X-API-Key: $CHAVE_FIN" -H "Content-Type: application/json" \
  -d '{"valor_pago":"5000.00","data_pagamento":"2026-09-10","observacao":"PIX"}'

curl -X PATCH "$BASE/v1/financeiro/receitas/<titulo_uuid>/receber" \
  -H "X-API-Key: $CHAVE_FIN" -H "Content-Type: application/json" -d '{}'
```

Receber receita avulsa: `PATCH /v1/financeiro/receitas-avulsas/<uuid>/receber`
com `{"valor_pago"?, "data_pagamento"?}`.

Pagar apresentadora, por componente (`fixo` ou `variavel`); sem `valor_pago`,
paga o previsto daquele componente:

```bash
curl -X PATCH "$BASE/v1/financeiro/apresentadoras-pagamentos/<apresentadora_uuid>/2026-09/variavel/pagar" \
  -H "X-API-Key: $CHAVE_FIN" -H "Content-Type: application/json" \
  -d '{"valor_pago":"850.00","data_pagamento":"2026-10-05","observacao":"comissão set/26"}'
```

Pagar o imposto do mês (sem `valor_pago` = valor calculado):

```bash
curl -X PATCH "$BASE/v1/financeiro/impostos/2026-09/pagar" \
  -H "X-API-Key: $CHAVE_FIN" -H "Content-Type: application/json" \
  -d '{"data_pagamento":"2026-10-20"}'
```

Errou a baixa? Cada uma tem `/desfazer` (`PATCH`, sem corpo) — volta o
lançamento para aberto sem apagar nada.

Importar em massa (até 200 recorrentes e 200 pontuais por chamada). Item que já
existe — mesmo nome+grupo+dia no recorrente; mesma descrição+vencimento+valor no
pontual — é ignorado, nunca alterado, então reenviar não duplica. Rode primeiro
com `"dry_run": true` para ver o que seria criado:

```bash
curl -X POST "$BASE/v1/financeiro/custos/importar" \
  -H "X-API-Key: $CHAVE_FIN" -H "Content-Type: application/json" \
  -d '{"dry_run":true,
       "recorrentes":[{"nome":"Internet","grupo":"ferramentas","valor":"199.90",
                       "dia_vencimento":12,"inicio":"2026-09-01","fim":null}],
       "pontuais":[{"descricao":"Câmera — parcela 1/3","grupo":"cartao","valor":"800.00",
                    "data_vencimento":"2026-09-05","competencia":"2026-09",
                    "parcela_num":1,"parcelas_total":3}]}'
```

No recorrente importado, `grupo`, `dia_vencimento` e `fim` (ou `null`) são
obrigatórios; no pontual, `grupo`, `data_vencimento` e `competencia`.
A resposta traz `criados`, `ignorados` e a ação de cada item.

Valores em dinheiro aceitam número (`450.9`) ou texto (`"450.90"`). No
pagamento de apresentadora, o texto não pode ter separador de milhar
(`"1234.56"` ou `"1234,56"`, até duas casas).

## CLI: `livelab.py`

Um arquivo Python 3 (só biblioteca padrão, sem `pip`) que embrulha tudo acima.
Serve para rodar no terminal de uma VM.

```bash
curl -fsSLO https://raw.githubusercontent.com/Greed9797/Livelab-back/codex/blumenau-operational-fase1/cli/livelab.py
export LIVELAB_API_KEY=llk_...          # obrigatória; nunca vai para arquivo
# LIVELAB_API_URL=...                  # opcional; padrão é a produção
python3 livelab.py rotas                # o que a chave alcança
python3 livelab.py --help
```

Comandos:

```bash
python3 livelab.py api GET /v1/lives -q data_inicio=2026-09-01 -q status=encerrada
python3 livelab.py api POST /v1/marcas -d '{"nome":"Marca X","tipo":"afiliada"}'
python3 livelab.py api PATCH /v1/lives/<uuid> -f corpo.json     # -f - lê stdin
python3 livelab.py ingest relatorio.xlsx --marca-id <uuid> --apresentadora-id <uuid> [--criar-lives] [--preview]
python3 livelab.py lives list|get <id>|criar|editar <id>       # criar = POST /v1/lives/manual
python3 livelab.py marcas list|get <id>|criar|editar <id>
python3 livelab.py apresentadoras list|get <id>|editar <id>
python3 livelab.py comissoes list -q mes=2026-09
python3 livelab.py imports list|get <id>
```

`api` aceita a rota com ou sem `/v1` na frente. Os comandos nomeados só escolhem
método e rota e aceitam os mesmos `-q`, `-d` e `-f`; `python3 livelab.py marcas --help`
lista os campos do body.

Saída: o JSON da API em stdout. Códigos de saída:

| Código | Significado |
|---|---|
| 0 | 2xx |
| 1 | A API recusou; stderr traz `{"status": ..., "error": ...}`. No 403 vem a dica de olhar `rotas` |
| 2 | Uso errado: chave ausente, JSON inválido, arquivo do `ingest` acima de 5 MB |
| 3 | Rede, DNS ou timeout (60 s) |

`--verbose` imprime método, URL e status em stderr. A chave nunca é impressa.
