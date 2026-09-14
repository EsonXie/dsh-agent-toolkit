import { describe, expect, test } from 'vitest'
import { parseDirective, stripMentionPlaceholders } from './directive.ts'

describe('parseDirective', () => {
  test('识别三个原指令（忽略大小写与首尾空白）', () => {
    expect(parseDirective('/new')).toEqual({ name: 'new' })
    expect(parseDirective('  /Stop ')).toEqual({ name: 'stop' })
    expect(parseDirective('/STATUS')).toEqual({ name: 'status' })
  })

  test('识别新指令 /sessions 与 /help（整条精确匹配）', () => {
    expect(parseDirective('/sessions')).toEqual({ name: 'sessions' })
    expect(parseDirective('  /Help ')).toEqual({ name: 'help' })
  })

  test('/switch 带参：首词判定，余串为 arg', () => {
    expect(parseDirective('/switch 2')).toEqual({ name: 'switch', arg: '2' })
    expect(parseDirective('/switch  a1b2c3d4 ')).toEqual({ name: 'switch', arg: 'a1b2c3d4' })
  })

  test('/switch 无参：命中且 arg 缺省（由 Inbound 提示用法）', () => {
    expect(parseDirective('/switch')).toEqual({ name: 'switch' })
  })

  test('/doc 带参：首词判定，路径参数保留原始大小写', () => {
    expect(parseDirective('/doc docs/report.md')).toEqual({ name: 'doc', arg: 'docs/report.md' })
    expect(parseDirective('/DOC  Docs/Report.MD ')).toEqual({ name: 'doc', arg: 'Docs/Report.MD' })
  })

  test('/doc 无参：命中且 arg 缺省（由 Inbound 提示用法）', () => {
    expect(parseDirective('/doc')).toEqual({ name: 'doc' })
  })

  test('/doc 前缀不误伤：/docx 不是指令', () => {
    expect(parseDirective('/docx')).toBeNull()
  })

  test('/ls 带参：首词判定，路径参数保留原始大小写', () => {
    expect(parseDirective('/ls docs')).toEqual({ name: 'ls', arg: 'docs' })
    expect(parseDirective('/LS  Docs/Sub key word ')).toEqual({ name: 'ls', arg: 'Docs/Sub key word' })
  })

  test('/ls 无参与尾空白：命中且 arg 缺省', () => {
    expect(parseDirective('/ls')).toEqual({ name: 'ls' })
    expect(parseDirective('/ls  ')).toEqual({ name: 'ls' })
  })

  test('/ls 前缀不误伤：/lsx 不是指令', () => {
    expect(parseDirective('/lsx')).toBeNull()
  })

  test('普通文本与带参数的精确指令都不算', () => {
    expect(parseDirective('你好')).toBeNull()
    expect(parseDirective('/new 请重来')).toBeNull()
    expect(parseDirective('/sessions 请')).toBeNull()
    expect(parseDirective('/unknown')).toBeNull()
  })
})

describe('stripMentionPlaceholders', () => {
  test('剥掉群消息里的 @ 占位符', () => {
    expect(stripMentionPlaceholders('@_user_1 帮我看看')).toBe('帮我看看')
    expect(stripMentionPlaceholders('@_user_1 @_user_2 在吗')).toBe('在吗')
  })

  test('无占位符时原样（trim 后）', () => {
    expect(stripMentionPlaceholders('  hello  ')).toBe('hello')
  })
})
