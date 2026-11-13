/** zh-CN labels (with English hints) for enumerations. */
import type { ApprovalStatus, ArtifactType, Category, EventType, InboxKind, InboxStatus, Level, MemoryKind, Priority, Risk, RunStatus, TaskStatus } from "./types";

export const TASK_STATUS: Record<TaskStatus, string> = {
  todo: "待办",
  planning: "规划中",
  ready: "就绪",
  running: "运行中",
  waiting_human: "等待人工",
  review: "待审阅",
  blocked: "阻塞",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
export const TASK_STATUS_ORDER: TaskStatus[] = ["todo", "planning", "ready", "running", "waiting_human", "review", "blocked", "done", "failed", "cancelled"];

export const RUN_STATUS: Record<RunStatus, string> = {
  queued: "排队",
  running: "运行中",
  waiting_human: "等待人工",
  succeeded: "成功",
  failed: "失败",
  interrupted: "中断",
  cancelled: "已取消",
};

export const INBOX_STATUS: Record<InboxStatus, string> = {
  new: "新",
  triaged: "已分诊",
  promoted: "已提升",
  dismissed: "已忽略",
  snoozed: "稍后",
  done: "完成",
};

export const INBOX_KIND: Record<InboxKind, string> = {
  todo: "待办",
  problem: "问题",
  opportunity: "机会",
  decision: "决策",
  info: "信息",
};

export const APPROVAL_STATUS: Record<ApprovalStatus, string> = {
  pending: "待确认",
  approved: "已批准",
  rejected: "已拒绝",
  edited: "修改后批准",
  expired: "已过期",
  cancelled: "已取消",
};

export const APPROVAL_KIND: Record<string, string> = { action: "操作", decision: "决策", review: "审阅", question: "提问" };

export const RISK: Record<Risk, string> = { low: "低风险", medium: "中风险", high: "高风险" };

export const PRIORITY: Record<Priority, string> = { P0: "P0 紧急", P1: "P1 高", P2: "P2 中", P3: "P3 低" };

export const LEVEL: Record<Level, { short: string; name: string; desc: string }> = {
  1: { short: "L1", name: "仅通知", desc: "只汇总与提醒，不采取行动" },
  2: { short: "L2", name: "建议", desc: "给出建议或草稿，所有动作需你确认" },
  3: { short: "L3", name: "受限执行", desc: "可在工作区内读写与运行测试，对外副作用需审批" },
  4: { short: "L4", name: "自主执行", desc: "自主完成并提交结果，高风险动作仍需审批" },
  5: { short: "L5", name: "完全授权", desc: "按预授权清单直接执行，事后汇报" },
};

export const CATEGORY: Record<Category, string> = {
  code: "代码",
  research: "调研",
  writing: "写作",
  communication: "沟通",
  external_communication: "对外沟通",
  scheduling: "日程",
  finance: "财务",
  publishing: "发布",
  ops: "运维",
  learning: "学习",
  personal: "个人",
  admin: "行政",
  other: "其他",
};

export const EVENT_TYPE: Record<EventType, string> = {
  tool_call: "工具调用",
  tool_result: "工具结果",
  assistant_message: "助手消息",
  status_change: "状态变更",
  approval_requested: "请求审批",
  approval_decided: "审批决定",
  notification: "通知",
  error: "错误",
  cost: "费用",
  sensor_poll: "传感器轮询",
  triage: "分诊",
  plan: "规划",
  run_started: "运行开始",
  run_finished: "运行结束",
  artifact: "交付物",
  memory: "记忆",
  system: "系统",
};

export const ARTIFACT_TYPE: Record<ArtifactType, { label: string; icon: string }> = {
  file: { label: "文件", icon: "📄" },
  url: { label: "链接", icon: "🔗" },
  text: { label: "文本", icon: "📝" },
  pr: { label: "PR", icon: "🔀" },
  email_draft: { label: "邮件草稿", icon: "✉️" },
  document: { label: "文档", icon: "📑" },
  patch: { label: "补丁", icon: "🩹" },
};

export const MEMORY_KIND: Record<MemoryKind, string> = {
  fact: "事实",
  preference: "偏好",
  project: "项目",
  person: "人物",
  habit: "习惯",
  goal: "目标",
};

export const SOURCE: Record<string, string> = {
  github: "GitHub",
  imap: "邮件",
  ics: "日历",
  localgit: "本地 Git",
  fsdocs: "文档",
  manual: "手动",
  webhook: "Webhook",
};

export const DECISION_LABEL: Record<string, string> = {
  approve: "批准",
  edit: "修改后批准",
  reject: "拒绝",
  respond: "回复",
};

export const SCHEDULE_JOB: Record<string, string> = {
  patrol: "巡检 (patrol)",
  digest: "每日摘要 (digest)",
  context_refresh: "上下文刷新",
  maintenance: "维护 (maintenance)",
};

export function label<K extends string>(map: Record<K, string>, key: K | string | null | undefined): string {
  if (key === null || key === undefined) return "—";
  return (map as Record<string, string>)[key] ?? String(key);
}
