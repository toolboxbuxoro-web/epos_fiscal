/** Конвертация и форматирование значений предметной области. */

/** Тийины → отображаемые сумы с разделителями: 1500000 → "15 000". */
export function tiyinToSumDisplay(tiyin: number): string {
  const sum = Math.round(tiyin / 100)
  return formatNumber(sum)
}

/** Тийины → отображаемые сумы с двумя знаками: 1500050 → "15 000.50". */
export function tiyinToSumDisplayPrecise(tiyin: number): string {
  const sum = tiyin / 100
  const fixed = sum.toFixed(2)
  const [intPart, fracPart] = fixed.split('.')
  return `${formatNumber(Number(intPart))}.${fracPart}`
}

/** Миллидоли → штуки: 1000 → "1", 2500 → "2.5". */
export function milliQtyToDisplay(milli: number): string {
  if (milli % 1000 === 0) return String(milli / 1000)
  return (milli / 1000).toFixed(3).replace(/\.?0+$/, '')
}

/** Число с разделителями тысяч: 1234567 → "1 234 567". */
export function formatNumber(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** Epoch секунды → "DD.MM.YYYY HH:MM". */
export function formatDateTime(epochSec: number): string {
  if (!epochSec) return ''
  const d = new Date(epochSec * 1000)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const HH = String(d.getHours()).padStart(2, '0')
  const MM = String(d.getMinutes()).padStart(2, '0')
  return `${dd}.${mm}.${yyyy} ${HH}:${MM}`
}

/** Epoch секунды → "DD.MM.YYYY". */
export function formatDate(epochSec: number): string {
  if (!epochSec) return ''
  const d = new Date(epochSec * 1000)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${dd}.${mm}.${yyyy}`
}
