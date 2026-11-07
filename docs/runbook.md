# Task Center 运维手册（Runbook）

## 日常
- 看板：`http://127.0.0.1:4800`（或 `server.public_url`）。总览页看：新 Inbox、待审批、运行中、失败、今日花费。
- 审批：看板 Outbox、Telegram 按钮、或 `tc approvals approve <id>`。
- 每日摘要：默认 08:30（`notifications.digest.cron`）。

## 故障排查
| 现象 | 处理 |
|---|---|
| `tc doctor` 报 claude CLI 未登录 | 在该机器上运行 `claude` 登录一次；或设置 `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token`） |
| 传感器连续失败 | `tc status` 查看 `sensor_failures:*`；`tc patrol --once --sensor github` 看错误；GitHub 403 多为 token 范围不足 |
| 任务卡在 `waiting_human` | Outbox 中有待审批项；审批后执行器自动续跑（`resume_after_approval`） |
| 任务 `failed` | `tc tasks show <id>` 看 `last_error` 与 runs；修正后 `tc tasks retry <id>` |
| 执行器暂停（预算） | 当日花费 ≥ `daily_budget_usd`；提高预算或次日自动恢复；`POST /api/executor/resume` |
| 守护进程异常退出 | 由 systemd/launchd/pm2 自动重启；启动时 `recovery` 会把中断的 run 标为 interrupted 并重排任务 |
| 数据库损坏 | `data/taskcenter.db` + WAL；用最近的 `data/exports/` 做 `tc state import` |

## 迁移
1. `tc state export ./data/exports/latest`
2. 拷贝 `taskcenter/config/`、`.env`、`data/exports/latest` 到新机器
3. `npm install && tc state import ./data/exports/latest && tc daemon`

## 安全
- `.env` 必须 `chmod 600`；日志自动脱敏常见 token 格式。
- 看板默认只绑定 127.0.0.1；对外暴露时设置 `TC_API_TOKEN` 并走 Tailscale / Cloudflare Tunnel。
- 所有敏感动作在 `config/policy.yaml` 的 `always_approve` 中，可增不可删（删前三思）。

## 成本
- 分诊 haiku（约 $0.004/批），规划 sonnet，执行 sonnet（约 $0.05–0.5/任务），L5/重任务 opus。
- `GET /api/budget` 或看板 Status 页查看 30 天花费。
