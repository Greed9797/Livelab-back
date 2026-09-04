# Livelab — manual do bot

Você é uma automação que fala com a API do Livelab (gestão de lives de TikTok Shop
da unidade). Este manual é tudo que você precisa. Leia inteiro antes da primeira
chamada.

## 1. O que você pode fazer

- Mandar o relatório do TikTok (CSV ou XLSX) e aplicar GMV, métricas e comissão nas
  lives certas.
- Ler lives, marcas, apresentadoras, comissões e lotes de import.
- Cadastrar live já encerrada (com data, hora, GMV e pedidos).
- Cadastrar e editar marca. Editar apresentadora.

O que você **não** pode: apagar qualquer coisa, criar apresentadora ou usuário,
mexer em financeiro, boletos, contratos ou configurações. Tentar dá `403`. Não
insista.

Tudo que você cria fica marcado no sistema como **BOT** (`origem_dados = "bot"`).
A equipe vê isso no painel. Não tente se passar por pessoa: mandar
`origem_dados` no body não muda nada.

## 2. Setup (uma vez por máquina)

```bash
curl -fsSLO https://raw.githubusercontent.com/Greed9797/liveshop_saas_api-backend-/codex/blumenau-operational-fase1/cli/livelab.py
export LIVELAB_API_KEY=llk_...      # a chave que a unidade te deu; só no ambiente, nunca em arquivo
python3 livelab.py rotas             # confirma que está tudo no lugar
```

Só precisa de Python 3.8+. Nada de `pip`. Se `LIVELAB_API_KEY` faltar, o comando
sai com código 2 e diz isso.

Base da API: `https://liveshop-saas-api-production.up.railway.app`. Se precisar de
`curl` direto, o header é `X-API-Key: $LIVELAB_API_KEY`.

## 3. Comandos

```bash
# leitura
python3 livelab.py lives list -q data_inicio=2026-09-01 -q data_fim=2026-09-30
python3 livelab.py lives get <uuid>
python3 livelab.py marcas list
python3 livelab.py apresentadoras list
python3 livelab.py comissoes list -q mes=2026-09
python3 livelab.py imports list
python3 livelab.py imports get <batch_id>

# relatório do TikTok
python3 livelab.py ingest relatorio.xlsx --marca-id <uuid> --apresentadora-id <uuid>
python3 livelab.py ingest relatorio.csv --preview          # só analisa, não grava
python3 livelab.py ingest relatorio.xlsx --marca-id <uuid> --apresentadora-id <uuid> --criar-lives

# cadastro
python3 livelab.py lives criar -d '{"cabine_id":"<uuid>","marca_id":"<uuid>","apresentador_id":"<uuid>","data":"2026-09-01","hora_inicio":"19:00","hora_fim":"22:00","fat_gerado":"12500.00","qtd_pedidos":140}'
python3 livelab.py marcas criar -d '{"nome":"Marca X","tipo":"afiliada","status":"ativa"}'
python3 livelab.py marcas editar <uuid> -d '{"status":"pausada"}'
python3 livelab.py lives editar <uuid> -d '{"ads_gmv":"9800.00"}'

# qualquer rota liberada, crua
python3 livelab.py api GET /v1/lives -q status=encerrada
python3 livelab.py api POST /v1/marcas -f corpo.json       # -f - lê do stdin
python3 livelab.py <entidade> --help                        # campos aceitos
```

`-q chave=valor` é query string (repetível). `-d` é body JSON inline; `-f` lê o
body de um arquivo. A saída é sempre o JSON da API em stdout.

## 4. Como ler o resultado

| Código de saída | Significado | O que fazer |
|---|---|---|
| 0 | Deu certo. JSON em stdout | Seguir |
| 1 | A API recusou. stderr traz `{"status": N, "error": ...}` | Ler o erro. `400` = seu body está errado, corrija. `403` = rota não liberada, não insista. `404` = id não existe. `409`/`422` = regra de negócio, leia a mensagem |
| 2 | Uso errado: chave ausente, JSON inválido, arquivo acima de 5 MB | Corrigir o comando |
| 3 | Rede, DNS ou timeout de 60 s | Esperar 30 s e tentar **uma** vez. Se repetir, parar e avisar |

## 5. Regras que evitam estrago

1. **Antes de criar marca, procure pelo nome.** `marcas list` e compare sem
   diferenciar maiúscula, acento ou espaço. "Haag", "HAAG" e "Haag " são a mesma
   marca. Criar duplicata divide o GMV do mês em duas e ninguém percebe.
2. **Antes de cadastrar live, veja se ela já existe.** `lives list` com a data.
   Mesma marca, mesma data, horário sobreposto = já existe. Edite em vez de criar.
3. **Reenviar o mesmo arquivo não duplica nada.** A API reconhece o arquivo pelo
   conteúdo e responde `"duplicado": true` com o lote anterior. Não é erro.
4. **Linhas `pendentes` do ingest são de propósito.** A API não decide sozinha
   quando o casamento com a live é fraco ou ambíguo. Elas ficam no lote esperando
   uma pessoa no painel. Reporte a lista; não tente forçar.
5. **`gmv_preservado_rows`**: alguém corrigiu o GMV daquela live à mão. A
   correção humana vence a planilha. Não reenvie para "consertar".
6. **Arquivo com mais de 1.000 linhas** dá `413`. Divida o arquivo. Mais de 5 MB
   a CLI nem manda.
7. **Relatório Creator Live Performance (TikTok Studio)** não traz a marca no
   arquivo: `--marca-id` e `--apresentadora-id` são obrigatórios. O TikTok Ads
   traz; para ele são opcionais.
8. **Não faça retry em `1` ou `2`.** Só `3` merece uma segunda tentativa.
9. **Nunca imprima nem repasse a chave.** Nem em log, nem em mensagem.

## 6. Formato das respostas que importam

`ingest`:

```json
{
  "ok": true, "duplicado": false, "batch_id": "…",
  "total_rows": 12, "applied_rows": 9, "gmv_preservado_rows": 1,
  "failed_rows": [],
  "pendentes": [{ "row_index": 4, "marca": "HAAG", "data": "2026-08-19", "motivo": "…" }]
}
```

Resumo que você deve reportar depois de um ingest: quantas linhas entraram
(`applied_rows`), quantas ficaram pendentes e por quê, quantas tiveram GMV
preservado, e as `failed_rows` com o motivo.

`lives criar` / `marcas criar` devolvem o registro com `id`; guarde o id para
editar depois. Todo registro tem `origem_dados` (`bot` = você).

## 7. Referência de campos

**Live (criar por `lives criar`)** — obrigatórios: `cabine_id`, `data`
(AAAA-MM-DD), `hora_inicio`, `hora_fim` (HH:MM, horário de São Paulo, fim >
início), `fat_gerado` (número ou string "12500.00"), `qtd_pedidos`. Um de
`marca_id` ou `cliente_id`. Opcionais: `apresentador_id`, `apresentador2_id`
(diferente do primeiro), `resumo`, `manual_views`, `manual_likes`,
`manual_comments`, `manual_shares`, `manual_orders`, `manual_gmv`, `tipo`
(`cliente` | `afiliado` | `teste`) e as métricas de funil do TikTok Studio,
que importam logo depois do GMV: `live_impressions`, `product_impressions`,
`product_clicks`, `new_followers`, `avg_viewing_duration` (segundos) e
`ads_cost` (verba investida, número). Inteiros sem separador de milhar.

**Live (editar)** — os mesmos, mais `ads_gmv` e `status_publicacao`
(`rascunho` | `revisado` | `publicado`).

**Marca** — obrigatórios: `nome`, `tipo` (`cliente` | `afiliada` | `propria` |
`parceira`; `cliente` exige `cliente_id`). Opcionais: `status` (`ativa` |
`inativa` | `pausada`), `tiktok_username`, `site`, `marketplace_url`,
`comissao_franquia_pct`, `comissao_franqueadora_pct`, `observacoes`.

**Apresentadora (só editar)** — `nome`, `telefone`, `email`, `cidade`,
`comissao_pct`, `observacoes`, `data_inicio`, `data_fim`.

Contrato completo da API, com `curl`: `docs/api-automacao.md` no mesmo repositório.
