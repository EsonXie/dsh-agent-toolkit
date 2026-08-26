import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
interface Config {
  /** 按日聚合的时区（IANA 名）。 */
  timezone: string;
}
declare const Config: z<Config>;
declare const name = "token-usage";
declare const inject: string[];
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=index.d.ts.map