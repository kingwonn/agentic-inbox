# 端到端自测结果（真实环境）

环境：Claude Code 云容器，`claude` 2.1.318，provider `claude-sdk`，模型 classify=haiku / plan=sonnet / execute=sonnet，GitHub 经 `gh` CLI（仓库范围 token）。
记录时间：2026-11-06。

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| E1 | 巡检 + 分诊（GitHub + 本地 git + 手动） | ✅ | 3 个信号 → 2 个 Inbox 条目 + 1 个自动提升任务（PR #1 评审，L3/P2），分诊成本 $0.0014，GitHub 巡检 16 次 API 调用 6.8 s |
| E2 | PR #1 评审任务（L3，sonnet） | ✅ | 10 轮、$0.28：在 worktree 中拉取 PR 分支、`npm test` 4/4 通过、`tsc` 检查、写出 `review-pr1.md` 并通过 `deliver_artifact` 入库，以 `needs_human` 收尾 → Outbox 生成“是否批准合并到 sparkai-email”的 question 审批（低风险）；任务进入 `waiting_human`。**该决策留给用户。** |
| E3 | 手动投递“写 USAGE.md”（L3，writing） | 见下文 | `tc capture` → 分诊自动提升 → 规划器产出 7 步计划 + 4 条风险 → 执行 → review 审批 |
