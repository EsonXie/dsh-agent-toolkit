/** 飞书内的运维文本指令（不走模型）。 */
export type Directive = 'new' | 'stop' | 'status'

/** 仅当整条消息就是一个指令时命中；带参数/前后文的按普通消息处理。 */
export function parseDirective(text: string): Directive | null {
  const t = text.trim().toLowerCase()
  if (t === '/new') return 'new'
  if (t === '/stop') return 'stop'
  if (t === '/status') return 'status'
  return null
}

/** 群消息正文中的 @ 占位符（@_user_1 等）剥掉，得到纯净指令文本。 */
export function stripMentionPlaceholders(text: string): string {
  return text.replace(/@_user_\d+\s*/g, '').trim()
}
