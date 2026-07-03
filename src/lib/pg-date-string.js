// Side-effect module: coluna DATE (OID 1082) volta como string 'YYYY-MM-DD',
// NUNCA como Date JS. O parser default do node-pg cria Date à meia-noite no
// fuso do processo (UTC no Railway); qualquer conversão para America/Sao_Paulo
// volta um dia — segunda virava domingo e o recálculo gravava 2% de fim de
// semana em dia útil (incidente 01/06/2026). Os helpers de timezone.js tratam
// 'YYYY-MM-DD' como data-calendário de SP.
//
// IMPORTANTE: importar este módulo em TODO ponto que cria pg.Pool próprio
// (plugins/db.js E os scripts standalone em scripts/) — o registry de types é
// global por processo, mas scripts não passam pelo plugin.
import pg from 'pg'

pg.types.setTypeParser(1082, (value) => value)
