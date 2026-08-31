# 模型层 / model-notes 规则内容 tab 查看 — 设计 spec

日期：2026-08-31
状态：待实施

## 背景与目标

分层提示词面板（`PromptLayersModal`）中，「模型层」与「model-notes」两个只读行当前只能看到单一内容：模型层固定显示内置默认文本（`BASE_TEXT`），model-notes 显示裸组装 probe 结果（几乎恒为空）。运行时实际文本由 `rules` 按模型命中决定（模型层 = 命中规则 `overrides.base` ?? `BASE_TEXT`；model-notes = 命中规则 `append`），用户无法查看各规则的内容。

目标：两行各增加一条 tab 栏切换规则，只读文本框显示所选规则内容。纯查看能力，不引入规则编辑（规则仍由 cordis.yml 配置）。

## 已确认的决策（2026-08-31 逐问确认）

1. **按层过滤 tab**：模型层 tab = 「内置默认」+ 每条含 `overrides.base` 的规则；model-notes tab = 每条含 `append` 的规则。各自只展示本层相关内容，不做统一规则列表。
2. **tab 标签仅显示匹配条件**：如 `claude*`、`provider: moonshotai`；不做当前模型命中高亮。
3. **方案 A 纯前端派生**：`PromptLayersPayload.rules` 已下发完整规则列表，tab 数据在浏览器半直接派生，零后端 / API 改动；不抽共享 Tabs 组件（YAGNI），沿用 BotForm / UsageModal 的手写 tab 模式。

## 第 1 节 · UI 结构与交互

- 选中「模型层」或「model-notes」行时，编辑器面板在 hint 文本下方、只读 textarea 上方渲染 tab 栏：`role="tablist"` + 按钮 tab（`role="tab"` / `aria-selected`），样式类 `tabs` / `tab` / `tabActive` 加入 `prompt.module.css`（参照 `usage.module.css` 现有写法）。
- 点 tab 切换，textarea（保持 `readOnly`）立即显示所选内容。
- 只读行无保存动作，底部 actions 不渲染（现状如此，不变）。

## 第 2 节 · 数据派生（纯客户端）

从已有 `state.data.rules` 派生：

- **模型层 tabs**：`[{ label: '内置默认', text: modelFallbackText }, ...rules.filter(r => r.overrides?.base !== undefined)]`，规则项 text = `r.overrides.base`。
- **model-notes tabs**：`rules.filter(r => r.append !== undefined)`，text = `r.append`。若为空：不渲染 tab 栏，textarea 置空，hint 改为「当前配置没有 append 规则」。
- **标签格式化** `formatMatch(match: RuleMatch): string`：`modelPattern` 原样、`provider: X`、`model: X`，多字段以 ` + ` 连接（`RuleMatch` 至少一个字段，不会空标签）。
- **组件拆分**：新增小组件 `RuleTabs`（props: `tabs: Array<{ label: string; text: string }>`），内部自持选中 index（默认 0 = 「内置默认」/首条规则）；在编辑器面板以 `key={selectedKey}` 挂载，切换层时选中态天然复位。
- model-notes 行不再用 `nativeText(native, MODEL_NOTES_SECTION)` 兜底（probe 为裸组装，该段几乎恒空），内容完全来自 rules；`MODEL_NOTES_SECTION` 常量保留（仍用于只读行识别）。

## 第 3 节 · 测试

扩展 `src/client/prompt/prompt-layers.spec.tsx`（mock payload 含多条规则）：

1. 选中模型层 → 出现「内置默认」+ 各规则匹配条件 tab；默认选中「内置默认」，textarea 显示 `modelFallbackText`。
2. 点击规则 tab → textarea 显示该规则 `overrides.base` 文本。
3. 选中 model-notes → 出现 append 规则 tab，textarea 显示所选规则 `append`。
4. payload 无 append 规则时 → model-notes 行无 tab 栏，显示空态 hint。
5. 所有上述 textarea 保持 `readOnly`。

## 影响面

- 改动文件：`src/client/prompt/PromptLayersModal.tsx`、`src/client/prompt/prompt.module.css`、`src/client/prompt/prompt-layers.spec.tsx`。
- 无后端 / API / 存储改动；无 Config schema 改动；`docs/usage/` 手册相关截图与描述实施后同步更新。
