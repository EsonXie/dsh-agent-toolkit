/** token-usage 纯函数：日期换算、K/M/B 格式化、聚合。无运行时依赖，浏览器半可内联。 */

/** 把 UTC 毫秒换算成指定时区的日期串与小时序号。 */
export function dayParts(time: number, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(time)
  const get = (type: string): string => parts.find((p) => p.type === type)!.value
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24, // 部分 ICU 版本午夜给 24
  }
}

/** 日期串加减天数（锚 UTC 正午，避开 DST）。 */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** 计费 token 数自动换算 K/M/B（10 进制，1 位小数）。 */
export function formatTokens(n: number): string {
  const units = ['', 'K', 'M', 'B'] as const
  let value = n
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return unit === 0 ? String(n) : `${value.toFixed(1)}${units[unit]}`
}
