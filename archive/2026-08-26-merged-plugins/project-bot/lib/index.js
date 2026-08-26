import { existsSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { SessionId } from "@deepseek-ai/dsh-session";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { randomBytes, randomUUID } from "node:crypto";
import { z as z$1 } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import * as lark from "@larksuiteoapi/node-sdk";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/store.ts
/** project-bot 存储域声明：身份、版本、记录 zod schema 的单一来源。 */
/** 飞书自建应用 appId 形态（WSClient 同款校验）。 */
const FEISHU_APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/;
/** CredentialRef 字符集（credentials 服务 credentialRef() 的校验规则）。 */
const CREDENTIAL_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** bot id：小写 slug。 */
const BOT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const FeishuConfigSchema = z$1.object({
	appId: z$1.string().regex(FEISHU_APP_ID_RE),
	appSecretRef: z$1.string().regex(CREDENTIAL_REF_RE)
});
const BotRecordSchema = z$1.object({
	id: z$1.string().regex(BOT_ID_RE),
	name: z$1.string().min(1).max(64),
	channel: z$1.literal("feishu"),
	feishu: FeishuConfigSchema,
	/** 绑定项目（agent 的 cwd，绝对路径）。一 bot 一项目。 */
	project: z$1.string().min(1),
	/** 透传到 agent 创作期的 persona 提示段。 */
	persona: z$1.string().max(8e3).optional(),
	/** 挂载的 agent preset id（缺省 = 名册默认 preset）。 */
	preset: z$1.string().min(1).optional(),
	/** 可用工具白名单（缺省 = 不限制）；空数组无意义，直接拒绝。 */
	tools: z$1.array(z$1.string().min(1)).min(1).optional(),
	agentOptions: z$1.object({
		provider: z$1.string().min(1).optional(),
		model: z$1.string().min(1).optional()
	}).optional(),
	createdAt: z$1.number().int().nonnegative(),
	updatedAt: z$1.number().int().nonnegative()
});
const BindingSchema = z$1.object({ sessionId: z$1.string().min(1) });
/** domain 名受 UNIT_NAME_RE 约束（^[a-z][a-z0-9_]*$），不允许连字符。 */
const projectBotDomain = defineDomain({
	name: "project_bot",
	version: 1,
	tables: {
		bots: domainTable(BotRecordSchema),
		bindings: domainTable(BindingSchema)
	}
});
/** bindings 表 key：(botId, chatId) → sessionId。 */
function bindingKey(botId, chatId) {
	return `${botId}:${chatId}`;
}
//#endregion
//#region src/api.ts
/** 浏览器半 RPC：单前缀路由 /project-bot/api + 内部路径分发。 */
const MAX_BODY_BYTES = 65536;
const CreateBodySchema = z$1.object({
	/** 缺省时后端自动生成（bot-<8 位随机小写字母数字>）。 */
	id: z$1.string().regex(BOT_ID_RE).optional(),
	name: z$1.string().min(1).max(64),
	project: z$1.string().min(1),
	persona: z$1.string().max(8e3).optional(),
	preset: z$1.string().min(1).optional(),
	tools: z$1.array(z$1.string().min(1)).min(1).optional(),
	agentOptions: z$1.object({
		provider: z$1.string().min(1).optional(),
		model: z$1.string().min(1).optional()
	}).optional(),
	feishu: z$1.object({
		appId: z$1.string().regex(FEISHU_APP_ID_RE),
		/** 手动填写路径：明文密钥（立即入 credentials，不落表）。 */
		appSecret: z$1.string().min(1).optional(),
		/** 扫码路径：registerApp 已入库，直接给引用。 */
		appSecretRef: z$1.string().optional()
	})
});
const UpdateBodySchema = z$1.object({
	name: z$1.string().min(1).max(64).optional(),
	project: z$1.string().min(1).optional(),
	persona: z$1.string().max(8e3).nullable().optional(),
	preset: z$1.string().min(1).nullable().optional(),
	tools: z$1.array(z$1.string().min(1)).min(1).nullable().optional(),
	agentOptions: z$1.object({
		provider: z$1.string().min(1).optional(),
		model: z$1.string().min(1).optional()
	}).nullable().optional(),
	/** 换绑应用：明文新密钥（立即入 credentials）。 */
	feishu: z$1.object({
		appId: z$1.string().regex(FEISHU_APP_ID_RE),
		appSecret: z$1.string().min(1)
	}).optional()
});
function json(res, code, body) {
	res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
}
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
/** 生成 bot-<8 位随机小写字母数字>（符合 BOT_ID_RE）；与现有 id 冲突时重试。 */
function generateBotId(occupied) {
	for (;;) {
		const bytes = randomBytes(8);
		let id = "bot-";
		for (let i = 0; i < 8; i++) id += ID_CHARS[bytes[i] % 36];
		if (!occupied(id)) return id;
	}
}
/** 读 JSON body；超限 413 / 非法 JSON 400（已写响应时返回 undefined）。 */
async function readJsonBody(req, res) {
	const chunks = [];
	let received = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		received += buffer.byteLength;
		if (received > MAX_BODY_BYTES) {
			json(res, 413, { error: "body too large" });
			req.destroy();
			return;
		}
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		json(res, 400, { error: "invalid JSON body" });
		return;
	}
}
function createApiHandler(deps) {
	return async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const sub = url.pathname.replace(/^\/project-bot\/api/, "") || "/";
		const method = req.method ?? "GET";
		if (sub === "/bots" && method === "GET") {
			json(res, 200, { bots: [...deps.bots.entries()].map(([, record]) => ({
				...record,
				status: deps.runtime.statusOf(record.id)
			})) });
			return;
		}
		if (sub === "/bots" && method === "POST") {
			const body = await readJsonBody(req, res);
			if (body === void 0) return;
			const parsed = CreateBodySchema.safeParse(body);
			if (!parsed.success) {
				json(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid body" });
				return;
			}
			const input = parsed.data;
			const id = input.id ?? generateBotId((candidate) => deps.bots.get(candidate) !== void 0);
			if (deps.bots.get(id) !== void 0) {
				json(res, 409, { error: `bot id "${id}" 已存在` });
				return;
			}
			for (const [, existing] of deps.bots.entries()) if (existing.feishu.appId === input.feishu.appId) {
				json(res, 409, { error: `appId 已被 bot "${existing.id}" 使用` });
				return;
			}
			if (!deps.validateProject(input.project)) {
				json(res, 400, { error: `项目路径不可用：${input.project}` });
				return;
			}
			let appSecretRef = input.feishu.appSecretRef;
			if (appSecretRef === void 0) {
				if (input.feishu.appSecret === void 0) {
					json(res, 400, { error: "缺少 appSecret 或 appSecretRef" });
					return;
				}
				appSecretRef = await deps.storeSecret(id, input.feishu.appSecret);
			}
			const record = BotRecordSchema.parse({
				id,
				name: input.name,
				channel: "feishu",
				feishu: {
					appId: input.feishu.appId,
					appSecretRef
				},
				project: input.project,
				...input.persona !== void 0 ? { persona: input.persona } : {},
				...input.preset !== void 0 ? { preset: input.preset } : {},
				...input.tools !== void 0 ? { tools: input.tools } : {},
				...input.agentOptions !== void 0 ? { agentOptions: input.agentOptions } : {},
				createdAt: deps.now(),
				updatedAt: deps.now()
			});
			await deps.bots.put(record.id, record);
			await deps.runtime.reconcile(record.id);
			json(res, 200, { bot: {
				...record,
				status: deps.runtime.statusOf(record.id)
			} });
			return;
		}
		if (sub === "/bots" && method === "PUT") {
			const id = url.searchParams.get("id") ?? "";
			const existing = deps.bots.get(id);
			if (existing === void 0) {
				json(res, 404, { error: `bot "${id}" 不存在` });
				return;
			}
			const body = await readJsonBody(req, res);
			if (body === void 0) return;
			const parsed = UpdateBodySchema.safeParse(body);
			if (!parsed.success) {
				json(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid body" });
				return;
			}
			const input = parsed.data;
			let feishu = existing.feishu;
			if (input.feishu !== void 0) feishu = {
				appId: input.feishu.appId,
				appSecretRef: await deps.storeSecret(id, input.feishu.appSecret)
			};
			const project = input.project ?? existing.project;
			if (!deps.validateProject(project)) {
				json(res, 400, { error: `项目路径不可用：${project}` });
				return;
			}
			const merged = {
				...existing,
				...input.name !== void 0 ? { name: input.name } : {},
				project,
				feishu,
				updatedAt: deps.now()
			};
			if (input.persona === null) delete merged.persona;
			else if (input.persona !== void 0) merged.persona = input.persona;
			if (input.preset === null) delete merged.preset;
			else if (input.preset !== void 0) merged.preset = input.preset;
			if (input.tools === null) delete merged.tools;
			else if (input.tools !== void 0) merged.tools = input.tools;
			if (input.agentOptions === null) delete merged.agentOptions;
			else if (input.agentOptions !== void 0) merged.agentOptions = input.agentOptions;
			const record = BotRecordSchema.parse(merged);
			await deps.bots.put(id, record);
			await deps.runtime.reconcile(id);
			json(res, 200, { bot: {
				...record,
				status: deps.runtime.statusOf(id)
			} });
			return;
		}
		if (sub === "/bots" && method === "DELETE") {
			const id = url.searchParams.get("id") ?? "";
			const existing = deps.bots.get(id);
			if (existing === void 0) {
				json(res, 404, { error: `bot "${id}" 不存在` });
				return;
			}
			await deps.runtime.stopBot(id);
			await deps.bots.delete(id);
			await deps.deleteSecret(existing.feishu.appSecretRef);
			json(res, 200, { ok: true });
			return;
		}
		if (sub === "/register-app" && method === "POST") {
			json(res, 200, { id: deps.registerApp.start() });
			return;
		}
		if (sub === "/register-app/status" && method === "GET") {
			const id = url.searchParams.get("id") ?? "";
			const state = deps.registerApp.get(id);
			if (state === void 0) {
				json(res, 404, { error: "register session 不存在" });
				return;
			}
			json(res, 200, { state });
			return;
		}
		if (sub === "/tools" && method === "GET") {
			json(res, 200, { tools: deps.listTools() });
			return;
		}
		if (sub === "/presets" && method === "GET") {
			let presets = [];
			try {
				presets = await deps.listPresets();
			} catch {
				presets = [];
			}
			json(res, 200, { presets });
			return;
		}
		if (sub === "/providers" && method === "GET") {
			json(res, 200, { providers: deps.listProviders() });
			return;
		}
		if (sub === "/models" && method === "GET") {
			let models = [];
			try {
				models = await deps.listModels(url.searchParams.get("provider") ?? "");
			} catch {
				models = [];
			}
			json(res, 200, { models });
			return;
		}
		if ([
			"/bots",
			"/register-app",
			"/register-app/status",
			"/tools",
			"/presets",
			"/providers",
			"/models"
		].includes(sub)) {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		json(res, 404, { error: "not found" });
	};
}
//#endregion
//#region src/channels/feishu/api.ts
/** SDK 薄封装：tenant_access_token 由 SDK 自动管理；错误带 code/msg 上下文。 */
function createFeishuApi(client) {
	return {
		async createCard(cardJson) {
			const res = await client.cardkit.v1.card.create({ data: {
				type: "card_json",
				data: cardJson
			} });
			const cardId = res.data?.card_id;
			if (typeof cardId !== "string" || cardId.length === 0) throw new Error(`cardkit 建卡失败：code=${res.code} msg=${res.msg}`);
			return cardId;
		},
		async sendCardMessage(chatId, cardId) {
			await client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "interactive",
					content: JSON.stringify({
						type: "card",
						data: { card_id: cardId }
					})
				}
			});
		},
		async updateCardElement(cardId, elementId, content, sequence) {
			await client.cardkit.v1.cardElement.content({
				path: {
					card_id: cardId,
					element_id: elementId
				},
				data: {
					content,
					sequence
				}
			});
		},
		async insertElement(cardId, elementJson, targetElementId, sequence) {
			await client.cardkit.v1.cardElement.create({
				path: { card_id: cardId },
				data: {
					type: "insert_before",
					target_element_id: targetElementId,
					elements: `[${elementJson}]`,
					sequence
				}
			});
		},
		async setCardStreaming(cardId, streaming, sequence, summary) {
			await client.cardkit.v1.card.settings({
				path: { card_id: cardId },
				data: {
					settings: JSON.stringify({ config: {
						streaming_mode: streaming,
						...summary !== void 0 ? { summary: { content: summary } } : {}
					} }),
					sequence
				}
			});
		},
		async replaceCard(cardId, cardJson, sequence) {
			await client.cardkit.v1.card.update({
				path: { card_id: cardId },
				data: {
					card: {
						type: "card_json",
						data: cardJson
					},
					sequence
				}
			});
		},
		async sendText(chatId, text) {
			await client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "text",
					content: JSON.stringify({ text })
				}
			});
		},
		async addReaction(messageId, emojiType) {
			const res = await client.im.messageReaction.create({
				path: { message_id: messageId },
				data: { reaction_type: { emoji_type: emojiType } }
			});
			const reactionId = res.data?.reaction_id;
			if (typeof reactionId !== "string") throw new Error(`加表情失败：code=${res.code} msg=${res.msg}`);
			return reactionId;
		},
		async removeReaction(messageId, reactionId) {
			await client.im.messageReaction.delete({ path: {
				message_id: messageId,
				reaction_id: reactionId
			} });
		}
	};
}
//#endregion
//#region src/core/directive.ts
/** 仅当整条消息就是一个指令时命中；带参数/前后文的按普通消息处理。 */
function parseDirective(text) {
	const t = text.trim().toLowerCase();
	if (t === "/new") return "new";
	if (t === "/stop") return "stop";
	if (t === "/status") return "status";
	return null;
}
/** 群消息正文中的 @ 占位符（@_user_1 等）剥掉，得到纯净指令文本。 */
function stripMentionPlaceholders(text) {
	return text.replace(/@_user_\d+\s*/g, "").trim();
}
//#endregion
//#region src/channels/feishu/parse.ts
/** im.message.receive_v1 事件解析：窄化为渠道无关的 ParsedMessage；message_id 去重。 */
/**
* SDK handler 收到的 data 即事件体（README 示例 `data.message` 直接解构）；
* 兼容包一层 { event } 的形态。过滤：机器人消息、非文本、群内未 @机器人、空文本。
*/
function parseMessageEvent(data) {
	const wrapped = data;
	const event = wrapped.event ?? wrapped;
	if (event.sender?.sender_type !== "user") return null;
	const userId = event.sender.sender_id?.open_id;
	const msg = event.message;
	if (typeof userId !== "string" || msg === void 0) return null;
	if (msg.message_type !== "text" || typeof msg.content !== "string") return null;
	if (typeof msg.message_id !== "string" || typeof msg.chat_id !== "string") return null;
	if (msg.chat_type !== "p2p" && msg.chat_type !== "group") return null;
	if (msg.chat_type === "group" && !(msg.mentions ?? []).some((m) => m.mentioned_type === "bot")) return null;
	let text;
	try {
		const parsed = JSON.parse(msg.content);
		if (typeof parsed.text !== "string") return null;
		text = stripMentionPlaceholders(parsed.text);
	} catch {
		return null;
	}
	if (text.length === 0) return null;
	return {
		messageId: msg.message_id,
		chatId: msg.chat_id,
		chatType: msg.chat_type,
		userId,
		text
	};
}
/** message_id 去重（飞书会重推）；FIFO 容量淘汰。 */
var MessageDedup = class {
	cap;
	seen = /* @__PURE__ */ new Set();
	order = [];
	constructor(cap = 1e3) {
		this.cap = cap;
	}
	/** true = 新消息。 */
	check(id) {
		if (this.seen.has(id)) return false;
		this.seen.add(id);
		this.order.push(id);
		if (this.order.length > this.cap) this.seen.delete(this.order.shift());
		return true;
	}
};
//#endregion
//#region src/channels/feishu/cards.ts
const STATUS_ELEMENT_ID = "status";
/** create 未返回真实 card_id 前的占位哨兵（executor 赋值；防并发 flush 重复建卡）。 */
const PENDING_CARD_ID = "__pending__";
/** 过程区截尾后的头部省略标记。 */
const PROCESS_OMITTED = "…（已省略前文）\n";
/** 输出中状态行文案。 */
const STATUS_STREAMING = "⏳ 输出中…";
/** 定格状态行文案。 */
const STATUS_FINAL = {
	done: "✅ 输出完成",
	error: "❌ 输出出错",
	cancelled: "⏹ 已取消"
};
/** 新卡固定开销字节数（状态行 + 结构，粗算进预算）。 */
const CARD_FIXED_BYTES = 64;
/** 单卡组件数安全上限（飞书硬上限 200；面板按 2 计：面板 + 内嵌 markdown）。 */
const CARD_ELEMENT_LIMIT = 190;
/** 按 UTF-8 字节上限截头（保留头部），不劈开多字节字符与代理对。 */
function sliceByBytes(text, maxBytes) {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) lo = mid;
		else hi = mid - 1;
	}
	let cut = lo;
	if (cut > 0) {
		const code = text.charCodeAt(cut - 1);
		if (code >= 55296 && code <= 56319) cut -= 1;
	}
	return text.slice(0, cut);
}
/** 按 UTF-8 字节上限截尾（保留尾部），不劈开多字节字符与代理对；截断时头部加省略标记。 */
function sliceTailByBytes(text, maxBytes) {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const budget = maxBytes - Buffer.byteLength(PROCESS_OMITTED, "utf8");
	if (budget <= 0) throw new Error(`processMaxBytes=${maxBytes} 过小，连省略标记都容纳不了`);
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (Buffer.byteLength(text.slice(mid), "utf8") <= budget) hi = mid;
		else lo = mid + 1;
	}
	let cut = lo;
	if (cut < text.length) {
		const code = text.charCodeAt(cut);
		if (code >= 56320 && code <= 57343) cut += 1;
	}
	return PROCESS_OMITTED + text.slice(cut);
}
/** 新卡：仅状态行的流式卡；段后续经插入组件 API 动态加入。 */
function buildCardJson() {
	return JSON.stringify({
		schema: "2.0",
		config: {
			streaming_mode: true,
			summary: { content: "生成中…" },
			streaming_config: {
				print_frequency_ms: { default: 70 },
				print_step: { default: 1 },
				print_strategy: "fast"
			}
		},
		body: { elements: [{
			tag: "markdown",
			content: STATUS_STREAMING,
			element_id: STATUS_ELEMENT_ID
		}] }
	});
}
/** 段元素 JSON（insert op 负载）：process = 默认收起折叠面板；text = 纯 markdown。 */
function buildSegmentJson(kind, elementId, content) {
	if (kind === "process") return JSON.stringify({
		tag: "collapsible_panel",
		expanded: false,
		header: { title: {
			tag: "plain_text",
			content: "思考与工具调用过程"
		} },
		elements: [{
			tag: "markdown",
			content,
			element_id: elementId
		}]
	});
	return JSON.stringify({
		tag: "markdown",
		content,
		element_id: elementId
	});
}
const initialStreamState = () => ({
	cardId: null,
	seq: 0,
	cardBytes: 0,
	cardElements: 0,
	segCounter: 0,
	closedSegCount: 0,
	tail: void 0,
	carry: void 0
});
/** 把段序列的新增部分同步到卡片；新段 insert 到状态行之前，尾段增长走元素 update，满卡关流开续卡。 */
function planSync(state, segments, maxBytes, processMaxBytes) {
	const ops = [];
	let { cardId, seq, cardBytes, cardElements, segCounter, closedSegCount, tail, carry } = state;
	const ensureCard = () => {
		if (cardId !== null) return;
		ops.push({
			type: "create",
			cardJson: buildCardJson()
		});
		ops.push({ type: "send" });
		cardId = PENDING_CARD_ID;
		seq = 0;
		cardBytes = CARD_FIXED_BYTES;
		cardElements = 1;
	};
	const closeCard = () => {
		seq += 1;
		ops.push({
			type: "settings",
			streaming: false,
			sequence: seq
		});
		cardId = null;
		tail = void 0;
	};
	let i = tail?.segIndex ?? closedSegCount;
	while (i < segments.length) {
		const seg = segments[i];
		const content = seg.kind === "process" ? sliceTailByBytes(seg.content, processMaxBytes) : seg.content;
		const base = tail !== void 0 && tail.segIndex === i ? tail.base : carry?.segIndex === i ? carry.base : 0;
		const elementContent = seg.kind === "text" ? content.slice(base) : content;
		if (tail !== void 0 && tail.segIndex === i) {
			if (elementContent !== tail.shownText) {
				const delta = Buffer.byteLength(elementContent, "utf8") - Buffer.byteLength(tail.shownText, "utf8");
				if (cardBytes + delta <= maxBytes) {
					seq += 1;
					ops.push({
						type: "update",
						elementId: tail.elementId,
						content: elementContent,
						sequence: seq
					});
					cardBytes += delta;
					tail = {
						...tail,
						shownText: elementContent
					};
				} else if (seg.kind === "text") {
					const piece = sliceByBytes(elementContent, Buffer.byteLength(tail.shownText, "utf8") + (maxBytes - cardBytes));
					if (piece.length > tail.shownText.length) {
						seq += 1;
						ops.push({
							type: "update",
							elementId: tail.elementId,
							content: piece,
							sequence: seq
						});
						cardBytes += Buffer.byteLength(piece, "utf8") - Buffer.byteLength(tail.shownText, "utf8");
						tail = {
							...tail,
							shownText: piece
						};
					}
					carry = {
						segIndex: i,
						base: tail.base + tail.shownText.length
					};
					closeCard();
					continue;
				} else {
					closeCard();
					continue;
				}
			}
			if (i === segments.length - 1) break;
			tail = void 0;
			closedSegCount = i + 1;
			carry = void 0;
			i += 1;
			continue;
		}
		if (seg.kind === "process") {
			const windowBytes = Buffer.byteLength(elementContent, "utf8");
			if (cardId !== null && (cardBytes + windowBytes > maxBytes || cardElements + 2 > CARD_ELEMENT_LIMIT)) {
				closeCard();
				continue;
			}
			ensureCard();
			segCounter += 1;
			const elementId = `seg_${segCounter}`;
			seq += 1;
			ops.push({
				type: "insert",
				elementJson: buildSegmentJson("process", elementId, elementContent),
				sequence: seq
			});
			cardBytes += windowBytes;
			cardElements += 2;
			tail = {
				segIndex: i,
				elementId,
				base: 0,
				shownText: elementContent
			};
		} else {
			if (elementContent.length === 0) {
				closedSegCount = i + 1;
				carry = void 0;
				i += 1;
				continue;
			}
			if (cardId !== null && cardElements + 1 > CARD_ELEMENT_LIMIT) {
				closeCard();
				continue;
			}
			ensureCard();
			const piece = sliceByBytes(elementContent, maxBytes - cardBytes);
			if (piece.length === 0) throw new Error(`cardMaxBytes=${maxBytes} 过小，扣固定开销后连一个字符都容纳不了`);
			segCounter += 1;
			const elementId = `seg_${segCounter}`;
			seq += 1;
			ops.push({
				type: "insert",
				elementJson: buildSegmentJson("text", elementId, piece),
				sequence: seq
			});
			cardBytes += Buffer.byteLength(piece, "utf8");
			cardElements += 1;
			tail = {
				segIndex: i,
				elementId,
				base,
				shownText: piece
			};
			if (piece.length < elementContent.length) {
				carry = {
					segIndex: i,
					base: base + piece.length
				};
				closeCard();
				continue;
			}
		}
		carry = void 0;
		if (i === segments.length - 1) break;
		tail = void 0;
		closedSegCount = i + 1;
		i += 1;
	}
	return {
		state: {
			cardId,
			seq,
			cardBytes,
			cardElements,
			segCounter,
			closedSegCount,
			tail,
			carry
		},
		ops
	};
}
/** 定格：先 update 状态行（流式还开着），再关闭 + summary。 */
function planFinalize(state, status) {
	if (state.cardId === null) return { ops: [] };
	return { ops: [{
		type: "update",
		elementId: STATUS_ELEMENT_ID,
		content: STATUS_FINAL[status],
		sequence: state.seq + 1
	}, {
		type: "settings",
		streaming: false,
		sequence: state.seq + 2,
		summary: STATUS_FINAL[status]
	}] };
}
//#endregion
//#region src/channels/feishu/reply.ts
/** 指数退避重试（默认 3 次，300ms 起）。 */
async function withRetry(fn, attempts = 3, baseDelayMs = 300) {
	let lastError;
	for (let i = 0; i < attempts; i++) try {
		return await fn();
	} catch (error) {
		lastError = error;
		if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** i));
	}
	throw lastError;
}
var FeishuReplyHandle = class {
	api;
	chatId;
	tunables;
	log;
	state = initialStreamState();
	segments = [];
	tail = Promise.resolve();
	timer;
	finalized = false;
	constructor(api, chatId, tunables, log) {
		this.api = api;
		this.chatId = chatId;
		this.tunables = tunables;
		this.log = log;
	}
	/** 惰性建卡：无文本输出的 turn 不产生空卡片。 */
	beginTurn() {
		return Promise.resolve();
	}
	update(segments) {
		if (this.finalized) return Promise.resolve();
		this.segments = segments;
		if (this.timer === void 0) this.timer = setTimeout(() => {
			this.timer = void 0;
			this.flush();
		}, this.tunables.cardUpdateThrottleMs);
		return Promise.resolve();
	}
	async finalize(status, detail) {
		if (this.finalized) {
			await this.tail;
			return;
		}
		this.finalized = true;
		if (this.timer !== void 0) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
		this.flush();
		await this.tail;
		const { ops } = planFinalize(this.state, status);
		this.enqueue(() => this.exec(ops));
		if (this.state.cardId === null && detail !== void 0) this.enqueue(() => withRetry(() => this.api.sendText(this.chatId, detail)).then(() => void 0));
		await this.tail;
	}
	notice(text) {
		this.enqueue(() => withRetry(() => this.api.sendText(this.chatId, text)).then(() => void 0));
		return this.tail.then(() => void 0);
	}
	flush() {
		const planned = planSync(this.state, this.segments, this.tunables.cardMaxBytes, this.tunables.processMaxBytes);
		if (planned.ops.length === 0) return;
		this.state = planned.state;
		this.enqueue(() => this.exec(planned.ops));
	}
	enqueue(task) {
		this.tail = this.tail.then(task).catch((error) => {
			if (this.state.cardId === "__pending__") {
				const t = this.state.tail;
				this.state = {
					...this.state,
					cardId: null,
					...t !== void 0 ? {
						tail: void 0,
						carry: {
							segIndex: t.segIndex,
							base: t.base
						},
						closedSegCount: t.segIndex
					} : {}
				};
			}
			this.log(`[project-bot] 卡片操作失败：${error instanceof Error ? error.message : String(error)}`);
		});
	}
	async exec(ops) {
		for (const op of ops) if (op.type === "create") this.state.cardId = await withRetry(() => this.api.createCard(op.cardJson));
		else if (op.type === "send") await withRetry(() => this.api.sendCardMessage(this.chatId, this.state.cardId));
		else if (op.type === "insert") await withRetry(() => this.api.insertElement(this.state.cardId, op.elementJson, STATUS_ELEMENT_ID, op.sequence));
		else if (op.type === "update") await withRetry(() => this.api.updateCardElement(this.state.cardId, op.elementId, op.content, op.sequence));
		else await withRetry(() => this.api.setCardStreaming(this.state.cardId, op.streaming, op.sequence, op.summary));
	}
};
/** 「处理中」表情：加上后返回删除 disposer；加/删失败都静默（表情残留无害）。 */
function makeAck(api, messageId, emojiType) {
	return async () => {
		try {
			const reactionId = await api.addReaction(messageId, emojiType);
			return () => {
				api.removeReaction(messageId, reactionId).catch(() => void 0);
			};
		} catch {
			return;
		}
	};
}
//#endregion
//#region src/channels/feishu/index.ts
/** 飞书渠道：WSClient 长连接收事件 → 解析 → 核心；出站走 FeishuReplyHandle。 */
const feishuChannel = {
	type: "feishu",
	async start(bot, io, tunables, log) {
		const { appId } = bot.record.feishu;
		const api = createFeishuApi(new lark.Client({
			appId,
			appSecret: bot.secret
		}));
		const dedup = new MessageDedup();
		const dispatcher = new lark.EventDispatcher({}).register({ "im.message.receive_v1": async (data) => {
			const parsed = parseMessageEvent(data);
			if (parsed === null || !dedup.check(parsed.messageId)) return;
			const reply = new FeishuReplyHandle(api, parsed.chatId, tunables, log);
			io.onMessage({
				botId: bot.record.id,
				chatId: parsed.chatId,
				userId: parsed.userId,
				messageId: parsed.messageId,
				text: parsed.text,
				reply,
				ackProcessing: makeAck(api, parsed.messageId, tunables.processingReactionEmoji)
			});
		} });
		const ws = new lark.WSClient({
			appId,
			appSecret: bot.secret,
			loggerLevel: lark.LoggerLevel.warn
		});
		await ws.start({ eventDispatcher: dispatcher });
		return {
			close: () => {
				ws.close({ force: true });
				return Promise.resolve();
			},
			status: () => ws.getConnectionStatus().state
		};
	}
};
//#endregion
//#region src/agent-setup.ts
/**
* 组合 agent 作用域：先挂指定 preset（基础编码工具层随组合进入，与原生 UI 会话同源），
* 再叠 bot 的 persona 与 tools 白名单。顺序敏感：restrict 必须在 mount 之后，
* 否则白名单命中不到 preset 带入的工具名。presetId 为 undefined 时跳过挂载，hooks 照常注入。
*/
async function setupAgentScope(agentCtx, presets, presetId, hooks) {
	if (presets !== void 0 && presetId !== void 0) await presets.mount(agentCtx, presetId);
	if (hooks.persona !== void 0) agentCtx.systemPrompt.section({
		name: "project-bot:persona",
		order: 0,
		text: hooks.persona
	});
	if (hooks.tools !== void 0) agentCtx.tools.restrict({ allow: hooks.tools });
}
/**
* 解析待挂载的 preset id：configured（Config agentPreset）优先，缺省用名册默认。
* 服务缺失或名册不含该 id 时降级 undefined（warn 告警，含名册可用清单）——
* 会话裸跑可聊但无 preset 工具层；preset 存在但组合损坏在 mount 阶段仍响亮失败。
*/
async function resolvePresetId(presets, configured, warn) {
	if (presets === void 0) return void 0;
	try {
		return (await presets.resolve(configured)).id;
	} catch (error) {
		warn(`[project-bot] preset 解析失败，会话将无 preset 工具层：${error instanceof Error ? error.message : String(error)}`);
		return;
	}
}
//#endregion
//#region src/core/inbound.ts
/** 入站：指令分流 → 路由 → 单 in-flight 准入 → 表情回复 → followup 投递。 */
var Inbound = class {
	deps;
	constructor(deps) {
		this.deps = deps;
	}
	onMessage(msg) {
		this.handle(msg).catch(async (error) => {
			this.deps.onError(`[project-bot] 入站处理失败：${error instanceof Error ? error.message : String(error)}`);
			await msg.reply.notice("处理失败，请稍后再试").catch(() => void 0);
		});
	}
	async handle(msg) {
		const bot = this.deps.bots.get(msg.botId);
		if (bot === void 0) return;
		const directive = parseDirective(msg.text);
		if (directive === "new") {
			await this.deps.router.reset(bot, msg.chatId, msg.reply);
			await msg.reply.notice("已开启新会话");
			return;
		}
		if (directive === "stop") {
			const rt = this.deps.router.lookup(bot.id, msg.chatId);
			if (rt?.inflight !== void 0) {
				rt.agent.cancel();
				await msg.reply.notice("已请求停止当前任务");
			} else await msg.reply.notice("当前没有进行中的任务");
			return;
		}
		if (directive === "status") {
			const rt = this.deps.router.lookup(bot.id, msg.chatId);
			await msg.reply.notice(rt === void 0 ? `项目：${bot.project}\n会话：未创建（发送消息即创建）` : `项目：${bot.project}\n会话：${rt.sessionId}\n状态：${rt.inflight !== void 0 ? "处理中" : "空闲"}`);
			return;
		}
		const rt = await this.deps.router.ensure(bot, msg.chatId, msg.reply);
		if (rt.inflight !== void 0) {
			await msg.reply.notice("上一条还在处理中，请稍候（或发送 /stop 取消）");
			return;
		}
		rt.inflight = { ack: void 0 };
		rt.inflight.ack = await msg.ackProcessing().catch(() => void 0) ?? void 0;
		const message = createUserMessage({
			content: [{
				type: "text",
				text: msg.text
			}],
			source: { kind: "user" }
		});
		try {
			rt.agent.followup(message);
		} catch (error) {
			const ack = rt.inflight.ack;
			rt.inflight = void 0;
			await ack?.();
			throw error;
		}
	}
};
/** 向段序列追加内容：与尾段同类则合并，异类开新段。 */
function appendToSegments(segments, kind, text) {
	const tail = segments[segments.length - 1];
	if (tail !== void 0 && tail.kind === kind) tail.content += text;
	else segments.push({
		kind,
		content: text
	});
}
function mapTurnEnd(reason) {
	if (reason.kind === "completed") return "done";
	if (reason.kind === "aborted" || reason.kind === "interrupted") return "cancelled";
	return "error";
}
/** 截断错误摘要到 max 字符，超出追加省略号。 */
function truncateDetail(text, max) {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
/** 从 turn/end reason 提取错误摘要；非 error 或无 message 返回 undefined。 */
function errorDetailOf(reason, max) {
	if (reason.kind !== "error") return void 0;
	const message = reason.error?.message;
	return truncateDetail(typeof message === "string" && message.length > 0 ? message : "未知错误", max);
}
var Outbound = class {
	sessions;
	onError;
	maxErrorDetailChars;
	constructor(sessions, onError, maxErrorDetailChars = 500) {
		this.sessions = sessions;
		this.onError = onError;
		this.maxErrorDetailChars = maxErrorDetailChars;
	}
	handleSessionEvent(sessionId, event) {
		const rt = this.sessions.get(sessionId);
		if (rt === void 0) return;
		if (event.type === "turn/start") {
			rt.turn = {
				n: event.data.turn,
				segments: [],
				began: false
			};
			return;
		}
		if (event.type === "assistant/chunk") {
			const turn = rt.turn;
			if (turn === void 0 || turn.n !== event.data.turn) return;
			const chunk = event.data.chunk;
			if (chunk.type === "text-delta" && typeof chunk.text === "string") appendToSegments(turn.segments, "text", chunk.text);
			else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") appendToSegments(turn.segments, "process", chunk.text);
			else if (chunk.type === "block-end" && chunk.block?.type === "reasoning" && turn.segments[turn.segments.length - 1]?.kind === "process") appendToSegments(turn.segments, "process", "\n\n");
			else return;
			const snapshot = turn.segments.map((s) => ({ ...s }));
			this.enqueue(rt, async () => {
				if (rt.reply === void 0) return;
				if (!turn.began) {
					await rt.reply.beginTurn();
					turn.began = true;
				}
				await rt.reply.update(snapshot);
			});
			return;
		}
		if (event.type === "tool/call") {
			const turn = rt.turn;
			if (turn === void 0 || turn.n !== event.data.turn) return;
			const name = event.data.name;
			const args = typeof event.data.arguments === "string" ? event.data.arguments : JSON.stringify(event.data.arguments ?? {});
			appendToSegments(turn.segments, "process", `🔧 ${name} — ${truncateDetail(args, 120)}\n\n`);
			const snapshot = turn.segments.map((s) => ({ ...s }));
			this.enqueue(rt, async () => {
				if (rt.reply === void 0) return;
				if (!turn.began) {
					await rt.reply.beginTurn();
					turn.began = true;
				}
				await rt.reply.update(snapshot);
			});
			return;
		}
		if (event.type === "turn/end") {
			const turn = rt.turn;
			if (turn === void 0 || turn.n !== event.data.turn) return;
			const reason = event.data.reason;
			const status = mapTurnEnd(reason);
			const detail = errorDetailOf(reason, this.maxErrorDetailChars);
			this.enqueue(rt, async () => {
				if ((turn.began || detail !== void 0) && rt.reply !== void 0) await rt.reply.finalize(status, detail);
				const ack = rt.inflight?.ack;
				rt.inflight = void 0;
				if (ack !== void 0) await ack();
			});
			rt.turn = void 0;
		}
	}
	/**
	* turn 外错误（agent/error：resume/驱动边界失败等没有 turn/end 的场景）：
	* notice 错误摘要并释放 inflight 槽 + 删除表情；turn 进行中的错误由 turn/end 报告，跳过防双发。
	*/
	handleAgentError(sessionId, errorText) {
		const rt = this.sessions.get(sessionId);
		if (rt === void 0 || rt.turn !== void 0) return;
		const detail = truncateDetail(errorText, this.maxErrorDetailChars);
		this.enqueue(rt, async () => {
			if (rt.reply !== void 0) await rt.reply.notice(`出错了：${detail}`);
			const ack = rt.inflight?.ack;
			rt.inflight = void 0;
			if (ack !== void 0) await ack();
		});
	}
	enqueue(rt, task) {
		rt.tail = rt.tail.then(task).catch((error) => {
			this.onError(`[project-bot] 出站处理失败：${error instanceof Error ? error.message : String(error)}`);
		});
	}
};
//#endregion
//#region src/core/ports.ts
/** 从 bot 记录提取创作期注入。 */
function hooksOf(bot) {
	return {
		...bot.persona !== void 0 ? { persona: bot.persona } : {},
		...bot.tools !== void 0 ? { tools: bot.tools } : {},
		...bot.preset !== void 0 ? { preset: bot.preset } : {}
	};
}
//#endregion
//#region src/core/router.ts
/** 绑定路由：(botId, chatId) → 长期会话；create / resume / reset。 */
var Router = class {
	agents;
	bindings;
	sessions;
	defaultModel;
	workspace;
	onWarn;
	constructor(agents, bindings, sessions, defaultModel, workspace, onWarn) {
		this.agents = agents;
		this.bindings = bindings;
		this.sessions = sessions;
		this.defaultModel = defaultModel;
		this.workspace = workspace;
		this.onWarn = onWarn;
	}
	/** 取（或建/恢复）该 chat 的会话 runtime；reply 刷新为最近一次入站携带的句柄。 */
	async ensure(bot, chatId, reply) {
		const bound = this.bindings.get(bot.id, chatId);
		if (bound !== void 0) {
			const existing = this.sessions.get(bound);
			if (existing !== void 0) {
				existing.reply = reply;
				return existing;
			}
			const agent = await this.agents.resume({
				sessionId: bound,
				agentOptions: this.resolveOptions(bot),
				hooks: hooksOf(bot)
			});
			await this.attach(bot.project, bound);
			return this.adopt(bot.id, chatId, bound, agent, reply);
		}
		const sessionId = randomUUID();
		const agent = await this.agents.create({
			sessionId,
			cwd: bot.project,
			agentOptions: this.resolveOptions(bot),
			hooks: hooksOf(bot)
		});
		await this.bindings.set(bot.id, chatId, sessionId);
		await this.attach(bot.project, sessionId);
		return this.adopt(bot.id, chatId, sessionId, agent, reply);
	}
	/** attach 失败仅告警（会话降级为未分组），不阻塞消息处理。 */
	async attach(cwd, sessionId) {
		try {
			await this.workspace.attach(cwd, sessionId);
		} catch (error) {
			this.onWarn(`[project-bot] 会话 ${sessionId} 挂载 workspace 失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/** 有 agentOptions 原样透传；无则回退宿主默认模型（存量 bot 不抛 no provider/model）。 */
	resolveOptions(bot) {
		return bot.agentOptions ?? this.defaultModel();
	}
	/** /new：取消旧会话、清绑定、开新会话。 */
	async reset(bot, chatId, reply) {
		const bound = this.bindings.get(bot.id, chatId);
		if (bound !== void 0) {
			this.sessions.get(bound)?.agent.cancel();
			this.sessions.delete(bound);
			await this.bindings.delete(bot.id, chatId);
		}
		return this.ensure(bot, chatId, reply);
	}
	lookup(botId, chatId) {
		const bound = this.bindings.get(botId, chatId);
		return bound === void 0 ? void 0 : this.sessions.get(bound);
	}
	adopt(botId, chatId, sessionId, agent, reply) {
		const rt = {
			botId,
			chatId,
			sessionId,
			agent,
			reply,
			inflight: void 0,
			tail: Promise.resolve(),
			turn: void 0
		};
		this.sessions.set(sessionId, rt);
		return rt;
	}
};
//#endregion
//#region src/core/runtime.ts
var BotRuntime = class {
	deps;
	sessions = /* @__PURE__ */ new Map();
	router;
	inbound;
	outbound;
	handles = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.deps = deps;
		const bindingStore = this.bindingStore();
		this.router = new Router(deps.agents, bindingStore, this.sessions, deps.defaultModel, deps.workspace, (m) => deps.log.warn(m));
		this.inbound = new Inbound({
			router: this.router,
			bots: deps.bots,
			onError: (m) => deps.log.warn(m)
		});
		this.outbound = new Outbound(this.sessions, (m) => deps.log.warn(m), deps.maxErrorDetailChars);
	}
	async startAll() {
		for (const botId of [...this.deps.bots.keys()]) await this.reconcile(botId);
	}
	/** 按最新记录重建该 bot 的渠道（创建/更新后调用；记录已删则纯停止）。 */
	async reconcile(botId) {
		await this.stopChannel(botId);
		const record = this.deps.bots.get(botId);
		if (record === void 0) return;
		if (!this.deps.validateProject(record.project)) {
			this.deps.log.warn(`[project-bot] bot "${botId}" 的项目路径不可用：${record.project}`);
			return;
		}
		const secret = await this.deps.resolveSecret(record.feishu.appSecretRef);
		if (secret === void 0) {
			this.deps.log.warn(`[project-bot] bot "${botId}" 的密钥 ${record.feishu.appSecretRef} 未配置`);
			return;
		}
		const channel = this.deps.channels.get(record.channel);
		if (channel === void 0) {
			this.deps.log.warn(`[project-bot] bot "${botId}" 的渠道 "${record.channel}" 未实现`);
			return;
		}
		try {
			const handle = await channel.start({
				record,
				secret
			}, { onMessage: (msg) => this.inbound.onMessage(msg) }, this.deps.tunables, (m) => this.deps.log.warn(m));
			this.handles.set(botId, handle);
		} catch (error) {
			this.deps.log.warn(`[project-bot] bot "${botId}" 渠道启动失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	/** 删除 bot：停渠道、取消会话、清绑定。 */
	async stopBot(botId) {
		await this.stopChannel(botId);
		for (const [sessionId, rt] of [...this.sessions]) if (rt.botId === botId) {
			rt.agent.cancel();
			this.sessions.delete(sessionId);
		}
		await this.bindingStore().deleteBot(botId);
	}
	statusOf(botId) {
		return this.handles.get(botId)?.status() ?? "not-running";
	}
	/** 卸载时序：取消在飞会话 → 等 idle → drain 出站链（卡片定格）→ 断全部渠道。 */
	async stopAll() {
		for (const rt of this.sessions.values()) rt.agent.cancel();
		await Promise.allSettled([...this.sessions.values()].map(async (rt) => {
			await rt.agent.whenIdle().catch(() => void 0);
			await rt.tail;
		}));
		await Promise.allSettled([...this.handles.values()].map((h) => h.close()));
		this.handles.clear();
	}
	async stopChannel(botId) {
		const handle = this.handles.get(botId);
		if (handle === void 0) return;
		this.handles.delete(botId);
		await handle.close().catch((error) => {
			this.deps.log.warn(`[project-bot] bot "${botId}" 渠道关闭异常：${error instanceof Error ? error.message : String(error)}`);
		});
	}
	bindingStore() {
		const { bindings } = this.deps;
		return {
			get: (b, c) => bindings.get(bindingKey(b, c))?.sessionId,
			set: async (b, c, s) => {
				await bindings.put(bindingKey(b, c), { sessionId: s });
			},
			delete: async (b, c) => {
				await bindings.delete(bindingKey(b, c));
			},
			deleteBot: async (b) => {
				for (const key of [...bindings.keys()]) if (key.startsWith(`${b}:`)) await bindings.delete(key);
			}
		};
	}
};
//#endregion
//#region src/register-app.ts
/** 扫码一键创建飞书应用：lark.registerApp（OAuth 2.0 Device Authorization Grant）的状态机封装。 */
var RegisterAppService = class {
	deps;
	sessions = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.deps = deps;
	}
	/** 发起一轮扫码创建；返回轮询 id。 */
	start() {
		const id = (this.deps.newId ?? randomUUID)();
		const controller = new AbortController();
		const entry = {
			state: { status: "pending" },
			controller,
			timer: setTimeout(() => {
				controller.abort();
			}, this.deps.timeoutMs)
		};
		this.sessions.set(id, entry);
		this.deps.registerApp({
			signal: controller.signal,
			onQRCodeReady: (info) => {
				entry.state = {
					status: "pending",
					url: info.url,
					expireIn: info.expireIn
				};
			}
		}).then(async (result) => {
			const credentialRef = await this.deps.storeSecret(result.client_id, result.client_secret);
			entry.state = {
				status: "done",
				appId: result.client_id,
				credentialRef
			};
		}).catch((error) => {
			const e = error;
			entry.state = {
				status: "error",
				code: typeof e.code === "string" ? e.code : "unknown",
				...typeof e.description === "string" ? { description: e.description } : {}
			};
		}).finally(() => {
			clearTimeout(entry.timer);
		});
		return id;
	}
	get(id) {
		return this.sessions.get(id)?.state;
	}
	/** 卸载：中断全部进行中的轮询。 */
	dispose() {
		for (const entry of this.sessions.values()) {
			entry.controller.abort();
			clearTimeout(entry.timer);
		}
		this.sessions.clear();
	}
};
//#endregion
//#region src/index.ts
/** project-bot 插件：项目机器人（飞书渠道）——多 bot 作为项目 agent 的交互入口。 */
const Config = z.object({
	cardUpdateThrottleMs: z.number().default(500),
	cardMaxBytes: z.number().default(28e3),
	processMaxBytes: z.number().default(8e3),
	registerAppTimeoutMs: z.number().default(6e5),
	processingReactionEmoji: z.string().default("OneSecond"),
	errorDetailMaxChars: z.number().default(500)
});
const name = "project-bot";
const inject = [
	"agents",
	"credentials",
	"storageDomain",
	"tools",
	"llm",
	"agentDefaultModel"
];
function apply(ctx, config) {
	const log = {
		warn: (m) => ctx.logger.warn(m),
		info: (m) => ctx.logger.info(m)
	};
	const channels = /* @__PURE__ */ new Map([["feishu", feishuChannel]]);
	const tunables = {
		cardUpdateThrottleMs: config.cardUpdateThrottleMs,
		cardMaxBytes: config.cardMaxBytes,
		processMaxBytes: config.processMaxBytes,
		processingReactionEmoji: config.processingReactionEmoji
	};
	const storeSecret = async (key, secret) => {
		const ref = `project_bot_${key.replace(/[^A-Za-z0-9_]/g, "_")}`;
		await ctx.credentials.set(credentialRef(ref), secret);
		return ref;
	};
	/** 创作期注入已迁至 agent-setup.ts（preset 挂载 + persona/tools），此处不再保留 applyHooks。 */
	const presets = ctx.get("agentPresets", false);
	const agentsPort = {
		async create(input) {
			const agentPreset = await resolvePresetId(presets, input.hooks.preset, log.warn);
			return adaptAgent(await ctx.agents.create({
				sessionId: SessionId(input.sessionId),
				meta: {
					cwd: input.cwd,
					...agentPreset !== void 0 ? { agentPreset } : {}
				},
				...input.agentOptions !== void 0 ? { agentOptions: input.agentOptions } : {},
				setup: (agentCtx) => setupAgentScope(agentCtx, presets, agentPreset, input.hooks)
			}));
		},
		async resume(input) {
			const agentPreset = await resolvePresetId(presets, input.hooks.preset, log.warn);
			return adaptAgent(await ctx.agents.resume({
				resumeSessionId: SessionId(input.sessionId),
				...input.agentOptions !== void 0 ? { agentOptions: input.agentOptions } : {},
				setup: (agentCtx) => setupAgentScope(agentCtx, presets, agentPreset, input.hooks)
			}));
		}
	};
	function adaptAgent(handle) {
		const { agent } = handle;
		return {
			sessionId: String(agent.id),
			followup: (message) => agent.followup(message),
			cancel: () => agent.cancel({ kind: "user" }),
			whenIdle: () => agent.whenIdle()
		};
	}
	const workspaceRegistry = ctx.get("workspaceRegistry", false);
	const workspacePort = { async attach(cwd, sessionId) {
		if (workspaceRegistry === void 0) throw new Error("workspaceRegistry 服务不可用");
		await (await workspaceRegistry.create(cwd)).attachSession(SessionId(sessionId));
	} };
	let botsTable;
	let bindingsTable;
	const domainReady = ctx.storageDomain.open(projectBotDomain).then((domain) => {
		botsTable = domain.table("bots");
		bindingsTable = domain.table("bindings");
		return domain;
	});
	domainReady.catch((error) => {
		log.warn(`[project-bot] 存储域打开失败，插件不可用：${error instanceof Error ? error.message : String(error)}`);
	});
	let runtime;
	const registerAppService = new RegisterAppService({
		registerApp: (options) => import("@larksuiteoapi/node-sdk").then((lark) => lark.registerApp(options)),
		storeSecret,
		timeoutMs: config.registerAppTimeoutMs
	});
	const started = domainReady.then(() => {
		runtime = new BotRuntime({
			bots: botsTable,
			bindings: bindingsTable,
			agents: agentsPort,
			defaultModel: () => {
				const selection = ctx.agentDefaultModel.currentSelection();
				return {
					provider: selection.provider,
					model: selection.model
				};
			},
			workspace: workspacePort,
			channels,
			tunables,
			maxErrorDetailChars: config.errorDetailMaxChars,
			resolveSecret: async (ref) => (await ctx.credentials.resolve(credentialRef(ref)))?.value,
			validateProject: (path) => existsSync(path),
			log
		});
		return runtime.startAll();
	});
	started.catch((error) => {
		log.warn(`[project-bot] 启动失败：${error instanceof Error ? error.message : String(error)}`);
	});
	ctx.on("session/event", (session, event) => {
		runtime?.outbound.handleSessionEvent(String(session.header.id), event);
	});
	ctx.on("agent/error", ({ agent, error }) => {
		const text = error instanceof Error ? error.message : String(error?.message ?? error);
		runtime?.outbound.handleAgentError(String(agent.session.id), text);
	});
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(() => webCtx.webServer.register({
			kind: "prefix",
			path: "/project-bot/api",
			handler: async (req, res) => {
				try {
					await started;
					if (runtime === void 0) throw new Error("runtime unavailable");
					await createApiHandler({
						bots: botsTable,
						runtime,
						registerApp: registerAppService,
						listTools: () => ctx.tools.schemas().map((s) => s.name),
						listPresets: async () => {
							if (presets === void 0) return [];
							return (await presets.list()).map(({ id, name, description, broken }) => ({
								id,
								name: name ?? id,
								...description !== void 0 ? { description } : {},
								...broken !== void 0 ? { broken } : {}
							}));
						},
						listProviders: () => ctx.llm.listProviders().map(({ id, name }) => ({
							id,
							name
						})),
						listModels: (provider) => ctx.llm.listModels(provider).then((models) => models.map(({ id, name }) => ({
							id,
							name
						}))),
						storeSecret,
						deleteSecret: async (ref) => ctx.credentials.unset(credentialRef(ref)),
						validateProject: (path) => existsSync(path),
						now: () => Date.now()
					})(req, res);
				} catch (error) {
					res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
				}
			}
		}), "project-bot: /project-bot/api route");
	});
	ctx.effect(() => async () => {
		registerAppService.dispose();
		if (runtime !== void 0) await runtime.stopAll();
		await started.catch(() => void 0);
		await domainReady.then((domain) => domain.close()).catch(() => void 0);
	});
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=index.js.map