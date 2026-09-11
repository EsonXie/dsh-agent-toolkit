/** 飞书内的运维文本指令（不走模型）。 */
export type Directive = 'new' | 'stop' | 'status' | 'sessions' | 'switch' | 'help'

export interface ParsedDirective {
  name: Directive
  /** 带参指令的参数（/switch 首词后的余串；无参时缺省，由 Inbound 提示用法）。 */
  arg?: string
}

/**
 * 精确指令（/new /stop /status /sessions /help）要求整条消息 trim+lowercase 精确匹配，
 * 带参数/前后文按普通消息处理；/switch 为首词判定的带参指令。
 */
export function parseDirective(text: string): ParsedDirective | null {
  const t = text.trim().toLowerCase()
  if (t === '/new') return { name: 'new' }
  if (t === '/stop') return { name: 'stop' }
  if (t === '/status') return { name: 'status' }
  if (t === '/sessions') return { name: 'sessions' }
  if (t === '/help') return { name: 'help' }
  if (t === '/switch') return { name: 'switch' }
  if (t.startsWith('/switch ')) return { name: 'switch', arg: t.slice('/switch '.length).trim() }
  return null
}

/** 群消息正文中的 @ 占位符（@_user_1 等）剥掉，得到纯净指令文本。 */
export function stripMentionPlaceholders(text: string): string {
  return text.replace(/@_user_\d+\s*/g, '').trim()
}
