# Códigos de Erro de Negócio — LiveLab Backend

## Como usar

Ao retornar erros da API, sempre inclua o campo `code` com um dos valores abaixo.
Isso permite que o frontend trate erros de forma específica sem depender de strings de mensagem.

### Exemplo de resposta

```json
{
  "error": "Cabine em manutenção",
  "code": "CABINE_EM_MANUTENCAO"
}
```

### Como lançar um erro com código

```js
import { AppError, BizError } from '../lib/errors.js'

// Forma básica (sem código)
throw new AppError('Cabine não encontrada', { statusCode: 404 })

// Com código de negócio (recomendado)
throw new AppError('Cabine em manutenção', { 
  statusCode: 409, 
  code: BizError.CABINE_EM_MANUTENCAO 
})
```

**Nota:** O campo `code` não é ainda capturado automaticamente pelo setErrorHandler global.
Se precisar usá-lo na resposta, estenda o `AppError` para suportar a propriedade `code` ou modifique o handler conforme necessário.

## Catálogo de Códigos

| Código | HTTP | Descrição |
|--------|------|-----------|
| `CABINE_NAO_ENCONTRADA` | 404 | Cabine não existe ou não pertence ao tenant |
| `CABINE_EM_MANUTENCAO` | 409 | Cabine está em manutenção |
| `CABINE_JA_AO_VIVO` | 409 | Cabine já possui live em andamento |
| `CABINE_INDISPONIVEL` | 409 | Cabine não está disponível para a operação |
| `AGENDA_CONFLITO` | 409 | Conflito de horário na agenda |
| `LIVE_SEM_APRESENTADOR` | 422 | Live não pode ser iniciada sem apresentadora |
| `LIVE_SEM_CABINE` | 422 | Live não pode ser criada sem cabine |
| `CLIENTE_REQUIRED` | 422 | Live de tipo 'cliente' requer cliente_id |
| `NO_APPROVED_REQUEST` | 409 | Nenhuma solicitação aprovada para hoje nesta cabine |
| `LIVE_JA_ENCERRADA` | 409 | Live já foi encerrada |
| `CLIENTE_INADIMPLENTE` | 403 | Cliente inadimplente não pode ter nova live |
| `CONTRATO_INATIVO` | 422 | Contrato do cliente não está ativo |
| `CLIENTE_NAO_ENCONTRADO` | 404 | Cliente não encontrado no tenant |
| `TENANT_FORBIDDEN` | 403 | Operação não permitida para este tenant |
| `DADOS_RASCUNHO` | 403 | Dados em rascunho não visíveis ao cliente |
| `PERMISSAO_NEGADA` | 403 | Papel do usuário não tem permissão para esta ação |

## Logging e Sentry

O setErrorHandler global em `src/app.js` captura automaticamente:

- **request.id**: ID único da requisição (gerado pelo Fastify)
- **request.user.tenant_id**: ID do tenant do usuário autenticado
- **request.user.papel**: Papel do usuário (admin, operador, etc.)
- **error.sentryTag**: Categoria do erro (validation, auth, rbac, etc.)

Esses dados enriquecem as tags do Sentry, permitindo rastrear erros por tenant e papel.

### Exemplo de log estruturado

```
[error] Unhandled error
  request.id: "req-12345"
  request.user.tenant_id: 123
  request.user.papel: "operador"
  error.code: "CABINE_EM_MANUTENCAO"
  error.sentryTag: "app_error"
```
