# @dsh-agent-toolkit/token-usage

DeepSeek Harness（dsh）插件：按日统计 token 用量。

- `/token-usage [YYYY-MM-DD]` 斜杠命令：今日 + 近 7 日汇总，或指定日期
- `GET /token-usage/api/daily?date=YYYY-MM-DD` JSON 端点（web 模式）
- Web UI 侧边栏用量面板（点击打开明细弹窗）

## 安装

```sh
dsh plugin --profile web add @dsh-agent-toolkit/token-usage
```

## 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `timezone` | string（IANA 名） | 系统时区 | 按日聚合的分日时区 |

在 profile 的 `cordis.patch.yml` 中整行覆盖：

```yaml
- id: token-usage
  name: '@dsh-agent-toolkit/token-usage'
  config:
    timezone: Asia/Shanghai
```

依赖 dsh 提供 `storageDomain`、`tokenMeter`、`commands` 服务（`@deepseek-ai/dsh-base` 均含）；`webServer` 为可选注入，headless/CLI 下不注册 HTTP 端点。
