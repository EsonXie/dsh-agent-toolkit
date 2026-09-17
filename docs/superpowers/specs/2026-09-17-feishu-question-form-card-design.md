# 飞书问答卡改表单容器统一提交 — 设计

> 状态：待实施。承接 2026-09-16 问答卡初版（按钮即答）；2026-09-17 真实回路暴露两个卡片 JSON 2.0 兼容问题后重构交互模型。

## 背景

初版问答卡用 `{tag:'action', actions:[button...]}` 容器承载按钮，card JSON 2.0 已不支持 action 容器（建卡报 200861「unsupported tag action」），发卡失败静默回退 web 应答端（warn 在 dsh web 不可见，debugLog 事件后补才定位）。按钮直排修复后用户提出交互重构：选择不应逐题即答，而应全部填完后统一提交。

## 决策汇总（已与用户确认）

1. 单选 → `select_static` 下拉单选；多选 → `multi_select_static` 下拉勾选（飞书卡片 2.0 无复选框组组件）。
2. 每道选项题下加可选「其他」`input` 输入框（对应答案结构 custom 字段）；开放题用 `input` 作答。
3. 全部填完点「提交」统一提交（form 容器批量回调）；「提交」「跳过本次提问」常驻卡片下方。
4. 提交校验走服务端：逐题判定「有选择或有自定义文本」，缺答 toast 指出、保持挂起。（飞书原生 required 是「组件非空」，无法表达选项/自定义二选一，弃用。）

## 卡片结构（进行卡）

```
body.elements:
├─ form (name: 'q')
│   ├─ 每题 markdown：**问题**（+ detail 截断渲染，逻辑照旧）
│   ├─ 选项题（单选）：select_static { name: 'q{i}', options: [{text: label, value: label}], placeholder: '请选择', width: 'fill' }
│   ├─ 选项题（多选）：multi_select_static { name: 'q{i}', options 同上, placeholder: '请选择（可多选）', width: 'fill' }
│   ├─ 选项题附加：input { name: 'q{i}__custom', placeholder: '其他（可补充自定义说明）' }
│   ├─ 开放题：input { name: 'q{i}', placeholder: '请输入回答', width: 'fill' }
│   └─ column_set 底部：[提交]（primary，form_action_type: 'submit'，
│        behaviors: [{type:'callback', value:{kind:'question', key, submit:true}}]，name 'btn_submit'）
└─ [跳过本次提问]（form 外、body 末尾常驻，type danger，
     behaviors callback value={kind:'question', key, cancel:true}）
```

- form 内交互组件一律**不设 required、不挂 behaviors**（选择缓存在客户端，提交时一次性回调）；`form_value` 形态：select_static→选项 value 字符串，multi_select_static→value 数组，input→字符串。
- **name 用位置序号**（q0 / q0__custom / btn_submit）：q.id 是模型生成的任意字符串，飞书 form name 有字符与全局唯一约束，序号名规避。
- 终态卡（finalize）不变：只读「问题 + 已选/已答」，cancelled 题标「已取消」。

## 回调与聚合（QuestionCenter.handleCardAction）

- `toCardActionInput` 增补 `formValue?: Record<string, unknown>`：lark SDK `normalizeCardAction` 丢弃 `form_value`，从 raw 的 `action.form_value` 直取。`CardActionInput`（approval/center.ts）加同名可选字段。
- value `{kind:'question', key, cancel:true}` → settleCancelled（ASK_CANCELLED，不变；按钮与 toast 文案改「跳过」）。
- value `{kind:'question', key, submit:true}` → 按位置序号聚合 formValue：
  - 选项题：`formValue['q{i}']`（string→[v]；array→[...v]）为 selected；`formValue['q{i}__custom']` 非空字符串为 custom；
  - 开放题：`formValue['q{i}']` 非空字符串为 custom；
  - 聚合结果非空的题**覆写** answers；formValue 缺席但 answers 已有（文本拦截先行作答）的题保留；
  - 校验：每题 selected.length>0 或 custom 非空。全齐 → settleAnswered；缺答 → toast「还有 N 道题未作答」保持 pending；
  - 仅发起人校验不变（initiatorOpenId 比对）。
- **删除** select/toggle/confirm 旧分支（pending 为内存态，重启即清，无存量兼容负担）。

## center 瘦身

- `QuestionView.toggled` 删除；`QuestionPresentation.refresh` 删除（form 卡无中间态，且整卡重放会抹掉用户正在填写的表单态）。
- 开放题 inbound 文本拦截保留：答后记入 answers 但**不再 refresh**；收齐（合并后全齐）才 settleAnswered。
- presenter 接口收敛为 `present` / `finalize`；FeishuQuestionPresenter 删 refresh 实现。

## 影响面

- `channels/questions/feishu.ts`：进行卡渲染重写（form 结构）；终态卡不变。
- `channels/questions/center.ts`：submit 聚合 + 瘦身（删 toggled/refresh/旧分支）。
- `channels/feishu/card-action.ts`：formValue 透传。
- `channels/approval/center.ts`：CardActionInput 加可选 formValue 字段。
- 测试：`questions/feishu.test.ts`（form 结构断言）、`questions/center.test.ts`（submit 聚合/缺题 toast/文本拦截合并；删 toggle/refresh 用例）、`feishu/card-action` 相关测试（formValue 透传）、`runtime.test.ts`（受影响处）。
- 文档：实施后同步 `docs/domains/feishu.md` 问答卡小节。

## 非目标

- 审批卡交互模型不动（按钮直排修复已随 2026-09-17 上一轮回合生效）。
- web 端 UI 不动；非自有会话 next() 透传语义不变。
