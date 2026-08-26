window.__ModuleLoader__.load({
	id: "agent-team",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region \0dsh-css:D:\work\github\dsh\dsh-agent-toolkit\packages\agent-team\src\client\delegate-card.module.css.mjs
		const css = ".B60jKa_root{margin:4px 0 4px 4px}.B60jKa_row{cursor:pointer;user-select:none;align-items:center;gap:6px;height:24px;display:flex}.B60jKa_row:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}.B60jKa_chip{font:var(--dsw-font-xs-13);color:var(--dsw-alias-state-business-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;flex:none;padding:0 6px}.B60jKa_summary{text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary);flex:auto;overflow:hidden}.B60jKa_body{border-left:1px solid var(--dsw-alias-border-l1);max-height:260px;margin:4px 0 4px 16px;padding-left:8px;overflow-y:auto}.B60jKa_prompt{white-space:pre-wrap;word-break:break-word;font:var(--dsw-font-markdown-code-block-small);color:var(--dsw-alias-label-secondary);margin:0 0 6px}.B60jKa_result{color:var(--dsw-alias-label-primary)}.B60jKa_childLink{cursor:pointer;font:var(--dsw-font-xs-13);color:var(--dsw-alias-state-business-primary);border:1px solid var(--dsw-alias-border-l2);background:0 0;border-radius:999px;margin-top:6px;padding:2px 10px}.B60jKa_childLink:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}.B60jKa_visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}.B60jKa_root[data-state=error] .B60jKa_summary{color:var(--dsw-alias-state-error-primary)}";
		const tagId = "agent-team/delegate-card.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "agent-team";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var delegate_card_module_css_default = {
			"result": "B60jKa_result",
			"root": "B60jKa_root",
			"row": "B60jKa_row",
			"body": "B60jKa_body",
			"childLink": "B60jKa_childLink",
			"chip": "B60jKa_chip",
			"visuallyHidden": "B60jKa_visuallyHidden",
			"summary": "B60jKa_summary",
			"prompt": "B60jKa_prompt"
		};
		//#endregion
		//#region src/client/delegate-card.tsx
		function argsOf(block) {
			const raw = "kind" in block && block.kind === "tool-result" ? block.call?.argsRaw : block.argsRaw;
			if (typeof raw !== "string") return {};
			try {
				return JSON.parse(raw);
			} catch {
				return {};
			}
		}
		function resultText(block) {
			if (!("kind" in block) || block.kind !== "tool-result") return "";
			return block.content.filter((b) => b.type === "text").map((b) => b.text).join("");
		}
		function DelegateCard(props) {
			const { block, sessionId, openChild, t } = props;
			const settled = "kind" in block && block.kind === "tool-result";
			const isError = settled && block.isError;
			const args = argsOf(block);
			const meta = settled ? block.meta : void 0;
			const [expanded, setExpanded] = (0, react.useState)(false);
			const state = !settled ? "ongoing" : isError ? "error" : "done";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: delegate_card_module_css_default.root,
				"data-state": !settled ? "running" : isError ? "error" : "ok",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: delegate_card_module_css_default.row,
					role: "button",
					tabIndex: 0,
					"aria-expanded": expanded || settled,
					onClick: () => setExpanded((v) => !v),
					onKeyDown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							setExpanded((v) => !v);
						}
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state }),
						args.role !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: delegate_card_module_css_default.chip,
							children: args.role
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: delegate_card_module_css_default.summary,
							children: args.description ?? ""
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: delegate_card_module_css_default.visuallyHidden,
							children: !settled ? t("card.running") : isError ? t("card.failed") : ""
						})
					]
				}), (settled || expanded) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: delegate_card_module_css_default.body,
					children: [
						expanded && args.prompt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
							className: delegate_card_module_css_default.prompt,
							children: args.prompt
						}),
						settled && resultText(block) !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: delegate_card_module_css_default.result,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, { text: resultText(block) })
						}),
						settled && !isError && meta?.childSessionId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: delegate_card_module_css_default.childLink,
							onClick: (e) => {
								e.stopPropagation();
								openChild({
									parentSessionId: sessionId,
									childSessionId: meta.childSessionId,
									mode: "one-shot"
								});
							},
							children: t("card.viewChild")
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** agent-team 浏览器半文案：zh 为真源，en 键集严格一致。 */
		const NS = "agent-team";
		const zh = {
			"card.viewChild": "查看子对话",
			"card.running": "成员执行中",
			"card.failed": "委派失败"
		};
		const en = {
			"card.viewChild": "View sub-conversation",
			"card.running": "Member running",
			"card.failed": "Delegation failed"
		};
		//#endregion
		//#region src/client/index.ts
		const inject = [
			"sessions",
			"slots",
			"locale"
		];
		/**
		* 浏览器半入口。委派卡按固定 key 'team_delegate' 注册：Node 半 Config.toolName
		* 改名后卡片不生效（落 generic 兜底）。
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "agent-team: dictionaries");
			const sessions = ctx.sessions;
			const injected = { openChild(address) {
				sessions.openSubagent(address);
			} };
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "team_delegate",
				locale: NS,
				inject: () => injected
			}, DelegateCard));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map