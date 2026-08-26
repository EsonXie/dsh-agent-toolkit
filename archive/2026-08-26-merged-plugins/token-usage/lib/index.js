import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
//#region src/aggregate.ts
/** 桶的计费总量（含估算）。 */
function billedOf(b) {
	return b.input + b.output + b.cacheRead + b.cacheWrite + b.estimated;
}
function emptyBucket() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		calls: 0,
		estimated: 0
	};
}
function emptyDaily(date) {
	return {
		date,
		totals: {
			...emptyBucket(),
			estimatedCalls: 0
		},
		hours: Array.from({ length: 24 }, emptyBucket),
		byModel: {},
		bySession: {},
		byProject: {},
		compaction: emptyBucket()
	};
}
function addToBucket(b, s) {
	return {
		input: b.input + s.input,
		output: b.output + s.output,
		cacheRead: b.cacheRead + s.cacheRead,
		cacheWrite: b.cacheWrite + s.cacheWrite,
		calls: b.calls + 1,
		estimated: b.estimated + s.estimated
	};
}
/** 把一条样本并入日记录，返回新对象（存储记录禁止就地修改）。 */
function addSample(rec, s) {
	const totals = {
		...addToBucket(rec.totals, s),
		estimatedCalls: rec.totals.estimatedCalls + (s.estimatedCall ? 1 : 0)
	};
	const hours = rec.hours.slice();
	hours[s.hour] = addToBucket(hours[s.hour], s);
	const byModel = { ...rec.byModel };
	if (s.model !== void 0) byModel[s.model] = addToBucket(byModel[s.model] ?? emptyBucket(), s);
	const bySession = { ...rec.bySession };
	if (s.sessionId !== void 0 && s.cwd !== void 0) bySession[s.sessionId] = {
		...addToBucket(bySession[s.sessionId] ?? {
			...emptyBucket(),
			cwd: s.cwd
		}, s),
		cwd: s.cwd
	};
	const byProject = { ...rec.byProject };
	if (s.cwd !== void 0 && !s.compaction) byProject[s.cwd] = addToBucket(byProject[s.cwd] ?? emptyBucket(), s);
	const compaction = s.compaction ? addToBucket(rec.compaction, s) : rec.compaction;
	return {
		...rec,
		totals,
		hours,
		byModel,
		bySession,
		byProject,
		compaction
	};
}
/** 从 session 事件提取样本；不相关事件与无 usage 的 compaction 返回 undefined。 */
function sampleFromEvent(session, event, timeZone, estimate) {
	const { date, hour } = dayParts(event.time, timeZone);
	if (event.type === "assistant/message") {
		const { message, usage } = event.data;
		const base = {
			date,
			hour,
			model: `${message.source.provider}/${message.source.model}`,
			sessionId: String(session.header.id),
			cwd: session.header.cwd,
			compaction: false
		};
		if (usage === void 0) return {
			...base,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			estimated: estimate(message),
			estimatedCall: true
		};
		return {
			...base,
			estimated: 0,
			estimatedCall: false,
			input: usage.inputTokens,
			output: usage.outputTokens,
			cacheRead: usage.cacheReadTokens ?? 0,
			cacheWrite: usage.cacheWriteTokens ?? 0
		};
	}
	if (event.type === "compaction/summary") {
		const { usage } = event.data;
		if (usage === void 0) return void 0;
		return {
			date,
			hour,
			model: void 0,
			estimated: 0,
			estimatedCall: false,
			compaction: true,
			input: usage.inputTokens,
			output: usage.outputTokens,
			cacheRead: usage.cacheReadTokens ?? 0,
			cacheWrite: usage.cacheWriteTokens ?? 0
		};
	}
}
/** 把 UTC 毫秒换算成指定时区的日期串与小时序号。 */
function dayParts(time, timeZone) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hour12: false
	}).formatToParts(time);
	const get = (type) => parts.find((p) => p.type === type).value;
	return {
		date: `${get("year")}-${get("month")}-${get("day")}`,
		hour: Number(get("hour")) % 24
	};
}
/** 日期串加减天数（锚 UTC 正午，避开 DST）。 */
function shiftDate(date, days) {
	return new Date(Date.parse(`${date}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
}
/** 计费 token 数自动换算 K/M/B（10 进制，1 位小数）。 */
function formatTokens(n) {
	const units = [
		"",
		"K",
		"M",
		"B"
	];
	let value = n;
	let unit = 0;
	while (value >= 1e3 && unit < units.length - 1) {
		value /= 1e3;
		unit += 1;
	}
	return unit === 0 ? String(n) : `${value.toFixed(1)}${units[unit]}`;
}
//#endregion
//#region src/heatmap.ts
/** token-usage 纯函数：range 端点参数与摘要、13 周热力图网格、缓存/新增拆分。无运行时依赖，两半共用。 */
/** 解析 range 端点 days 参数：null → 默认 91；1..366 合法；其余返回 null（非法）。 */
function parseDaysParam(raw) {
	if (raw === null) return 91;
	if (!/^\d+$/.test(raw)) return null;
	const n = Number(raw);
	return n >= 1 && n <= 366 ? n : null;
}
/** 以 today 为终点向前取 days 天的紧凑摘要（缺失日记 0），日期升序。 */
function rangeSummaries(get, today, days) {
	return Array.from({ length: days }, (_, i) => {
		const date = shiftDate(today, i - (days - 1));
		const rec = get(date);
		return rec === void 0 ? {
			date,
			billed: 0,
			calls: 0
		} : {
			date,
			billed: billedOf(rec.totals),
			calls: rec.totals.calls
		};
	});
}
//#endregion
//#region src/render.ts
/** /token-usage 命令的文本视图（纯函数）。 */
function line(name, b) {
	return `  ${name}  ${formatTokens(billedOf(b))}  ${b.calls} 次调用`;
}
/** 当日详情：总量（含估算标注）+ 模型/项目二维细分 + compaction 单列。 */
function renderDay(rec) {
	const est = rec.totals.estimated > 0 ? `（含估算 ${formatTokens(rec.totals.estimated)}）` : "";
	const rows = [`${rec.date} 用量：${formatTokens(billedOf(rec.totals))} ${rec.totals.calls} 次调用${est}`];
	const models = Object.entries(rec.byModel).sort((a, b) => billedOf(b[1]) - billedOf(a[1]));
	if (models.length > 0) rows.push("按模型：", ...models.map(([k, v]) => line(k, v)));
	const projects = Object.entries(rec.byProject).sort((a, b) => billedOf(b[1]) - billedOf(a[1]));
	if (projects.length > 0) rows.push("按项目：", ...projects.map(([k, v]) => line(k, v)));
	if (rec.compaction.calls > 0) rows.push(`上下文压缩：${formatTokens(billedOf(rec.compaction))} ${rec.compaction.calls} 次调用`);
	return rows.join("\n");
}
/** 今日详情 + 近 7 日逐日摘要行（days[0] 为今日）。 */
function renderWeek(today, days) {
	const lines = days.map((d) => `${d.date}  ${formatTokens(billedOf(d.totals))}  ${d.totals.calls} 次调用`);
	return `${renderDay(days[0])}\n\n近 7 日：\n${lines.join("\n")}`;
}
//#endregion
//#region src/store.ts
/** token-usage 存储域声明：身份、版本、记录 zod schema 的单一来源。 */
const BucketSchema = z$1.object({
	input: z$1.number().int().nonnegative(),
	output: z$1.number().int().nonnegative(),
	cacheRead: z$1.number().int().nonnegative(),
	cacheWrite: z$1.number().int().nonnegative(),
	calls: z$1.number().int().nonnegative(),
	/** 估算样本的计费 token 量（usage 缺失时经 tokenMeter 启发式得出）。 */
	estimated: z$1.number().int().nonnegative()
});
const DailyRecordSchema = z$1.object({
	date: z$1.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	totals: BucketSchema.extend({ estimatedCalls: z$1.number().int().nonnegative() }),
	/** 24 小时桶，空小时为全零桶。 */
	hours: z$1.array(BucketSchema).length(24),
	/** key = 'provider/model'。 */
	byModel: z$1.record(z$1.string(), BucketSchema),
	/** key = sessionId。 */
	bySession: z$1.record(z$1.string(), BucketSchema.extend({ cwd: z$1.string() })),
	/** key = cwd（原样存储）。 */
	byProject: z$1.record(z$1.string(), BucketSchema),
	/** 压缩摘要调用单列；数值同时已并入 totals/hours。 */
	compaction: BucketSchema
});
/** domain 名受 UNIT_NAME_RE 约束（^[a-z][a-z0-9_]*$），不允许连字符。 */
const tokenUsageDomain = defineDomain({
	name: "token_usage",
	version: 1,
	tables: { daily: domainTable(DailyRecordSchema) }
});
//#endregion
//#region src/index.ts
const Config = z.object({ timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC") });
const name = "token-usage";
const inject = [
	"storageDomain",
	"tokenMeter",
	"commands"
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function apply(ctx, config) {
	let daily;
	let tail = Promise.resolve();
	const domainReady = ctx.storageDomain.open(tokenUsageDomain).then((domain) => {
		daily = domain.table("daily");
		return domain;
	});
	domainReady.catch((error) => {
		ctx.logger.warn(`[token-usage] 存储域打开失败，token 统计不可用：${error instanceof Error ? error.message : String(error)}`);
	});
	ctx.on("session/event", (session, event) => {
		const sample = sampleFromEvent(session, event, config.timezone, (m) => ctx.tokenMeter.estimateMessage(m));
		if (sample === void 0) return;
		tail = tail.then(() => domainReady).then(() => {
			const table = daily;
			return table.put(sample.date, addSample(table.get(sample.date) ?? emptyDaily(sample.date), sample));
		}).then(() => void 0, () => void 0);
	});
	ctx.commands.register({
		name: "token-usage",
		description: "查看 token 用量（今日+近7日，或指定日期）",
		input: { hint: "YYYY-MM-DD，可空" },
		handler: async ({ rawInput }) => {
			const table = await domainReady.then(() => daily);
			const arg = rawInput.trim();
			dayParts(Date.now(), config.timezone).date;
			if (arg !== "" && !DATE_RE.test(arg)) return {
				kind: "error",
				text: "用法：/token-usage [YYYY-MM-DD]"
			};
			if (arg !== "") return {
				kind: "success",
				text: renderDay(table.get(arg) ?? emptyDaily(arg))
			};
			const days = Array.from({ length: 7 }, (_, i) => {
				const date = dayParts(Date.now() - i * 864e5, config.timezone).date;
				return table.get(date) ?? emptyDaily(date);
			});
			return {
				kind: "success",
				text: renderWeek(days[0].date, days)
			};
		}
	});
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: "/token-usage/api/daily",
			handler: async (req, res) => {
				if (req.method !== "GET") {
					res.writeHead(405).end();
					return;
				}
				const date = new URL(req.url ?? "", "http://127.0.0.1").searchParams.get("date");
				if (date !== null && !DATE_RE.test(date)) {
					res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad date, want YYYY-MM-DD" }));
					return;
				}
				const table = await domainReady.then(() => daily);
				const today = dayParts(Date.now(), config.timezone).date;
				const key = date ?? today;
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
					today,
					record: table.get(key) ?? emptyDaily(key)
				}));
			}
		}), "token-usage: /token-usage/api/daily route");
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: "/token-usage/api/range",
			handler: async (req, res) => {
				if (req.method !== "GET") {
					res.writeHead(405).end();
					return;
				}
				const days = parseDaysParam(new URL(req.url ?? "", "http://127.0.0.1").searchParams.get("days"));
				if (days === null) {
					res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad days, want integer 1..366" }));
					return;
				}
				const table = await domainReady.then(() => daily);
				const today = dayParts(Date.now(), config.timezone).date;
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
					today,
					days: rangeSummaries((d) => table.get(d), today, days)
				}));
			}
		}), "token-usage: /token-usage/api/range route");
	});
	ctx.effect(() => async () => {
		await tail.catch(() => void 0);
		await domainReady.then((domain) => domain.close());
	});
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=index.js.map