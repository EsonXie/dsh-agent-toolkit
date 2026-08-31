# @dsh-agent-toolkit/token-usage

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件：按日/按小时计量 token 用量。

- 13 周活动热力图 + 单日堆叠图（按模型/按项目/压缩单列），侧边栏底栏「Token 用量」打开
- `/token-usage [YYYY-MM-DD]` 命令：今日 + 近 7 日，或指定日期
- JSON API：`/dsh-agent-toolkit/api/usage/daily?date=`、`/dsh-agent-toolkit/api/usage/range?days=`（web 模式）
- 用量缺失的样本经 tokenMeter 启发式估算，估算量单列

## 安装

```bash
dsh plugin add @dsh-agent-toolkit/token-usage
```

包自带 `cordis.patch.yml`（bundles 层），装进 profile 后自动激活。

> **与 dsh-agent-toolkit 二选一**：`dsh-agent-toolkit` 已内置本插件全部功能（Agent 注册表/分层提示词/委派/飞书 bots + token 用量）。
> 两者同时安装时计量先到先得（后到者只读共用数据），但仍建议只装其一。

## 配置

```yaml
- id: '@dsh-agent-toolkit/token-usage'
  config:
    timezone: Asia/Shanghai   # 默认值；按日/按小时聚合的时区
```

修改配置触发 HMR 热替换，无需重启。

## 运行前提

- 宿主注入服务：`storageDomain`、`tokenMeter`、`commands`（`webServer` 可选，headless/CLI 下 API 自动不注册）。
- peer dependency：`@deepseek-ai/cordis` ^4。

## 从 0.2.x 升级

0.3.0 起本包重写为 `dsh-agent-toolkit` workspace 的用量模块，存储域 `token_usage` 不变，历史数据保留。
0.1.x/0.2.x 已废弃（deprecated）。

## License

MIT
