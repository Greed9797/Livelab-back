// Seed de exemplo Knowledge Base
// Cria 5 artigos com Markdown rico + vídeo YouTube nas categorias
// existentes (Operação, Equipe, Comercial, Legal). Útil pra QA visual
// antes do time entrar com conteúdo real.
//
// Uso: node scripts/seed_knowledge.js
//
// Idempotente: pula artigos cujo slug já exista.

import pg from 'pg'
import 'dotenv/config'

const { Pool } = pg

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

const slugify = (str) =>
  str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const calcReadMinutes = (md) =>
  Math.max(1, Math.round(md.trim().split(/\s+/).length / 200))

const ARTIGOS = [
  {
    titulo: 'Como iniciar uma live com sucesso',
    categoria: 'Operação',
    excerpt:
      'Checklist completo de pré-live: equipamento, iluminação, conexão, roteiro e primeiros 5 minutos.',
    cover_image_url: null,
    video_provider: 'youtube',
    video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    tags: ['live', 'operação', 'checklist', 'iniciantes'],
    destaque: true,
    sort_order: 1,
    content_markdown: `# Como iniciar uma live com sucesso

A primeira impressão da sua live define o engajamento dos próximos 60 minutos. Este guia traz o checklist completo dos 30 minutos que antecedem o "ao vivo".

## 30 minutos antes

- **Iluminação:** ringlight a 50cm da apresentadora, contraluz suave atrás
- **Câmera:** TikTok aberto, modo retrato, 1080p, foco travado no rosto
- **Áudio:** lapela testada, sem chiado, volume entre 70-85%
- **Conexão:** speedtest > 25Mbps upload, cabo > Wi-Fi sempre que possível
- **Roteiro:** 3 produtos de destaque definidos, ordem combinada com gestor

## 10 minutos antes

1. Última checagem do estoque
2. Cupom do dia ativo no checkout
3. Tela de pré-live com countdown 5min
4. Apresentadora com água + figurino completo

## Os primeiros 5 minutos

| Minuto | Ação |
|---|---|
| 00:00 | Saudação curta + nome da loja |
| 00:30 | "Hoje vocês vão ver..." (3 destaques) |
| 01:00 | Primeiro produto em mãos + preço |
| 02:00 | Cupom mencionado pela primeira vez |
| 03:00 | Pergunta de engajamento ao chat |

## Erros comuns a evitar

> **Nunca comece uma live com mais de 2 pessoas no quadro.** Espelha amador. Se houver gestor, ele fica fora de câmera nos primeiros 10 minutos.

- Saudação longa demais (> 30 segundos)
- Anunciar promoções antes de mostrar produto
- Demorar pra responder o chat (> 1 minuto)

## Vídeo guia

Assista o vídeo acima pra ver o passo-a-passo aplicado a uma live real do Grupo Livelab.

---

*Última atualização: 09/05/2026 — equipe de Operações*`,
  },
  {
    titulo: 'Comissão por live: como é calculada',
    categoria: 'Comercial',
    excerpt:
      'Entenda o cálculo de comissão da apresentadora e do gestor a partir do GMV consolidado.',
    video_provider: 'none',
    tags: ['comissão', 'financeiro', 'apresentadora'],
    destaque: true,
    sort_order: 1,
    content_markdown: `# Comissão por live: como é calculada

A comissão é calculada **por live encerrada**, com base no GMV consolidado declarado pelo gestor no momento de encerrar a live.

## Fórmula base

\`\`\`
comissao = fat_gerado * (comissao_pct / 100)
\`\`\`

- \`fat_gerado\` = valor consolidado da live (informado pelo gestor)
- \`comissao_pct\` = percentual definido no contrato ativo da cabine

## Exemplo prático

Cabine com contrato de **8% de comissão** e live com GMV de **R\$ 5.420,00**:

| Item | Valor |
|---|---|
| GMV declarado | R\$ 5.420,00 |
| % comissão (contrato) | 8% |
| **Comissão da live** | **R\$ 433,60** |

## Quem recebe o quê

- **Apresentadora principal:** comissão integral
- **Apresentadora 2 (se houver):** divisão 50/50 com a principal
- **Gestor:** percentual fixo definido no contrato master, independente do GMV

## Quando a comissão é pagada

Comissões da quinzena fecham todo dia **15** e **30**. Pagamento via PIX cadastrado no perfil da apresentadora em até 5 dias úteis após o fechamento.

> **Atenção:** lives com status \`em_andamento\` por mais de 24h são automaticamente arquivadas pelo cron de cleanup e **não geram comissão**. Sempre encerre a live na hora pelo painel.

---

*Dúvidas: financeiro@grupolivelab.com.br*`,
  },
  {
    titulo: 'Como reservar uma cabine',
    categoria: 'Operação',
    excerpt:
      'Passo a passo pra reservar cabine no painel — agendamento, conflitos e cancelamento.',
    video_provider: 'youtube',
    video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    tags: ['cabines', 'agendamento', 'cliente'],
    sort_order: 2,
    content_markdown: `# Como reservar uma cabine

A reserva de cabine é o primeiro passo de qualquer live. Sem reserva confirmada, a apresentadora não consegue iniciar a transmissão pelo TikTok da loja.

## Pelo painel do cliente

1. Acesse \`/cliente/cabines\` no app
2. Clique em **"Solicitar nova live"** no card da cabine desejada
3. Escolha data e horário (slots de 1h)
4. Confirme — solicitação vai pro gestor aprovar

## Aprovação do gestor

Solicitações entram em \`/solicitacoes\` no painel do gestor com status **PENDENTE**. O gestor:

- **Aprova** → cabine fica reservada no horário, apresentadora notificada
- **Recusa** → cliente notificado com motivo opcional

## Conflitos de horário

Se outra reserva já existe no slot pedido, o sistema **rejeita automaticamente** antes de chegar ao gestor. O cliente vê alerta vermelho com sugestão dos próximos 3 horários livres.

## Cancelamento

- **Cliente:** pode cancelar até 4h antes do início — sem multa
- **Cliente:** entre 4h e 1h antes — multa de R\$ 50
- **Cliente:** menos de 1h ou no-show — multa cheia da hora reservada
- **Gestor:** cancela a qualquer momento sem multa pro cliente

## Tabela de status da reserva

| Status | Significa |
|---|---|
| \`pendente\` | Aguardando aprovação do gestor |
| \`aprovada\` | Cabine bloqueada no horário |
| \`em_andamento\` | Live rolando (cabine ao vivo) |
| \`encerrada\` | Live finalizada, gestor preencheu GMV |
| \`cancelada\` | Cancelada por cliente ou gestor |

---

*Aba "Histórico" em /cabines lista todas as reservas passadas com filtro por status.*`,
  },
  {
    titulo: 'Política de uso da plataforma',
    categoria: 'Legal',
    excerpt:
      'Termos de uso, conduta esperada da apresentadora e penalidades por descumprimento.',
    video_provider: 'none',
    tags: ['legal', 'termos', 'conduta'],
    sort_order: 1,
    content_markdown: `# Política de uso da plataforma

Esta política rege o uso da plataforma LiveShop por todos os perfis (franqueador, franqueado, gerente, apresentadora, cliente parceiro). Aceita no momento do cadastro.

## 1. Conduta da apresentadora

A apresentadora é o rosto da marca. Durante a live, **não é permitido**:

- Linguagem ofensiva, discriminatória ou de baixo calão
- Promover produtos concorrentes ou marcas externas
- Divulgar contatos pessoais (WhatsApp, Instagram pessoal)
- Beber álcool durante a transmissão
- Sair do cenário sem trocar pra tela de "voltamos já"

## 2. Conduta do gestor

- Acompanhar a live presencialmente ou remotamente
- Não interferir na narrativa da apresentadora durante o ao vivo
- Encerrar a live no painel **assim que terminar** (informando GMV real)
- Reportar incidentes via \`/solicitacoes\` em até 24h

## 3. Conteúdo permitido

- Apenas produtos do catálogo aprovado pela franquia
- Imagens e mídias respeitando direitos autorais
- Música ambiente: apenas trilhas livres ou licenciadas pelo TikTok

## 4. Penalidades

| Infração | 1ª ocorrência | Reincidência |
|---|---|---|
| Linguagem inadequada | Advertência | Suspensão 7 dias |
| Promoção de concorrente | Suspensão 30 dias | Desligamento |
| Falsificação de GMV | Desligamento imediato | — |
| Cancelamento de live no-show | Multa cheia | Suspensão 15 dias |

## 5. LGPD e dados

Dados coletados (nome, email, CPF, vendas) são tratados conforme nossa **Política de Privacidade**. Cliente pode solicitar exclusão a qualquer momento via \`legal@grupolivelab.com.br\`.

> Esta política pode ser atualizada a qualquer momento. Mudanças significativas são comunicadas com 30 dias de antecedência.

---

*Versão 2.1 — vigente desde 01/05/2026*`,
  },
  {
    titulo: 'Onboarding de nova apresentadora',
    categoria: 'Equipe',
    excerpt:
      'Roteiro de 7 dias pra integrar uma apresentadora nova: cadastro, treinamento, primeira live e avaliação.',
    video_provider: 'youtube',
    video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    tags: ['onboarding', 'apresentadora', 'treinamento', 'rh'],
    sort_order: 1,
    content_markdown: `# Onboarding de nova apresentadora

Roteiro padrão de 7 dias pra integrar uma apresentadora nova ao time da unidade. Cumprir todos os passos reduz turnover em ~40% segundo dados internos do Q1/2026.

## Dia 1 — Cadastro e contratos

- [x] Cadastro no sistema (\`/usuarios\` → "Convidar apresentadora")
- [x] Contrato de prestação de serviço assinado (modelo padrão Livelab)
- [x] PIX cadastrado no perfil
- [x] Foto profissional pra ranking
- [x] Acesso à área da apresentadora confirmado

## Dia 2-3 — Treinamento de produto

- Apresentação dos 20 produtos top do catálogo
- Estudo da pasta \`/conhecimento/c/operacao\` (este Knowledge Base!)
- Quiz interno com gestor (mínimo 80%)

## Dia 4 — Treinamento de plataforma

- Como abrir o TikTok Live na cabine
- Painel de cabine ao vivo
- Como interagir com chat
- Encerramento de live (preenchimento de GMV)

## Dia 5 — Live de simulação

Live **fechada** (sem audiência real) de 30 minutos pra:

- Praticar cumprimentos e despedidas
- Treinar manuseio dos produtos
- Sentir o ritmo de fala
- Identificar tiques de linguagem

Gestor grava e dá feedback estruturado.

## Dia 6 — Primeira live oficial

- Slot de **1 hora**, horário fora do pico (manhã)
- Gestor presente fisicamente
- Avaliação pós-live em 4 eixos:
  1. Energia
  2. Conhecimento de produto
  3. Engajamento de chat
  4. Conversão (% pedidos / viewers)

## Dia 7 — Avaliação e plano

Reunião de 30 min com gestor:

- Pontos fortes identificados
- 3 pontos de melhoria pra próximas 2 semanas
- Definição da grade de horários permanente
- Meta de GMV pros próximos 30 dias

## KPIs de sucesso no primeiro mês

| Métrica | Meta mínima |
|---|---|
| Lives realizadas | ≥ 8 |
| GMV médio por live | ≥ R\$ 1.500 |
| Taxa de conversão | ≥ 2% pedidos/viewers |
| Avaliação interna (1-5) | ≥ 4.0 |

> **Importante:** apresentadoras abaixo da meta no primeiro mês entram em **plano de desenvolvimento** de mais 30 dias antes de qualquer decisão de desligamento.

---

*Última atualização: 09/05/2026 — RH Livelab*`,
  },
]

async function seed() {
  let created = 0
  let skipped = 0

  for (const a of ARTIGOS) {
    const slug = slugify(a.titulo) + '-seed'
    const existing = await pool.query('SELECT id FROM manuais WHERE slug = $1', [slug])
    if (existing.rows.length > 0) {
      console.log(`[skip] ${a.titulo} — já existe`)
      skipped++
      continue
    }

    const cat = await pool.query(
      'SELECT id FROM knowledge_categories WHERE name = $1',
      [a.categoria],
    )
    if (cat.rows.length === 0) {
      console.warn(`[warn] Categoria "${a.categoria}" não encontrada — pulando ${a.titulo}`)
      skipped++
      continue
    }

    await pool.query(
      `INSERT INTO manuais (
        category_id, titulo, slug, excerpt, content_markdown,
        url, cover_image_url, video_provider, video_url, tags,
        status, sort_order, estimated_read_minutes, published_at,
        categoria, destaque
      ) VALUES ($1,$2,$3,$4,$5,'',$6,$7,$8,$9,'published',$10,$11,NOW(),$12,$13)`,
      [
        cat.rows[0].id,
        a.titulo,
        slug,
        a.excerpt,
        a.content_markdown,
        a.cover_image_url ?? null,
        a.video_provider,
        a.video_url ?? null,
        a.tags,
        a.sort_order ?? 0,
        calcReadMinutes(a.content_markdown),
        a.categoria,
        a.destaque ?? false,
      ],
    )
    console.log(`[ok]   ${a.titulo}`)
    created++
  }

  console.log(`\n✅ Seed concluído: ${created} criados, ${skipped} pulados.`)
  await pool.end()
}

seed().catch((e) => {
  console.error('❌ Erro no seed:', e)
  process.exit(1)
})
