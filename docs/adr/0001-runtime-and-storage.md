# ADR 0001: 运行时与存储选择

- 状态：已采纳（2026-11-05）
- 决策：Task Center 使用 **Node ≥ 22 + TypeScript (ESM)**，存储使用内置 **`node:sqlite`**（WAL、JSON1、FTS5），不引入原生模块。
- 备选：Bun + bun:sqlite（更快，但用户机器未必有 Bun；Claude CLI 本身依赖 Node）；better-sqlite3（成熟但需原生编译/预编译二进制，迁移时偶发失败）；PostgreSQL（功能强但增加运维负担，违背“单文件可迁移”原则）。
- 后果：Node 22 下导入 `node:sqlite` 会打印 ExperimentalWarning，CLI 入口统一抑制；Node 24 下无警告。数据库访问集中在 `core/db.ts`，若未来需要换引擎只改一处。
