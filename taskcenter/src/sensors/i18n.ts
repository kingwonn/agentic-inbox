/**
 * Tiny locale table for sensor-generated text (titles / key-fact labels).
 * Signals carry the source's own text (PR title, email subject, event summary);
 * only the sentences the sensors compose themselves are localised here.
 */
export type SensorLocale = "zh-CN" | "en";

const TABLE: Record<string, { "zh-CN": string; en: string }> = {
  // localgit
  "git.uncommitted.title": { "zh-CN": "{repo}：{n} 处未提交改动（{branch}）", en: "{repo}: {n} uncommitted change(s) on {branch}" },
  "git.uncommitted.resolved": { "zh-CN": "{repo}：未提交改动已清理", en: "{repo}: working tree is clean again" },
  "git.unpushed.title": { "zh-CN": "{repo}：{n} 个分支有未推送提交", en: "{repo}: {n} branch(es) with unpushed commits" },
  "git.unpushed.resolved": { "zh-CN": "{repo}：所有提交已推送", en: "{repo}: all commits pushed" },
  "git.stale.title": { "zh-CN": "{repo}：{n} 个分支超过 {days} 天无提交", en: "{repo}: {n} branch(es) idle for more than {days} days" },
  "git.stale.resolved": { "zh-CN": "{repo}：不再有陈旧分支", en: "{repo}: no stale branches left" },
  "git.conflicts.title": { "zh-CN": "{repo}：存在合并冲突（{n} 个文件）", en: "{repo}: merge conflicts in {n} file(s)" },
  "git.conflicts.resolved": { "zh-CN": "{repo}：合并冲突已解决", en: "{repo}: merge conflicts resolved" },
  "git.detached.title": { "zh-CN": "{repo}：HEAD 处于分离状态（{sha}）", en: "{repo}: detached HEAD at {sha}" },
  "git.detached.resolved": { "zh-CN": "{repo}：HEAD 已回到分支", en: "{repo}: HEAD is back on a branch" },
  "git.label.branch": { "zh-CN": "分支", en: "Branch" },
  "git.label.files": { "zh-CN": "文件", en: "Files" },
  "git.label.staged": { "zh-CN": "已暂存", en: "staged" },
  "git.label.unstaged": { "zh-CN": "未暂存", en: "unstaged" },
  "git.label.untracked": { "zh-CN": "未跟踪", en: "untracked" },
  "git.label.ahead": { "zh-CN": "领先 {n} 个提交", en: "{n} commit(s) ahead" },
  "git.label.behind": { "zh-CN": "落后 {n}", en: "{n} behind" },
  "git.label.noUpstream": { "zh-CN": "无上游分支，{n} 个本地提交", en: "no upstream, {n} local-only commit(s)" },
  "git.label.gone": { "zh-CN": "上游已删除", en: "upstream gone" },
  "git.label.lastCommit": { "zh-CN": "最后提交", en: "last commit" },
  "git.label.daysAgo": { "zh-CN": "{n} 天前", en: "{n} days ago" },
  "git.label.operation": { "zh-CN": "进行中的操作", en: "In-progress operation" },
  "git.label.more": { "zh-CN": "…还有 {n} 个", en: "…and {n} more" },

  // fsdocs
  "docs.new": { "zh-CN": "新文档：{name}", en: "New document: {name}" },
  "docs.updated": { "zh-CN": "文档更新：{name}", en: "Document updated: {name}" },
  "docs.label.path": { "zh-CN": "路径", en: "Path" },
  "docs.label.todos": { "zh-CN": "待办项", en: "Open items" },

  // github
  "gh.label.state": { "zh-CN": "状态", en: "State" },
  "gh.label.author": { "zh-CN": "作者", en: "Author" },
  "gh.label.updated": { "zh-CN": "更新于", en: "Updated" },
  "gh.label.branch": { "zh-CN": "分支", en: "Branch" },
  "gh.label.checks": { "zh-CN": "检查", en: "Checks" },
  "gh.label.review": { "zh-CN": "评审", en: "Review" },
  "gh.label.labels": { "zh-CN": "标签", en: "Labels" },
  "gh.label.comments": { "zh-CN": "评论", en: "Comments" },
  "gh.label.assignees": { "zh-CN": "负责人", en: "Assignees" },
  "gh.label.mergeable": { "zh-CN": "可合并", en: "Mergeable" },
  "gh.label.draft": { "zh-CN": "草稿", en: "draft" },
  "gh.label.assignedToMe": { "zh-CN": "分配给我", en: "assigned to me" },
  "gh.label.reviewRequested": { "zh-CN": "请求我评审", en: "my review requested" },
  "gh.checks.failing.title": { "zh-CN": "{repo}#{n} 检查失败：{names}", en: "{repo}#{n}: failing checks: {names}" },
  "gh.commits.title": { "zh-CN": "{repo} {branch} 新增 {n} 个提交", en: "{repo}: {n} new commit(s) on {branch}" },
  "gh.branch.stale.title": { "zh-CN": "{repo}：分支 {branch} 自 {date} 起无更新", en: "{repo}: branch {branch} has had no commits since {date}" },
  "gh.branch.label.aheadBehind": { "zh-CN": "相对 {base}：领先 {ahead}，落后 {behind}", en: "vs {base}: {ahead} ahead, {behind} behind" },
  "gh.branch.label.openPr": { "zh-CN": "关联 PR", en: "Open PR" },
  "gh.notification.title": { "zh-CN": "[{reason}] {title}", en: "[{reason}] {title}" },
  "gh.pr.title": { "zh-CN": "PR #{n}: {title}", en: "PR #{n}: {title}" },
  "gh.issue.title": { "zh-CN": "Issue #{n}: {title}", en: "Issue #{n}: {title}" },

  // ics
  "ics.label.when": { "zh-CN": "时间", en: "When" },
  "ics.label.where": { "zh-CN": "地点", en: "Where" },
  "ics.label.attendees": { "zh-CN": "参与者", en: "Attendees" },
  "ics.label.organizer": { "zh-CN": "组织者", en: "Organizer" },
  "ics.label.status": { "zh-CN": "状态", en: "Status" },
  "ics.allDay": { "zh-CN": "全天", en: "all day" },
  "ics.removed.title": { "zh-CN": "日程已移除：{summary}", en: "Event removed: {summary}" },
  "ics.cancelled.title": { "zh-CN": "日程已取消：{summary}", en: "Event cancelled: {summary}" },
  "ics.updated.title": { "zh-CN": "日程变更：{summary}", en: "Event changed: {summary}" },

  // imap
  "mail.noSubject": { "zh-CN": "（无主题）", en: "(no subject)" },
  "mail.label.from": { "zh-CN": "发件人", en: "From" },
  "mail.label.to": { "zh-CN": "收件人", en: "To" },
  "mail.label.date": { "zh-CN": "日期", en: "Date" },
  "mail.label.attachments": { "zh-CN": "附件", en: "Attachments" },
  "mail.label.bulk": { "zh-CN": "群发/通知邮件", en: "bulk/notification mail" },
};

export function normalizeLocale(locale: unknown): SensorLocale {
  const l = String(locale ?? "zh-CN").toLowerCase();
  return l.startsWith("zh") ? "zh-CN" : "en";
}

export function t(locale: unknown, key: string, params: Record<string, string | number> = {}): string {
  const entry = TABLE[key];
  let s = entry ? entry[normalizeLocale(locale)] : key;
  for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
