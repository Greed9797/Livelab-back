# Monitoramento — configuração e limites verificados

Revisado em 07/09/2026.

## Estado atual

`SENTRY_DSN` está configurado no backend Railway. A captura de exceções existe no código. Isso não comprova recebimento de eventos, regras de alerta ou entrega de notificações: a sessão não tem acesso administrativo Sentry para verificá-los. Nenhum alerta de teste foi enviado a pessoas.

`/healthz` permanece liveness: 200 indica processo respondendo. `/readyz` verifica uma consulta ao banco, retorna somente `{ok:true}`/200 ou `{ok:false}`/503, limita a espera e compartilha/cacheia verificações por alguns segundos para proteger o pool. Não expõe credenciais, erros SQL ou informações de clientes.

Railway usa `/readyz` para validar uma implantação antes de encaminhar tráfego. Esse healthcheck não é monitoramento contínuo depois do deploy. É necessário um monitor externo autorizado para detectar indisponibilidade persistente.

O job offsite envia uma exceção sanitizada ao Sentry em caso de falha, quando o destino de backup está configurado. O cron interno não detecta a própria ausência durante queda do processo; verificar idade do último backup externamente.

## Configuração operacional pendente

- Confirmar projetos Sentry backend/frontend, ambiente `production`, recebimento recente, associação de releases e política de remoção de dados sensíveis.
- Configurar monitor externo para `/readyz` e para a página de login; usar falhas consecutivas para evitar alertas por oscilação isolada.
- Definir responsável, canal e escalonamento com o operador antes de habilitar notificações. Não presumir que canais Slack/PagerDuty citados no documento antigo existem.
- Definir alerta de erro novo/regressão, falha de backup e backup atrasado; calibrar volume de erros com dados reais, sem thresholds arbitrários apresentados como regra já vigente.
- Realizar teste autorizado de alerta e registrar recebimento pelo responsável. Captura de erro sozinha não conclui esta validação.

Não há novo serviço pago contratado nem regra remota de alerta criada nesta entrega. O envio transacional Resend é separado de monitoramento Sentry.

[Railway: healthchecks](https://docs.railway.com/deployments/healthchecks).
