# Migration 090 - comissoes, fixos e metas

## Comando correto

Rode no backend apontando para o banco de producao:

```bash
node apply_migrations.js
```

## Nao usar

Nao rode:

```bash
psql "$DATABASE_URL" -f migrations/085_comissao_faixas_metas.sql
```

Motivos:

- a migration `085` deste repo ja e `085_agenda_operacional_campos.sql`;
- o arquivo `085_comissao_faixas_metas.sql` nao existe neste repo;
- o backend usa a tabela `apresentadora_comissao_faixas`, criada na migration `088`;
- criar `apresentadora_faixas_comissao` geraria uma tabela paralela que o backend nao consome.

## O que a migration 090 cria

- `marcas.valor_fixo_minimo`;
- `apresentadoras.valor_fixo_mensal`;
- tabela `metas_apresentadora`;
- tabela `metas_supervisor`;
- RLS tenant-safe para as duas tabelas de metas.
