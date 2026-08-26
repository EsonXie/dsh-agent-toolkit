import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
interface Config {
  /** 卡片流式更新节流间隔（毫秒）。 */
  cardUpdateThrottleMs: number;
  /** 单张卡片内容字节上限（飞书硬上限 30KB，留余量）。 */
  cardMaxBytes: number;
  /** 过程区（思考 + 工具调用）字节上限（截尾保留最近内容）。 */
  processMaxBytes: number;
  /** 扫码创建应用的轮询超时（毫秒）。 */
  registerAppTimeoutMs: number;
  /** 「处理中」表情回复的 emoji_type。 */
  processingReactionEmoji: string;
  /** 回传飞书的错误摘要最大字符数。 */
  errorDetailMaxChars: number;
}
declare const Config: z<Config>;
declare const name = "project-bot";
declare const inject: string[];
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=index.d.ts.map