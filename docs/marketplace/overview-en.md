### dsh-agent-toolkit

**One-liner**: Turn DeepSeek Harness into a multi-agent workbench — a visual agent registry, layered prompts, one-shot delegation, Feishu (Lark) bots, cron tasks and token usage stats, all in one plugin.

### What it is

dsh-agent-toolkit is a single-package plugin for DeepSeek Harness (dsh) that bundles five agent-team productivity features into one install: a reusable agent roster, model-aware layered system prompts, one-shot subagent delegation, Feishu channel bots, cron-scheduled tasks, and a per-day/per-hour token usage panel. All UI lives in the host settings panel as the "Agent Toolkit" section, blending into dsh web without invasive chrome.

### Features

**Agent Registry** — Manage reusable roles in a card-stream UI: each role carries its own persona prompt, optional model override, and tool whitelist (allowlist-only semantics, grouped into team-preset tools and global tools). Ships with three built-in roles — `main`, `explorer` (read-only exploration) and `general` (general execution) — plus YAML first-boot import and a delete guard (a role with bots cannot be deleted).

![Agent registry card stream](https://raw.githubusercontent.com/EsonXie/dsh-agent-toolkit/master/docs/usage/images/agents-cards.png)

**Layered Prompts** — The system prompt is organized into a fixed four-layer stack: identity (native identity segment, replaceable wholesale) → model layer (built-in behavioral baseline, swapped per model family by rules) → persona (the only freely editable layer) → dynamic layers. Under one configuration, Claude, GPT, Kimi and other model families each get their adapted prompt automatically.

![Four-layer prompt cards](https://raw.githubusercontent.com/EsonXie/dsh-agent-toolkit/master/docs/usage/images/prompt-layers.png)

**Parallel Delegation** — The main agent dispatches work to roster roles via the `team_delegate` tool: each member runs as a foreground one-shot session carrying its role's persona/model/tool whitelist, with nested delegation forbidden (maxDepth 1). The web UI renders live delegation cards with one-click access to the child conversation.

**Feishu (Lark) Bots** — Bind any agent to a Feishu custom app: scan a QR code to create the app in one step (OAuth 2.0 Device Authorization Grant; the App Secret goes only into the host credentials service). Messages arrive over a long connection and replies stream into live-updating cards. Includes permission approval cards, busy-time message queueing with recall-to-cancel, and a full ops command set: `/new`, `/stop`, `/status`, `/sessions`, `/switch`, `/doc`, `/ls`, `/help`.

![QR-code one-step Feishu app creation](https://raw.githubusercontent.com/EsonXie/dsh-agent-toolkit/master/docs/usage/images/bots-form-feishu.png)

**Cron Tasks** — Three schedules (cron expression / one-shot time / fixed interval) running prompt tasks in independent new sessions; missed triggers after downtime can be caught up, each task keeps its last 20 runs with jump-to-session links, and the form previews the next 3 trigger times live.

![Cron task row list](https://raw.githubusercontent.com/EsonXie/dsh-agent-toolkit/master/docs/usage/images/cron-list.png)

**Token Usage** — Per-day/per-hour metering of token consumption across all sessions: a 13-week activity heatmap (click to jump to a day) plus range trend queries (hourly for a single day, daily for a range; aggregated by model and by project with cache hits broken out), a `/token-usage` command, and log-based refresh rebuilds. Also available standalone as `@dsh-agent-toolkit/token-usage` (identical features — install either, not both).

![Token usage activity heatmap](https://raw.githubusercontent.com/EsonXie/dsh-agent-toolkit/master/docs/usage/images/usage-modal.png)

### Install

```bash
# Full suite
dsh plugin --profile <profile name> add dsh-agent-toolkit

# Token usage only
dsh plugin --profile <profile name> add @dsh-agent-toolkit/token-usage
```

### Requirements

- DeepSeek Harness 0.1.5-rc.1 or later (fully verified on 0.1.5-rc.x)
- Admin UI and the usage panel require `dsh web` mode; Feishu channels and cron tasks are host-side features and work headless

### Links

- GitHub: <https://github.com/EsonXie/dsh-agent-toolkit>
- npm (suite): <https://www.npmjs.com/package/dsh-agent-toolkit>
- npm (standalone usage): <https://www.npmjs.com/package/@dsh-agent-toolkit/token-usage>
- User manual: <https://github.com/EsonXie/dsh-agent-toolkit/tree/master/docs/usage>

License: MIT
