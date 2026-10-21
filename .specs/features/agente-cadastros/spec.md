# Agente de atualização cadastral

## Problem Statement

Um agente externo precisa corrigir os dados cadastrais a partir dos contratos fornecidos pelo responsável. O usuário autorizou implementação e publicação em 21/10/2026, incluindo o portal de cliente já validado. O agente de contratos fará as alterações reais depois; esta entrega não executa correções na carteira.

Routing: backend/auth/dados e publicação; complexidade 4/5; risco alto de exposição ou alteração indevida; root coordena implementação e revisão independente; modelo herdado da sessão. Produção autorizada, com backend primeiro e frontend depois.

## Out of Scope

Leitura automática de PDFs, alterações reais de clientes, novas tabelas/migrations/dependências, criação/exclusão de cadastros, promoção de tipo, vínculos de usuários, senhas, status, datas de contrato, condições comerciais, financeiro, apresentadoras e ampliação das chaves operacional/financeira existentes.

## Assumptions & Open Questions

| Decision | Chosen default | Rationale |
| --- | --- | --- |
| Credencial | Novo escopo cadastros, papel automacao_cadastros | Reutilizar criação, hash, expiração e revogação existentes |
| Rotas | GET /v1/cadastros, GET/PATCH /v1/cadastros/:id | Reutilizar API, sem endpoint de lote |
| Campos editáveis | nome, celular, email, cpf, cnpj, razao_social, nicho, fat_anual, cidade, estado, cep, vende_tiktok, site, marketplace_url, tiktok_username, logo_url, cor | Todos os campos cadastrais, sem efeitos de ciclo de contrato |
| Origem | referencia_documento obrigatória no PATCH da nova chave, de 1 a 500 caracteres após trim | Registrar qual contrato fundamentou a alteração, sem conteúdo do PDF |
| Auditoria | Antes/depois dos campos enviados, identidade da chave e referência, com redação de documentos sensíveis existente | Rastreabilidade sem publicar segredos |
| Contratos | Fornecidos ao agente por canal do responsável | Não abrir API de contratos/assinaturas para a chave |
| Publicação | Push autorizado, sem force-push, verificar divergências e migrations antes | Preservar trabalho remoto e permitir rollback |

Open questions: None. A chave real será criada no cadastro administrativo pelo responsável, com validade e nome do agente; não imprimir credenciais neste chat.

## User Stories

### Agente corrige cadastro com credencial própria

Acceptance Criteria:
- WHEN um administrador cria uma chave com escopo cadastros, a API SHALL persistir automacao_cadastros e manter hash, expiração e revogação existentes. [AGCAD-1]
- WHEN a nova chave acessa a API, a autorização SHALL permitir apenas GET /v1/cadastros e GET/PATCH /v1/cadastros/:id com UUID válido, negando outras rotas e métodos com 403. [AGCAD-2]
- WHEN a chave consulta ou altera cadastros, a API SHALL usar apenas o tenant da chave; IDs de outro tenant retornam 404 e não alteram nenhum registro. [AGCAD-3]
- WHEN a chave recebe um cadastro, a resposta SHALL conter apenas identificadores e dados cadastrais permitidos, sem financeiro, gateway, apresentadoras, credenciais ou vínculos de login, com Cache-Control private, no-store e sem reutilizar cache de outra credencial. [AGCAD-4]
- WHEN a chave envia PATCH, a API SHALL aceitar apenas os campos cadastrais enumerados e referencia_documento não vazia, rejeitar campos proibidos com 403 e entrada inválida com 400, antes de gravar qualquer dado. [AGCAD-5]
- WHEN um cadastro é atualizado, a API SHALL reutilizar a sincronização cliente/marca/TikTok existente, preservar campos omitidos e gravar auditoria antes/depois e referência na mesma transação; falha na auditoria desfaz a atualização. [AGCAD-6]
- WHEN uma chave antiga ou cliente_parceiro tenta usar a nova capacidade, a API SHALL preservar suas restrições anteriores; chaves inválidas, expiradas ou revogadas recebem 401. [AGCAD-7]
- WHEN a entrega é validada, a suíte SHALL demonstrar isolamento com SQL real PGlite, mocks e autenticação real, passar npm test e revisão independente com pelo menos cinco mutações em scratch, antes da publicação. [AGCAD-8]

## Requirement Traceability

| ID | Requirement | Status |
| --- | --- | --- |
| AGCAD-1 | Escopo próprio no mecanismo existente | implementing |
| AGCAD-2 | Métodos e rotas exatos | implementing |
| AGCAD-3 | Isolamento tenant | implementing |
| AGCAD-4 | DTO e cache restritos | implementing |
| AGCAD-5 | Campos e referência validados | implementing |
| AGCAD-6 | Sincronização e auditoria atômicas | implementing |
| AGCAD-7 | Compatibilidade e revogação | implementing |
| AGCAD-8 | Gates e revisão independente | implementing |
