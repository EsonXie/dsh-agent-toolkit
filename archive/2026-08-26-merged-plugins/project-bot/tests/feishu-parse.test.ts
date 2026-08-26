import { describe, expect, test } from 'vitest'
import { MessageDedup, parseMessageEvent } from '../src/channels/feishu/parse.ts'

function event(overrides: Record<string, unknown> = {}): unknown {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_u1' } },
    message: {
      message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p',
      message_type: 'text', content: JSON.stringify({ text: '你好' }),
      mentions: [],
    },
    ...overrides,
  }
}

function groupEvent(mentions: unknown[], text: string): unknown {
  return event({
    message: {
      message_id: 'om_g', chat_id: 'oc_g', chat_type: 'group',
      message_type: 'text', content: JSON.stringify({ text }), mentions,
    },
  })
}

describe('parseMessageEvent', () => {
  test('p2p 文本消息解析成功', () => {
    expect(parseMessageEvent(event())).toEqual({
      messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', userId: 'ou_u1', text: '你好',
    })
  })

  test('群消息：未 @机器人 → null；@人不算；@机器人 → 剥占位符', () => {
    expect(parseMessageEvent(groupEvent([], '你好'))).toBeNull()
    expect(parseMessageEvent(groupEvent([{ mentioned_type: 'user' }], '@_user_1 你好'))).toBeNull()
    expect(parseMessageEvent(groupEvent([{ mentioned_type: 'bot' }], '@_user_1 帮我看看')))
      .toMatchObject({ text: '帮我看看', chatType: 'group' })
  })

  test('机器人自己的消息 / 非文本消息 / 坏 content → null', () => {
    expect(parseMessageEvent(event({ sender: { sender_type: 'bot', sender_id: { open_id: 'ou_b' } } }))).toBeNull()
    expect(parseMessageEvent(event({
      message: { message_id: 'om_3', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'image', content: '{}', mentions: [] },
    }))).toBeNull()
    expect(parseMessageEvent(event({
      message: { message_id: 'om_4', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: 'not-json', mentions: [] },
    }))).toBeNull()
  })

  test('空文本（只有 @ 占位符）→ null', () => {
    expect(parseMessageEvent(groupEvent([{ mentioned_type: 'bot' }], '@_user_1'))).toBeNull()
  })
})

describe('MessageDedup', () => {
  test('重复 message_id 拒绝；超容量 FIFO 淘汰最旧', () => {
    const dedup = new MessageDedup(2)
    expect(dedup.check('a')).toBe(true)
    expect(dedup.check('a')).toBe(false)
    expect(dedup.check('b')).toBe(true)
    expect(dedup.check('c')).toBe(true)   // 淘汰 a
    expect(dedup.check('a')).toBe(true)
  })
})
