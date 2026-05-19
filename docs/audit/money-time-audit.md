# Auditoria — Dinheiro BRL e Horários de Lives Manuais

Data: 2026-05-19

## Resumo

Esta auditoria cobre o bug em que um GMV digitado como `1142` era exibido como `R$ 114.200,00` e o problema de horários de lives manuais que não permaneciam iguais ao reabrir/editar.

Nenhum dado antigo foi alterado automaticamente. A correção aplicada padroniza entrada futura e deixa diagnóstico SQL para revisão humana.

## Causas encontradas

- Frontend formatava BRL com `maximumFractionDigits: 0`, omitindo centavos.
- `asNumber` removia todos os pontos de strings vindas da API, então `1142.00` virava `114200`.
- Formulários monetários usavam `type="number"`, incompatível com padrão brasileiro de ponto para milhar e vírgula para decimal.
- Backend validava campos monetários com `z.number()` puro, rejeitando ou dependendo do frontend para converter strings BRL.
- Live manual criava timestamps sem timezone explícito e a edição recuperava horário com UTC em alguns casos.

## Campos monetários revisados

- Lives: `fat_gerado`, `manual_gmv`, `comissao_calculada`.
- Vídeos: `gmv_atribuido`.
- Financeiro: `valor` de custos.
- Contratos/pacotes: `valor_fixo`.
- CRM: `valor_oportunidade`, `fat_estimado`.
- Cliente parceiro: `meta_gmv`.
- Apresentadoras: `fixo`, `meta_diaria_gmv`.

## Pontos de frontend revisados

- `formatMoney` agora exibe sempre centavos em `pt-BR`.
- `MoneyInput` deve ser usado para dinheiro; contagens continuam em `type="number"`.
- Fluxo ativo de live manual em `Conteúdo > Lives realizadas` monta payload com decimal em reais.
- Edição de live manual lê data/hora em `America/Sao_Paulo`.

## Pontos de backend revisados

- `parseMoneyToDecimal` normaliza strings BRL para decimal em reais.
- Schemas Zod monetários aceitam `1142`, `1.142`, `1142,00`, `1.142,50`, `R$ 1.142,50` e `1142.00`.
- Lives manuais persistem `iniciado_em` e `encerrado_em` com offset `-03:00`.

## SQL de diagnóstico somente leitura

```sql
-- Lives manuais recentes com valores altos ou suspeitos.
SELECT
  id,
  tenant_id,
  cabine_id,
  cliente_id,
  iniciado_em,
  encerrado_em,
  fat_gerado,
  manual_gmv,
  final_orders_count,
  origem_dados,
  status_publicacao,
  criado_em
FROM lives
WHERE origem_dados = 'manual'
  AND criado_em >= NOW() - INTERVAL '45 days'
  AND (
    COALESCE(fat_gerado, 0) >= 100000
    OR COALESCE(manual_gmv, 0) >= 100000
    OR (
      COALESCE(fat_gerado, 0) >= 10000
      AND COALESCE(final_orders_count, 0) <= 5
    )
    OR (
      fat_gerado IS NOT NULL
      AND manual_gmv IS NOT NULL
      AND ABS(fat_gerado - manual_gmv) > 0.01
    )
  )
ORDER BY criado_em DESC;

-- Valores que podem ter sido multiplicados por 100 por máscara de centavos.
SELECT
  id,
  tenant_id,
  iniciado_em,
  fat_gerado,
  manual_gmv,
  final_orders_count,
  criado_em
FROM lives
WHERE origem_dados = 'manual'
  AND criado_em >= NOW() - INTERVAL '45 days'
  AND MOD(COALESCE(fat_gerado, 0)::numeric, 100) = 0
  AND COALESCE(fat_gerado, 0) >= 10000
ORDER BY criado_em DESC;
```

## Próximo passo para dados antigos

Revisar manualmente os resultados do diagnóstico. Se houver consenso sobre padrões seguros de correção, criar migration/script transacional separado com `BEGIN`, `SELECT` de conferência e `ROLLBACK` por padrão.
