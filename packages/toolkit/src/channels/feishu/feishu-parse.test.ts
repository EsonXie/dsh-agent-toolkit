import { describe, expect, test } from 'vitest'
import { MessageDedup, parseMessageEvent, parseRecallEvent, unsupportedNoticeText } from './parse.ts'
import type { ParsedMessage, ParseResult } from './parse.ts'

/** 断言结果是 message 形态并取出。 */
function expectMessage(result: ParseResult | null): ParsedMessage {
  if (result === null || result.kind !== 'message') {
    throw new Error(`expected message, got ${JSON.stringify(result)}`)
  }
  return result.message
}

/** 本机器人 open_id（渠道启动时经 bot/v3/info 取回）。 */
const BOT = 'ou_bot_self'

/** 真实事件 mention 形态：key/id/mentioned_type/name。 */
function mention(mentionedType: string, openId?: string): unknown {
  return { key: '@_user_1', id: { open_id: openId }, mentioned_type: mentionedType, name: 'x' }
}

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
    expect(expectMessage(parseMessageEvent(event(), BOT))).toEqual({
      messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', userId: 'ou_u1', text: '你好', imageKeys: [],
    })
  })

  test('群消息：未 @机器人 → null；@人不算；@本机器人 → 剥占位符', () => {
    expect(parseMessageEvent(groupEvent([], '你好'), BOT)).toBeNull()
    expect(parseMessageEvent(groupEvent([mention('user', 'ou_u2')], '@_user_1 你好'), BOT)).toBeNull()
    expect(expectMessage(parseMessageEvent(groupEvent([mention('bot', BOT)], '@_user_1 帮我看看'), BOT)))
      .toMatchObject({ text: '帮我看看', chatType: 'group' })
  })

  test('群消息：@的是群里另一个机器人 → null（open_id 必须匹配本机器人）', () => {
    expect(parseMessageEvent(groupEvent([mention('bot', 'ou_other_bot')], '@_user_1 帮我看看'), BOT)).toBeNull()
    // 混合 mention：@了别人和别的机器人，仍不算
    expect(parseMessageEvent(groupEvent([mention('user', 'ou_u2'), mention('bot', 'ou_other_bot')], '@_user_1 @_user_2 在吗'), BOT)).toBeNull()
    // mention 缺 id/open_id → 不匹配
    expect(parseMessageEvent(groupEvent([{ key: '@_user_1', mentioned_type: 'bot', name: 'x' }], '@_user_1 在吗'), BOT)).toBeNull()
  })

  test('机器人自己的消息 / 坏 content → null', () => {
    expect(parseMessageEvent(event({ sender: { sender_type: 'bot', sender_id: { open_id: 'ou_b' } } }), BOT)).toBeNull()
    expect(parseMessageEvent(event({
      message: { message_id: 'om_4', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: 'not-json', mentions: [] },
    }), BOT)).toBeNull()
  })

  test('空文本（只有 @ 占位符）→ null', () => {
    expect(parseMessageEvent(groupEvent([mention('bot', BOT)], '@_user_1'), BOT)).toBeNull()
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
    expect(expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_p', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT))).toEqual({
      messageId: 'om_p', chatId: 'oc_1', chatType: 'p2p', userId: 'ou_u1',
      text: '图片消息\n帮我看 [链接文字](https://x)\n第二段',
      imageKeys: ['img_v1_a', 'img_v1_b'],
    })
  })

  test('a 标签：href 等于 text 或 href 空 → 退化为纯文本', () => {
    const content = JSON.stringify({ content: [[
      { tag: 'a', text: 'https://x', href: 'https://x' },
      { tag: 'a', text: '裸文字', href: '' },
      { tag: 'a', text: '无href' },
    ]] })
    expect(expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_a', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT)).text).toBe('https://x裸文字无href')
  })

  test('post 空标题 / 无标题 → 不产生首行', () => {
    const content = JSON.stringify({ title: '  ', content: [[{ tag: 'text', text: '正文' }]] })
    expect(expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_t', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT)).text).toBe('正文')
  })

  test('media 节点 → 行内占位；带 file_name 时附名', () => {
    const content = JSON.stringify({ content: [[
      { tag: 'text', text: '看这个' },
      { tag: 'media', file_key: 'file_v1_x', file_name: '演示.mp4' },
      { tag: 'media', file_key: 'file_v1_y' },
    ]] })
    expect(expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_m', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT)).text).toBe('看这个[附件: 演示.mp4][附件]')
  })

  test('code_block：语言映射 + 独立成段（前后文不粘同段）', () => {
    const content = JSON.stringify({ content: [
      [{ tag: 'text', text: '报错如下' }, { tag: 'code_block', language: 49, text: 'print(1)' }, { tag: 'text', text: '帮忙看看' }],
    ] })
    expect(expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_c', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT)).text).toBe('报错如下\n```python\nprint(1)\n```\n帮忙看看')
  })

  test('code_block：表外语言/缺 language → 省略语言名；连续代码块各自成段', () => {
    const content = JSON.stringify({ content: [
      [{ tag: 'code_block', language: 999, text: 'a' }],
      [{ tag: 'code_block', text: 'b' }],
    ] })
    expect(expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_c2', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT)).text).toBe('```\na\n```\n```\nb\n```')
  })

  test('code_block：不再记 skip-tag 日志', () => {
    const events: { event: string; [key: string]: unknown }[] = []
    const content = JSON.stringify({ content: [[{ tag: 'code_block', language: 63, text: 'let x = 1' }]] })
    parseMessageEvent(event({
      message: { message_id: 'om_c3', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT, (e) => { events.push(e) })
    expect(events).toEqual([])
  })

  test('未知标签跳过 + feishu.parse.skip-tag 日志（at/emotion 同样记录）', () => {
    const events: { event: string; [key: string]: unknown }[] = []
    const content = JSON.stringify({ content: [[
      { tag: 'text', text: 'hi' },
      { tag: 'hr' },
      { tag: 'at', user_id: 'ou_x' },
      { tag: 'emotion', emoji_type: 'SMILE' },
    ]] })
    const msg = expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_k', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT, (e) => { events.push(e) }))
    expect(msg.text).toBe('hi')
    expect(events).toEqual([
      { event: 'feishu.parse.skip-tag', tag: 'hr', messageId: 'om_k' },
      { event: 'feishu.parse.skip-tag', tag: 'at', messageId: 'om_k' },
      { event: 'feishu.parse.skip-tag', tag: 'emotion', messageId: 'om_k' },
    ])
  })

  test('纯图片消息（image）：无文本但有 image_key', () => {
    expect(expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_i', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'image', content: JSON.stringify({ image_key: 'img_v1_c' }), mentions: [] },
    }), BOT))).toMatchObject({ text: '', imageKeys: ['img_v1_c'] })
  })

  test('post 图片节点缺 image_key / image 消息缺 image_key → 忽略该图；全空 → null', () => {
    const badImg = event({
      message: { message_id: 'om_x', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content: JSON.stringify({ content: [[{ tag: 'img' }]] }), mentions: [] },
    })
    expect(parseMessageEvent(badImg, BOT)).toBeNull()
    const emptyImage = event({
      message: { message_id: 'om_y', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'image', content: '{}', mentions: [] },
    })
    expect(parseMessageEvent(emptyImage, BOT)).toBeNull()
  })

  test('群 post：未 @机器人 → null', () => {
    expect(parseMessageEvent(event({
      message: {
        message_id: 'om_pg', chat_id: 'oc_g', chat_type: 'group', message_type: 'post',
        content: JSON.stringify({ content: [[{ tag: 'text', text: 'hi' }]] }), mentions: [],
      },
    }), BOT)).toBeNull()
  })

  test('不支持的消息类型 → unsupported 标记（字段完整，threadId 透传）', () => {
    for (const messageType of ['file', 'media', 'audio', 'merge_forward']) {
      const result = parseMessageEvent(event({
        message: {
          message_id: `om_${messageType}`, chat_id: 'oc_1', chat_type: 'p2p',
          message_type: messageType, content: '{}', mentions: [],
        },
      }), BOT)
      expect(result).toEqual({
        kind: 'unsupported',
        unsupported: {
          messageId: `om_${messageType}`, chatId: 'oc_1', chatType: 'p2p',
          userId: 'ou_u1', messageType,
        },
      })
    }
    // 未知类型同样 unsupported
    const unknown = parseMessageEvent(event({
      message: { message_id: 'om_u', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'hongbao', content: '{}', mentions: [] },
    }), BOT)
    expect(unknown).toMatchObject({ kind: 'unsupported', unsupported: { messageType: 'hongbao' } })
    // 话题内 unsupported 透传 threadId
    const threaded = parseMessageEvent(event({
      message: {
        message_id: 'om_ut', chat_id: 'oc_g', chat_type: 'group', message_type: 'file',
        thread_id: 'omt_1', content: '{}', mentions: [mention('bot', BOT)],
      },
    }), BOT)
    expect(threaded).toMatchObject({ kind: 'unsupported', unsupported: { threadId: 'omt_1' } })
  })

  test('群消息未 @机器人：unsupported 类型也不回提示（null）', () => {
    expect(parseMessageEvent(event({
      message: { message_id: 'om_f', chat_id: 'oc_g', chat_type: 'group', message_type: 'file', content: '{}', mentions: [] },
    }), BOT)).toBeNull()
  })

  test('sticker → null + feishu.parse.ignored 日志', () => {
    const events: { event: string; [key: string]: unknown }[] = []
    const sink = (e: { event: string; [key: string]: unknown }): void => { events.push(e) }
    const result = parseMessageEvent(event({
      message: { message_id: 'om_s', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'sticker', content: '{}', mentions: [] },
    }), BOT, sink)
    expect(result).toBeNull()
    expect(events).toEqual([{ event: 'feishu.parse.ignored', reason: 'sticker', messageId: 'om_s', chatId: 'oc_1' }])
  })

  test('群消息未 @机器人：sticker 也不写 ignored 日志（先过滤）', () => {
    const events: { event: string; [key: string]: unknown }[] = []
    parseMessageEvent(event({
      message: { message_id: 'om_s2', chat_id: 'oc_g', chat_type: 'group', message_type: 'sticker', content: '{}', mentions: [] },
    }), BOT, (e) => { events.push(e) })
    expect(events).toEqual([])
  })
})

describe('unsupportedNoticeText', () => {
  test('各类型文案', () => {
    expect(unsupportedNoticeText('file')).toBe('暂不支持文件消息，请发送文字或截图')
    expect(unsupportedNoticeText('media')).toBe('暂不支持视频消息')
    expect(unsupportedNoticeText('audio')).toBe('暂不支持语音消息')
    expect(unsupportedNoticeText('merge_forward')).toBe('暂不支持合并转发消息')
    expect(unsupportedNoticeText('hongbao')).toBe('暂不支持该类型消息（hongbao）')
  })
})

test('recalled 事件：提取 message_id/chat_id；兼容 { event } 包裹；字段缺失返回 null', () => {
  expect(parseRecallEvent({ event: { message_id: 'om_1', chat_id: 'oc_1', recall_type: 'message_owner' } }))
    .toEqual({ messageId: 'om_1', chatId: 'oc_1' })
  expect(parseRecallEvent({ message_id: 'om_2', chat_id: 'oc_2' })).toEqual({ messageId: 'om_2', chatId: 'oc_2' })
  expect(parseRecallEvent({ event: { chat_id: 'oc_1' } })).toBeNull()
  expect(parseRecallEvent({})).toBeNull()
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

test('话题群消息透传 threadId', () => {
  const event = {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_u1' } },
    message: {
      message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', message_type: 'text',
      thread_id: 'omt_abc',
      content: JSON.stringify({ text: 'hi' }),
      mentions: [{ mentioned_type: 'bot', id: { open_id: BOT } }],
    },
  }
  const parsed = expectMessage(parseMessageEvent(event, BOT))
  expect(parsed.threadId).toBe('omt_abc')
})

test('普通群消息 threadId 缺席', () => {
  const event = {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_u1' } },
    message: {
      message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text: 'hi' }),
      mentions: [{ mentioned_type: 'bot', id: { open_id: BOT } }],
    },
  }
  const parsed = expectMessage(parseMessageEvent(event, BOT))
  expect(parsed.threadId).toBeUndefined()
})
