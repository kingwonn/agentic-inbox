# 交接：在本机（Mac）部署 Task Center

> 本文给**在用户电脑上运行的 Claude Code 会话**使用（桌面应用或终端）。目标：把 Task Center 装到这台 Mac、常驻运行、接入 Codex、导入 ChatGPT 上下文。云端会话无法触达用户电脑，所以这些步骤只能在本机完成。

## 规则
- 任何密钥只写入 `taskcenter/.env`（chmod 600），不要出现在聊天里，也不要提交到 git。
- 代码留在分支 `feat/taskcenter`（或从它新建分支），不要推送到 `main`。
- 不可逆操作（删除、对外发送、推送）先问用户。

## 步骤

1. **前置检查**：`node -v`（需 ≥ 22.12，不满足用 `brew install node@22` 或 nvm）、`git --version`、`claude --version`（未登录先运行 `claude` 登录）、可选 `gh auth login`。
2. **取代码**：
   ```bash
   mkdir -p ~/ai && cd ~/ai
   git clone -b feat/taskcenter https://github.com/kingwonn/agentic-inbox   # 已存在则 git fetch && git checkout feat/taskcenter
   cd agentic-inbox/taskcenter && npm install && npm run tc -- init && npm run build:web
   ```
3. **凭据**（让用户自己填进 `.env`，逐项说明怎么拿）：
   - `GITHUB_TOKEN`：GitHub → Settings → Developer settings → PAT（classic，勾 `repo`、`notifications`）。
   - `IMAP_USER` / `IMAP_PASSWORD`：Gmail 账号 + 应用专用密码（Google 账号 → 安全 → 两步验证 → 应用专用密码）。
   - `CALENDAR_ICS_URL`：Google 日历 → 设置 → 该日历 → 「iCal 格式的私密地址」。
   - `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`：@BotFather 建 bot；给 bot 发 /start 后用 getUpdates 取 chat id。
   填完后在 `config/taskcenter.yaml` 里把对应 `enabled: true`，并把 `sensors.localgit.repos` 改成用户的代码目录、`sensors.fsdocs.paths` 改成笔记目录。
4. **个人上下文**：和用户对话，补全 `config/profile.yaml`（职责、项目、目标、习惯、偏好、常设指令）。
5. **ChatGPT 历史导入**（可选）：让用户在 ChatGPT → Settings → Data controls → Export data 导出，把 `conversations.json` 放到本机某目录；读取后提炼项目/目标/偏好，经用户确认写入 `profile.yaml`，关键事实通过 `curl -X POST http://127.0.0.1:4800/api/memories -H 'content-type: application/json' -d '{"kind":"fact","content":"..."}'` 写入记忆（守护进程启动后）。
6. **验证并启动**：`npm run tc -- doctor` → 全绿后 `npm run tc -- patrol`（看 Inbox 是否有东西）→ `npm run tc -- daemon`，打开 http://127.0.0.1:4800 检查看板。
7. **常驻**：复制 `deploy/com.agenticinbox.taskcenter.plist` 到 `~/Library/LaunchAgents/`，把 node 路径（`which node`）和工作目录改对，`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agenticinbox.taskcenter.plist`，杀掉进程确认会自动重启。
8. **Codex（可选）**：`npm i -g @openai/codex && codex login`（用 ChatGPT 账号），`codex --version` 正常后运行器自动可用；代码类任务可在看板任务详情里把 runner 设为 `codex`。
9. **汇报**：doctor 输出、守护进程状态、看板截图、Outbox 待审批项（云端已有两项：PR #1 是否合并、测试分支是否推送）。

参考：`taskcenter/README.md`、`taskcenter/USAGE.md`、`taskcenter/deploy/README.md`、`docs/runbook.md`。
