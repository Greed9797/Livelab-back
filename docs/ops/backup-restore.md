# Backup e restauração — estado verificado

Revisado em 07/09/2026. Este documento substitui o plano antigo, que continha exemplos tratados como configuração existente.

## O que existe

- Script `scripts/pg_dump_offsite.sh`, agendado pelo backend às 03:00 de São Paulo somente em produção e quando `BACKUP_S3_BUCKET` existe.
- A imagem Docker instala PostgreSQL client 17 e AWS CLI. Conferir a versão do servidor antes de ativar: pg_dump deve ser compatível com ela.
- Job `src/jobs/offsite-backup.js` executa o script pelo caminho real, usa lock PostgreSQL entre réplicas e reporta falha sanitizada ao Sentry quando configurado.
- O script valida configuração antes de extrair dados, utiliza diretório temporário privado, mantém credenciais fora dos argumentos, verifica o índice do arquivo e remove temporários em sucesso/falha.
- Arquivo: `postgres/liveshop-<UTC>-<UUID>.dump.gz`, custom archive pg_dump envolto em gzip. ACLs são preservadas; proprietários não são restaurados automaticamente.
- O script não apaga backups. Retenção deve ser configurada explicitamente pelo lifecycle do bucket.

## O que NÃO foi confirmado/ativado

- No Railway não há bucket/chaves S3/R2 configurados; portanto o cron offsite não está ativo.
- Não há acesso administrativo Supabase disponível nesta sessão para confirmar plano, lista de snapshots, última execução ou PITR.
- Não foi feito backup real nem restauração de produção durante esta tarefa. Os testes do script usam clientes simulados e comprovam controles de falha, não recuperabilidade dos dados.
- Não há RPO, RTO ou retenção garantidos. Medir esses valores em um exercício real antes de defini-los.

## Configuração para ativação

Utilizar destino privado da organização, em conta autorizada. Não criar serviço pago ou substituir DNS/credenciais existentes por tentativa.

Variáveis do backend: `DATABASE_URL`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`, `BACKUP_S3_REGION`; `BACKUP_S3_ENDPOINT` para endpoint compatível como R2. As chaves ficam somente no gerenciador de segredos. A conta do bucket precisa enviar e ler arquivos para permitir a validação de restauração; o job não precisa de permissão de exclusão.

Confirmar criptografia do armazenamento, política de acesso, lifecycle/retencão e região aprovados. `BACKUP_RETENTION_DAYS` não executa exclusões: configure lifecycle no provedor. Monitorar idade do último arquivo por um serviço externo ao processo da API. O cron interno pode perder uma execução durante indisponibilidade; um backup perdido não é recuperado automaticamente no próximo boot.

## Exercício de restauração

1. Confirmar a data, origem, tamanho e integridade de um arquivo real. Baixá-lo somente para ambiente privado autorizado.
2. Provisionar banco descartável isolado, sem conexão de aplicação/integração e sem apontar `DATABASE_URL` de produção para ele. Não restaurar sobre produção como teste.
3. Conferir versão PostgreSQL, extensões e roles exigidas pelo schema. O pg_dump não inclui definições globais de roles; preparar roles/grants e segredos no destino a partir da configuração aprovada, incluindo o papel `livelab_portal_runtime` NOBYPASSRLS. Não conceder BYPASSRLS para fazer o teste passar.
4. Descompactar gzip e usar **pg_restore**, com parada em erro e transação única, no banco descartável. O arquivo não é SQL de texto: não usar `psql < arquivo.dump`.
5. Validar schema_migrations, tabelas críticas, sequências, funções, constraints, policies e grants. Comparar contagens com um inventário consistente do snapshot; contar apenas tenants não prova recuperação.
6. Exercitar login em ambiente de teste, leitura de live e comissões, isolamento entre unidades e fluxo de revisão. Não disparar e-mails/webhooks nem pagamentos a partir do banco restaurado.
7. Registrar fonte do backup, horário, duração, checks e falhas. Somente então marcar restauração verificada e medir RPO/RTO. Remover o ambiente descartável e seus arquivos após autorização/retencão definida.

Backups do banco não incluem os objetos de Supabase Storage; planejar cópia e recuperação deles separadamente. Snapshots e PITR dependem do plano/configuração e precisam ser conferidos no painel.

## Referências oficiais

- [Supabase: database backups](https://supabase.com/docs/guides/platform/backups)
- [PostgreSQL: pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)
- [PostgreSQL: pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html)
