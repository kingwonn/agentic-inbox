# 端到端自测结果（真实环境）

环境：Claude Code 云容器，`claude` 2.1.318，provider `claude-sdk`，模型 classify=haiku / plan=sonnet / execute=sonnet，GitHub 经 `gh` CLI（仓库范围 token），本地 git 仓库 = 本仓库。
记录时间：2026-11-06（UTC 08:30–08:50）。数据库：`taskcenter/data/taskcenter.db`，所有事件可在看板「事件日志」回放。

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| E1 | 巡检 + 分诊（GitHub + 本地 git + 手动） | ✅ | 3 个信号 → 2 个 Inbox 条目 + 1 个自动提升任务（PR #1 评审，L3/P2，分类 code），分诊成本 $0.0014；GitHub 巡检 16 次 API 调用 6.8 s；`/notifications` 403 被降级为警告并 6 h 冷却 |
| E2 | PR #1 评审任务（L3，sonnet） | ✅ | run `run_0mw4pw656tro0yo0h`：10 轮、$0.28。在 worktree 中拉取 PR 分支、`npm test` 4/4 通过、`tsc` 检查、写出 `review-pr1.md` 并通过 `deliver_artifact` 入库，以 `needs_human` 收尾 → Outbox 生成 question 审批 `apr_0mw4pxrbjly9ghu6y`「是否批准将 PR #1 合并到 sparkai-email」（低风险），任务 `waiting_human`。**该决策留给用户。** |
| E3 | 手动投递「写 USAGE.md」（L3，writing） | ✅ | `tc capture` → 分诊自动提升 → 规划器产出 7 步计划 + 4 条风险 → run `run_0mw4q2rn0aow3j1r8` 10 轮 $0.18 写出 137 行 USAGE.md（未知项标注「待确认」）→ review 审批 `apr_0mw4q4056y20tkxej` → `tc approvals approve` 接受 → 任务 `done`。交付物已复制为 `taskcenter/USAGE.md` |
| E4 | 代码任务（L4，code）：补充单元测试并推送 tc/ 分支 | ✅（等待人工） | worktree 分支 `tc/tsk_0mw4q53exbs4rbb6z`：新增 `tests/shared/{dates,folders}.test.ts`，`node --test` 14/14 通过，本地提交 5df6d1a；Agent 自行调用 `request_approval` 询问是否推送 → Outbox question 审批 `apr_0mw4q6rz3v08c0ib8`，任务 `waiting_human`，run 保留 session 可续跑。**推送决策留给用户**（批准后执行器以 `resume_after_approval` 续跑并推送） |
| E5 | 拒绝路径 | ✅（单元/实测） | runners 实测脚本：L3 下 `git push origin main` 被门控 → 审批 → 自动拒绝 → Agent 收到拒绝原因、以 blocked 收尾、远端无变化（见 docs/modules/runners.md） |
| E6 | 失败与重试 | ✅（测试） | `tests/engine-executor.test.ts`：失败 → attempts 递增、退避重排、达上限 `failed` + 通知 |
| E7 | 崩溃恢复 | ✅（测试 + 守护进程实测） | 引擎测试覆盖 `recovery`；守护进程启动时把中断的 run 标为 `interrupted`、任务回 `ready`；第二个守护进程被锁文件拒绝；SIGTERM 优雅退出 |
| E8 | 预算 | ✅（测试） | 80% 告警一次/日、100% 执行器自动暂停（`tests/engine-*`）；真实运行当日花费 $0.71 / $10 |
| E9 | 每日摘要 | ✅ | `tc digest` 产出中文摘要：重点、新收件箱、待审批（含过期时间）、任务、花费 |
| E10 | 云端心跳 | ✅（已创建并试跑） | Claude Code 定时任务 `trig_012Q1QZvHoE7FJkwThg4EKcc`，每天 07:37 / 19:37（Asia/Shanghai）新会话执行 `patrol --once && triage && state export` 并提交到 `taskcenter-state` 分支（首个导出 `ae25a1e`）；手动触发了一次验证运行 |
| E11 | 个人上下文 | ✅ | `tc context refresh` 生成 `data/context/profile.generated.md`（身份/项目/偏好/常设指令 + 学到的事实：「测试方案为 node --test + tsx」「偏好中文文档」+ 最近任务结果） |

## 守护进程

`tc daemon` 于 2026-11-06T08:44:33Z 启动（pid 15104，`data/taskcenter.lock`），8 个调度任务：patrol */15、triage */5、plan 每分钟、executor_tick 30 s、follow_ups 每 5 分钟、digest 08:30、context_refresh 07:15、maintenance 03:45（Asia/Shanghai）。看板 `http://127.0.0.1:4800`。

## 实测中发现并修复的问题

1. 嵌套 Claude Code 环境下 `--json-schema` 结构化输出返回空对象 → 单次结构化调用改为「文本 JSON + zod 校验」（`TC_CLI_JSON_SCHEMA=1` 可切回）。
2. `--max-turns 1` 与 `--json-schema` 冲突（StructuredOutput 工具调用占一轮）→ 同上。
3. 嵌套子进程继承外层 `CLAUDE_CODE_SESSION_ID` → 运行器显式分配每次运行的 session id，并剥离会话相关环境变量。
4. 非代码任务的普通目录工作区位于仓库内部，Agent 的 `git checkout -b` 落到了主仓库（已恢复分支）→ 工作区 `git init` 建立边界。
5. Agent 主动调用 `request_approval` 后任务已被审批服务置为 `waiting_human`，执行器误把 run 记为 `failed` → 保持 run 为 `waiting_human` 以便续跑。
6. GitHub token 被拒绝（401）时直接抛错 → 自动回退到 `gh` CLI 并记忆 auth_mode。

## 留给用户的决策（Outbox）

- `apr_0mw4pxrbjly9ghu6y`：是否批准将 PR #1 合并到 `sparkai-email`（评审意见见 `data/workspaces/tsk_0mw4pv83ess6u9vo7/review-pr1.md`）。
- `apr_0mw4q6rz3v08c0ib8`：是否允许推送测试分支 `tc/tsk_0mw4q53exbs4rbb6z` 到 origin。
