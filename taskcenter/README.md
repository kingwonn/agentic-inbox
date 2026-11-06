# Task Center（个人 AI 工作中枢）

> 主动感知信息 → 统一 Inbox → L1–L5 自主等级 → Agent 自主执行 → Outbox 人工确认 → 交付成果，并带监控看板。
> 设计文档：[`../docs/architecture.md`](../docs/architecture.md)；模块说明：[`docs/modules/`](docs/modules/)；调研资料：[`../docs/research/`](../docs/research/)。

## 它做什么

| 阶段 | 说明 |
|---|---|
| 感知（Sensors） | 定时巡检 GitHub（PR / Issue / CI / 分支）、邮箱（IMAP）、日历（ICS）、本地 git 仓库、本地文档、手动投递 |
| 分诊（Triage） | 用 Claude（haiku）结合个人上下文，把信号整理成 Inbox 条目：待办 / 问题 / 机会 / 决策 / 信息，并给出优先级、L1–L5 自主等级和建议动作 |
| 规划（Plan） | L3 以上任务由 Claude（sonnet）制定计划，复杂任务拆成带依赖的子任务并行推进 |
| 执行（Execute） | Claude Agent SDK 在隔离工作区执行，所有工具调用进日志；敏感动作（对外发送、推送、发布、删除、花钱）经 Outbox 审批 |
| 确认（HITL） | 看板 / Telegram / ntfy / 邮件 推送审批项，支持 批准 / 编辑 / 拒绝 / 回答 |
| 交付（Deliver） | 交付物（文件、PR、草稿、文档）入库，L5 自验证后完成，L3/L4 进入 review 等你验收 |
| 看板 | Inbox、Outbox、任务、运行、工具调用、日志、异常、交付物、记忆；支持重试、人工干预、历史回溯 |

## 快速开始

```bash
cd taskcenter
npm install
npm run tc -- init            # 生成 config/taskcenter.yaml、config/profile.yaml、.env
# 编辑 .env（GitHub token / IMAP 应用专用密码 / 日历 ICS 地址 / Telegram bot）
# 编辑 config/profile.yaml（你的职责、项目、目标、习惯、偏好）
npm run tc -- doctor          # 检查环境：node、claude CLI、gh、配置、凭据
npm run build:web             # 构建看板（一次）
npm run tc -- daemon          # 启动守护进程 + 看板 http://127.0.0.1:4800
```

常用命令：

```bash
tc patrol --once              # 立即巡检所有信息源
tc triage                     # 立即分诊
tc inbox list|promote <id>|dismiss <id>|snooze <id> 3d
tc tasks list|show <id>|create "标题" --level 3|retry <id>|cancel <id>
tc approvals list|approve <id>|reject <id> "原因"|respond <id> "答复"
tc run <taskId>               # 立即执行某个任务并流式输出
tc capture "明天前把 PR #1 看完"   # 手动投递一条信号
tc status | tc events --follow | tc digest --send
tc state export|import <dir>  # 迁移 / 云端同步
```

`tc` = `node bin/tc.mjs`（或 `npm run tc --`）。

## 配置

- `config/taskcenter.yaml`：数据目录、时区、语言、模型分级、并发、预算、巡检间隔、审批等待、各传感器与通知渠道（`${VAR}` 从 `.env` 读取）。
- `config/policy.yaml`：L1–L5 规则、分类上限、硬性红线（always_approve）、工具白名单、风险分级。
- `config/profile.yaml`：个人上下文（职责、项目、目标、兴趣、习惯、偏好、人物、常设指令）。
- `data/`：`taskcenter.db`（SQLite 单文件）、`workspaces/`（任务隔离工作区）、`logs/`、`exports/`。

## 自主等级

| 等级 | AI 做什么 | 你做什么 |
|---|---|---|
| L1 | 理解、整理、提取待办 | 看一眼 |
| L2 | 分析、给建议和方案 | 决定 |
| L3 | 完成部分工作，产出中间交付物 | 验收交付物 |
| L4 | 完成大部分工作，关键环节审批 | 批准关键动作 + 验收 |
| L5 | 端到端完成并自验证 | 事后知会 |

等级由 LLM 提议、`policy.yaml` 钳制；对外通信、发布、推送受保护分支、删除、支付等在任何等级都需审批。

## 部署

- 本地长期运行：`deploy/` 内有 systemd / launchd / pm2 模板；macOS 一键安装与常驻：`deploy/bootstrap-mac.sh`（`setup` → 填 `.env` → `service` → `verify-restart`）。
- 云端心跳（笔记本关机时仍然巡检）：见 `deploy/cloud-patrol.md`，用 Claude Code 的定时任务执行 `tc patrol --once && tc triage && tc state export`。

## 开发

```bash
npm test               # vitest
npm run typecheck
npm run tc -- demo     # 演示数据
```
