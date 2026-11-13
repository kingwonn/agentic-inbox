# 端到端自测计划（真实任务）

目标：验证 信息发现 → 任务识别 → 自动规划 → 自主执行 → 人工确认 → 成果交付 的完整闭环，使用真实数据源（GitHub 仓库 kingwonn/agentic-inbox、本地 git 仓库）与真实的 Claude 执行。

| # | 场景 | 等级 | 预期 |
|---|---|---|---|
| E1 | 巡检发现 GitHub PR #1（Codex 生成、2026-04 未合并）与 2 个陈旧分支 | — | signals 入库；分诊产生 Inbox 条目（decision/todo），带优先级与等级 |
| E2 | 将 PR #1 条目提升为任务：“审查 PR #1 并给出合并建议” | L2 | 执行 Agent 只读分析，产出建议文本工件，任务 done，通知 |
| E3 | 手动投递：“为 taskcenter 写一页使用说明（中文）” | L3 | 规划 → 工作区内生成 `USAGE.md` → 交付物入库 → 进入 review → 审批通过后 done |
| E4 | 代码任务：“在仓库中为 mailbox-context 补一个边界测试并运行测试” | L4 | git worktree 分支 `tc/<id>` → 修改 + 运行测试 → `git push` 被门控进入 Outbox → 批准 → 推送完成 → 工件（分支/补丁）→ review |
| E5 | 拒绝路径：E4 的推送被拒绝 | L4 | Agent 收到拒绝原因，以 needs_human/partial 收尾，任务进入 waiting_human，无副作用 |
| E6 | 失败与重试：构造一个必然失败的任务（dry runner 注入 fail） | — | attempts 递增、退避后重排、达到上限 failed + 通知 |
| E7 | 崩溃恢复：执行中强制退出守护进程再启动 | — | run → interrupted，任务回到 ready，再次执行 |
| E8 | 预算：把 daily_budget_usd 设为极小 | — | 执行器暂停并通知 budget_warning |
| E9 | 每日摘要 | — | 生成中文摘要并通过控制台/Telegram 发送 |
| E10 | 云端心跳 | — | Claude Code 定时任务执行 `tc patrol --once && tc triage && tc state export` 并提交到 `taskcenter-state` 分支 |

记录：每个场景的命令、输出摘录、事件 ID 写入 `docs/e2e-results.md`。
