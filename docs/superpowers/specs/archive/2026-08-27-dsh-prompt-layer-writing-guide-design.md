# dsh 分层提示词写作规范（方法论参考文档）设计

> 日期：2026-08-27
> 状态：待评审
> 产出：`docs/dsh-分层提示词写作规范.md`（方法论参考文档，非代码改动）

## 1. 背景与目标

当前 `packages/toolkit/src/prompt/` 已实现语义化分层提示词：`harness:identity`（dsh 原生）、`base`（通用行为契约）、`domain`（领域）、`task`（任务）、`persona`（角色人设）、`model-notes`（模型族追加），并支持模型规则覆盖层文本。层文本由用户配置，缺一套「怎么写」的写作规范。

目标：产出一份**方法论参考文档**，明确每层该写什么、不该写什么、粒度、语气、顺序，并附可直接套用的中文示范文本。依据来自 opencode 官方提示词（已整理于 `docs/opencode-子Agent-persona参考.md`），但**只作为写作依据，不在本文展开 opencode 原文**。

非目标：不改动任何代码、不改默认层文本、不引入新层。

## 2. 文档定位

- 读者：插件用户 / 开发者，写或改 prompt 层文本时对照。
- 用法：按层查「规则 + 示范」；写完用第 8 节自查清单复核。
- 存放：`docs/dsh-分层提示词写作规范.md`。

## 3. 分层总览（第 0 章）

层栈（按 order 升序）：

```
harness:identity   (order -100)  dsh 原生身份段，不由插件写
base               (order 0)     通用行为契约（默认层）
persona            (order 0)     角色人设（仅子 Agent 装配用；与 base 同 order，
                                  稳定排序使 base 在前、persona 在后）
domain             (order 10-40) 领域知识
task               (order 50)    当前任务
model-notes        (末尾追加)    模型族使用说明（命中规则时追加）
```

主 Agent 组装只含 base/domain/task/model-notes；persona 仅由 `buildAgentPersona`（`src/prompt/persona.ts`）在子 Agent 装配时并入。每层给一句话职责定位 + 一句话「该层错了会怎样」的后果示例。

## 4. 每层写作规范模板（第 1-5 章）

每层统一按以下小节组织：

| 小节 | 内容 |
|---|---|
| 职责 | 这一层一句话定位 |
| 放什么 | 该层应包含的要点清单（来自 opencode 依据） |
| 不放什么 | 明确排他：该层绝不写的内容（防层间职责重叠） |
| 粒度·语气·字数 | 建议的篇幅量级、句式（短句/清单）、命令式程度 |
| 示范文本 | 1-2 段可直接套用的中文示范 |

### 4.1 base 层

- 放什么：语气与简洁规则、主动性与边界、做事流程（理解→实现→验证）、工具使用策略、代码规范、安全约定、`<system-reminder>` 权威性说明。
- 不放什么：身份首句（`harness:identity` 已覆盖）、项目/领域特定内容、模型族 API 细节。
- 依据：opencode `default.txt` 的结构（Tone and style / Proactiveness / Following conventions / Code style / Doing tasks / Tool usage policy / Code references）。

### 4.2 domain 层

- 放什么：领域概念与术语、项目约定、该领域的判别准则（何时/何地/如何用某模式）、常见陷阱。
- 不放什么：通用行为（属 base）、单次任务的具体步骤（属 task）。
- 依据：opencode 无独立 domain 文件，domain 来自 AGENTS.md 与模型族文本里的领域性段落——规范建议「只写事实性判别准则，不写流程」。

### 4.3 task 层

- 放什么：任务书（目标、约束、验收标准、输出格式）；写给子 Agent 的任务书须自包含。
- 不放什么：与任务无关的领域背景（属 domain）、通用行为。
- 依据：opencode 委派语义（任务书自带全部上下文、最终输出返回主 Agent）与 `handleSubtask`。

### 4.4 persona 层

- 放什么：角色一句话身份、与主对话的关系（看不到主对话）、输出预期（完整返回给主 Agent）、边界（不可再次委派）。
- 不放什么：通用行为守则（属 base）、工具细节、模型说明。
- 依据：`src/prompt/persona.ts` 的 SECTION_A 契约 + opencode 各 agent 自带 persona 的写法（先身份、再职责、再边界）。

### 4.5 model-notes 层

- 放什么：该模型族的 API 特性/调用约定（function-calling 风格、推理模型 thinking 段、reasoning_content 回传等）。
- 不放什么：行为语气（属 base）、领域内容。
- 依据：`defaults.ts` 的 `DEEPSEEK_APPEND` / `GLM_APPEND` 写法（短、仅追加、不断言覆盖）。

## 5. 通用写作原则（第 6 章，跨层）

从 opencode 提炼、适用于所有层的横向规律（每条给正面做法 + 反例）：

1. 面向输出写：写的每条指令都要能落到可观察的行为/输出上。
2. 给例子，少给抽象描述（opencode 的 `<example>` 块模式）。
3. 用肯定句说「要什么」，避免纯否定堆砌（否定用于边界，不放中间态）。
4. 短句 + 清单化，避免长段落（CLI 渲染、token 经济）。
5. 层间职责不重叠：同一件事只在一层写，改了 A 层别在 B 层留矛盾。
6. section 标题即「记忆锚点」：标题简短稳定，正文才可变。
7. 明确 `<system-reminder>` / 工具结果是权威信息、不属于用户输入。
8. 语气一致：默认用命令式（祈使），不写客套、不写自我描述。

## 6. 完整示范（第 7 章）

组装出**一条**完整的最终 system prompt 示范：persona + base + domain + task + model-notes 按 order 拼好后串成一段（含 `harness:identity` 占位说明），并附「组装结果 → 各层边界」标注，展示层间如何衔接、验证无职责重叠。

## 7. 自查清单（第 8 章）

Checklist（勾选式）：层内职责单一 / 无跨层重复 / 指令可观察 / 有例子 / 语气一致 / 未误写身份 / 未漏 task 验收标准 / model-notes 未越界等。

## 8. 产出与验收

- 产出：`docs/dsh-分层提示词写作规范.md`（中文）。
- 验收：文档含 0-8 全部分章；每层均有「放什么/不放什么/示范」；完整示范可拼接成无重叠的 system prompt；checklist 可执行。
