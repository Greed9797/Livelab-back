import { diaDaSemana, feriadoEm, intervaloDeDias } from '../lib/calendario-blumenau.js'

/**
 * Feriados do período (datas 'YYYY-MM-DD' inclusivas) → Map data → nome.
 * Calendário embutido + ajustes da unidade (tabela feriados): ativo=true
 * acrescenta/renomeia, ativo=false desliga o feriado embutido daquela data.
 */
export function montarFeriados(inicio, fim, ajustes = []) {
  const mapa = new Map()
  for (const dia of intervaloDeDias(inicio, fim)) {
    const nome = feriadoEm(dia)
    if (nome) mapa.set(dia, nome)
  }
  for (const row of ajustes) {
    if (row.data < inicio || row.data > fim) continue
    if (row.ativo) mapa.set(row.data, row.nome)
    else mapa.delete(row.data)
  }
  return mapa
}

export async function feriadosDoPeriodo(db, tenantId, inicio, fim) {
  const { rows } = await db.query(
    `SELECT to_char(data, 'YYYY-MM-DD') AS data, nome, ativo FROM feriados
      WHERE tenant_id = $1::uuid AND data >= $2::date AND data <= $3::date`,
    [tenantId, inicio, fim],
  )
  return montarFeriados(inicio, fim, rows)
}

/** 'feriado' | 'sabado' | 'domingo' | null (dia útil). Feriado tem precedência. */
export function tipoDiaEspecial(iso, feriados) {
  if (feriados.has(iso)) return 'feriado'
  const dow = diaDaSemana(iso)
  return dow === 6 ? 'sabado' : dow === 0 ? 'domingo' : null
}
