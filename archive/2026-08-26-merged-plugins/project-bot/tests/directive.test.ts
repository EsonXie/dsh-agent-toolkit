import { describe, expect, test } from 'vitest'
import { parseDirective, stripMentionPlaceholders } from '../src/core/directive.ts'

describe('parseDirective', () => {
  test('识别三个指令（忽略大小写与首尾空白）', () => {
    expect(parseDirective('/new')).toBe('new')
    expect(parseDirective('  /Stop ')).toBe('stop')
    expect(parseDirective('/STATUS')).toBe('status')
  })

  test('普通文本与带参数的指令都不算', () => {
    expect(parseDirective('你好')).toBeNull()
    expect(parseDirective('/new 请重来')).toBeNull()
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
