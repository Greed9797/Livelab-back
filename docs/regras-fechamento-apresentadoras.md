# Regras do fechamento de apresentadoras

Decisões de negócio (dinheiro) aplicadas no fechamento mensal a partir da competência **2026-10**.
Código: `src/services/remuneracao-apresentadoras.js` (fechamento), `src/services/presenter-commission.js`
(percentual), `src/services/feriados.js` + `src/routes/feriados.js` (feriados).

## Decisões confirmadas

| Regra | Decisão |
|---|---|
| Escada de comissão | 1% até R$70 mil, 1,5% até R$150 mil, **3ª faixa de 2% acima de R$150 mil mantida** (base: GMV mensal da apresentadora; faixas próprias ou da unidade sobrepõem a padrão). |
| Sábado, domingo e feriado | Live nesses dias paga **2% fixo** sobre o GMV daquela live (sobrepõe a escada). Vídeo segue a escada. |
| Bônus de fim de semana/feriado | Automático: **R$100 por bloco fechado de 4h** de live no dia (`floor(horas/4) × R$100`). 3h59 = R$0; 8h = R$200. Soma-se aos 2%. |
| Vídeo da apresentadora | Lançado no portal, **conta na hora**, sem aprovação. |
| Lançamentos manuais | A diária manual de fim de semana deixa de existir a partir de 2026-10 (API devolve 400). Fica só o **ajuste excepcional** (tipo `bonificacao`), com motivo obrigatório e auditoria de quem lançou/cancelou. |

Total a pagar = fixo + comissão + bônus fds/feriado + ajustes excepcionais.

## Premissas adotadas (confirmar com a gestão)

- **Feriados**: calendário embutido (nacionais + Blumenau, `src/lib/calendario-blumenau.js`) mais a tabela
  `feriados` da unidade, editável em Configurações. Desligar um feriado embutido = linha com `ativo=false`.
  Mudar um feriado recalcula as vendas **pendentes** do mês; vendas aprovadas não mudam.
- **Meta de horas** (garante o fixo de R$2.700): 6h × dias úteis (seg–sex, sem feriado) dentro do vínculo
  da apresentadora no mês. Horas realizadas = horas de presença em live nos dias úteis (mesma régua do painel
  de assiduidade). Horas de sábado/domingo/feriado não contam para a meta; geram bônus.
- O bônus de R$300 por bater horas **não existe** (removido).
- Fechamentos **anteriores a 2026-10** ficam como foram pagos: sem bônus automático, diária manual mantida.
  Diária manual de fds lançada em 2026-10 ou depois aparece marcada como substituída e fica fora do total.
- O fechamento continua **mensal**: o período personalizado da spec (2.7) vale para os relatórios de
  performance; o pagamento é por competência.
- A meta diária de vídeos (`videos_por_apresentador` na configuração operacional) conta só dias úteis.
