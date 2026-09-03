import { describe, expect, test } from 'vitest'
import { MessageDedup, parseMessageEvent } from './parse.ts'

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
      messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', userId: 'ou_u1', text: '你好', imageKeys: [],
    })
  })

  test('群消息：未 @机器人 → null；@人不算；@机器人 → 剥占位符', () => {
    expect(parseMessageEvent(groupEvent([], '你好'))).toBeNull()
    expect(parseMessageEvent(groupEvent([{ mentioned_type: 'user' }], '@_user_1 你好'))).toBeNull()
    expect(parseMessageEvent(groupEvent([{ mentioned_type: 'bot' }], '@_user_1 帮我看看')))
      .toMatchObject({ text: '帮我看看', chatType: 'group' })
  })

  test('机器人自己的消息 / 坏 content → null', () => {
    expect(parseMessageEvent(event({ sender: { sender_type: 'bot', sender_id: { open_id: 'ou_b' } } }))).toBeNull()
    expect(parseMessageEvent(event({
      message: { message_id: 'om_4', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: 'not-json', mentions: [] },
    }))).toBeNull()
  })

  test('空文本（只有 @ 占位符）→ null', () => {
    expect(parseMessageEvent(groupEvent([{ mentioned_type: 'bot' }], '@_user_1'))).toBeNull()
  })

  test('图片+文字（post）：抽取文本节点拼接与 image_key，跳过 at/a 非文本属性', () => {
    const content = JSON.stringify({
      title: '图片消息',
      content: [[
        { tag: 'text', text: '帮我看 ' },
        { tag: 'at', user_id: 'ou_x' },
        { tag: 'a', text: '链接文字', href: 'https://x' },
        { tag: 'img', image_key: 'img_v1_a' },
      ], [
        { tag: 'text', text: '第二段' },
        { tag: 'img', image_key: 'img_v1_b' },
      ]],
    })
    expect(parseMessageEvent(event({
      message: { message_id: 'om_p', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }))).toEqual({
      messageId: 'om_p', chatId: 'oc_1', chatType: 'p2p', userId: 'ou_u1',
      text: '帮我看 链接文字\n第二段',
      imageKeys: ['img_v1_a', 'img_v1_b'],
    })
  })

  test('纯图片消息（image）：无文本但有 image_key', () => {
    expect(parseMessageEvent(event({
      message: { message_id: 'om_i', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'image', content: JSON.stringify({ image_key: 'img_v1_c' }), mentions: [] },
    }))).toMatchObject({ text: '', imageKeys: ['img_v1_c'] })
  })

  test('post 图片节点缺 image_key / image 消息缺 image_key → 忽略该图；全空 → null', () => {
    const badImg = event({
      message: { message_id: 'om_x', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content: JSON.stringify({ content: [[{ tag: 'img' }]] }), mentions: [] },
    })
    expect(parseMessageEvent(badImg)).toBeNull()
    const emptyImage = event({
      message: { message_id: 'om_y', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'image', content: '{}', mentions: [] },
    })
    expect(parseMessageEvent(emptyImage)).toBeNull()
  })

  test('群 post：未 @机器人 → null', () => {
    expect(parseMessageEvent(event({
      message: {
        message_id: 'om_pg', chat_id: 'oc_g', chat_type: 'group', message_type: 'post',
        content: JSON.stringify({ content: [[{ tag: 'text', text: 'hi' }]] }), mentions: [],
      },
    }))).toBeNull()
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
