/** 飞书内的运维文本指令（不走模型）。 */
export type Directive = 'new' | 'stop' | 'status' | 'sessions' | 'switch' | 'help' | 'doc' | 'ls'

export interface ParsedDirective {
  name: Directive
  /** 带参指令的参数（/switch 首词后的余串；无参时缺省，由 Inbound 提示用法）。 */
  arg?: string
}

/**
 * 精确指令（/new /stop /status /sessions /help）要求整条消息 trim+lowercase 精确匹配，
 * 带参数/前后文按普通消息处理；/switch /doc /ls 为首词判定的带参指令。
 * /doc /ls 的 arg 是文件系统路径（大小写敏感）：取自原始文本切片（toLowerCase 不改变长度，索引对齐）。
 */
export function parseDirective(text: string): ParsedDirective | null {
  const raw = text.trim()
  const t = raw.toLowerCase()
  if (t === '/new') return { name: 'new' }
  if (t === '/stop') return { name: 'stop' }
  if (t === '/status') return { name: 'status' }
  if (t === '/sessions') return { name: 'sessions' }
  if (t === '/help') return { name: 'help' }
  if (t === '/switch') return { name: 'switch' }
  if (t.startsWith('/switch ')) return { name: 'switch', arg: t.slice('/switch '.length).trim() }
  if (t === '/doc') return { name: 'doc' }
  if (t.startsWith('/doc ')) return { name: 'doc', arg: raw.slice('/doc '.length).trim() }
  if (t === '/ls') return { name: 'ls' }
  if (t.startsWith('/ls ')) return { name: 'ls', arg: raw.slice('/ls '.length).trim() }
  return null
}

/** 群消息正文中的 @ 占位符（@_user_1 等）剥掉，得到纯净指令文本。 */
export function stripMentionPlaceholders(text: string): string {
  return text.replace(/@_user_\d+\s*/g, '').trim()
}
