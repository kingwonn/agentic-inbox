# ADR 0002: 以 Claude Code（headless / Agent SDK）作为默认“大脑”

- 状态：已采纳（2026-11-05）
- 背景：环境中没有 Codex CLI 与 OpenAI/Anthropic API Key；但 `claude -p` 已验证可用（haiku / sonnet / fable），并且用户本机也已登录 Claude Code。
- 决策：Runner 抽象 `Runner` 接口；默认实现 `claude-sdk`（`@anthropic-ai/claude-agent-sdk`），备选 `claude-cli`（直接 spawn `claude -p --output-format stream-json`）、`codex`（检测到 `codex` 可执行文件时启用）、`dry`（测试）。分类/规划等“单次结构化调用”也走同一抽象（`llm.ts`），默认模型分级：classify=haiku, plan=sonnet, execute=sonnet。
- 后果：无需管理 API Key；成本记录来自 CLI 的 `total_cost_usd`；在嵌套 Claude Code 会话中运行需要清理 `CLAUDECODE` 等环境变量（见 runners 实现）。
