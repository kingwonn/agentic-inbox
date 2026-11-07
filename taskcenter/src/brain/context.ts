/**
 * Personal context assembly: profile.yaml + learned memories, rendered as a
 * compact text block that the classifier, planner and execution prompts share.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { LoadedConfig } from "../config/load.js";
import type { Repo } from "../core/repo.js";
import type { Memory } from "../core/types.js";
import { estimateTokens, truncateToTokens } from "./providers/util.js";

export interface ContextSnapshot {
  profile: Record<string, unknown>;
  profileText: string;
  memoriesText: string;
  text: string;
  locale: string;
}

const MAX_CONTEXT_TOKENS = 3000;

export function loadProfile(loaded: LoadedConfig): Record<string, unknown> {
  const candidates = [loaded.resolve(loaded.config.profile_path), loaded.resolve("config/profile.yaml"), loaded.resolve("config/profile.example.yaml")];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = parseYaml(readFileSync(p, "utf8"));
      if (raw && typeof raw === "object") return raw as Record<string, unknown>;
    } catch {
      /* try next */
    }
  }
  return {};
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const L = {
  "zh-CN": {
    identity: "身份",
    roles: "角色与职责",
    projects: "项目",
    goals: "长期目标",
    interests: "兴趣",
    habits: "习惯",
    prefs: "偏好",
    confirm: "必须先确认",
    okWithout: "无需确认",
    priorityRules: "优先级规则",
    people: "相关人",
    orders: "常设指令",
    never: "绝不",
    memories: "已学到的事实",
    noMemories: "（暂无）",
    status: "状态",
    priority: "优先级",
  },
  en: {
    identity: "Identity",
    roles: "Roles & responsibilities",
    projects: "Projects",
    goals: "Long-term goals",
    interests: "Interests",
    habits: "Habits",
    prefs: "Preferences",
    confirm: "Always confirm before",
    okWithout: "OK without asking",
    priorityRules: "Priority rules",
    people: "People",
    orders: "Standing orders",
    never: "Never",
    memories: "Learned facts",
    noMemories: "(none yet)",
    status: "status",
    priority: "priority",
  },
};

export function pickLang(locale: string): "zh-CN" | "en" {
  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** Render profile.yaml as compact markdown in the profile's preferred language. */
export function renderProfile(profile: Record<string, unknown>, locale: string): string {
  const identity = obj(profile.identity);
  const lang = pickLang(str(identity.preferred_language) || locale);
  const t = L[lang];
  const lines: string[] = [];
  if (Object.keys(identity).length) {
    const parts = [identity.name && `${str(identity.name)}${identity.handle ? ` (@${str(identity.handle)})` : ""}`, identity.email && str(identity.email), identity.timezone && `tz ${str(identity.timezone)}`, identity.languages && `${str(identity.languages)}`].filter(Boolean);
    lines.push(`## ${t.identity}`, parts.join(" · "));
  }
  const roles = list(profile.roles);
  if (roles.length) {
    lines.push(`## ${t.roles}`);
    for (const r of roles) {
      const ro = obj(r);
      lines.push(`- ${str(ro.title)}${list(ro.responsibilities).length ? `: ${list(ro.responsibilities).map(str).join("; ")}` : ""}`);
    }
  }
  const projects = list(profile.projects);
  if (projects.length) {
    lines.push(`## ${t.projects}`);
    for (const p of projects) {
      const po = obj(p);
      const bits = [po.status && `${t.status}=${str(po.status)}`, po.priority && `${t.priority}=${str(po.priority)}`, list(po.repos).length && `repos: ${str(po.repos)}`].filter(Boolean);
      lines.push(`- **${str(po.name)}** (${bits.join(", ")}) ${str(po.summary)}${list(po.goals).length ? ` — goals: ${str(po.goals)}` : ""}`);
    }
  }
  if (list(profile.long_term_goals).length) lines.push(`## ${t.goals}`, ...list(profile.long_term_goals).map((g) => `- ${str(g)}`));
  if (list(profile.interests).length) lines.push(`## ${t.interests}`, `- ${list(profile.interests).map(str).join("; ")}`);
  const habits = obj(profile.habits);
  if (Object.keys(habits).length) lines.push(`## ${t.habits}`, Object.entries(habits).map(([k, v]) => `${k}: ${str(v)}`).join("; "));
  const prefs = obj(profile.preferences);
  if (Object.keys(prefs).length) {
    lines.push(`## ${t.prefs}`);
    const comm = obj(prefs.communication);
    if (comm.tone) lines.push(`- tone: ${str(comm.tone)}`);
    if (list(comm.always_confirm_before).length) lines.push(`- ${t.confirm}: ${str(comm.always_confirm_before)}`);
    if (list(comm.ok_without_asking).length) lines.push(`- ${t.okWithout}: ${str(comm.ok_without_asking)}`);
    const code = obj(prefs.code);
    if (Object.keys(code).length) lines.push(`- code: ${Object.entries(code).map(([k, v]) => `${k}=${str(v)}`).join("; ")}`);
    const rules = list(obj(prefs.priorities).rules);
    if (rules.length) lines.push(`- ${t.priorityRules}: ${rules.map(str).join(" | ")}`);
  }
  const people = list(profile.people).filter((p) => !/add collaborators/i.test(str(obj(p).name)));
  if (people.length) lines.push(`## ${t.people}`, ...people.map((p) => `- ${str(obj(p).name)} (${str(obj(p).relation)})${obj(p).notes ? `: ${str(obj(p).notes)}` : ""}`));
  const orders = obj(profile.standing_orders);
  if (Object.keys(orders).length) {
    lines.push(`## ${t.orders}`);
    for (const [k, v] of Object.entries(orders)) lines.push(`- ${k}: ${str(v)}`);
  }
  return lines.join("\n");
}

export function renderMemories(memories: Memory[], locale: string): string {
  const t = L[pickLang(locale)];
  if (!memories.length) return `## ${t.memories}\n${t.noMemories}`;
  return [`## ${t.memories}`, ...memories.map((m) => `- [${m.kind}${m.confidence < 0.7 ? "?" : ""}] ${m.content}`)].join("\n");
}

export function loadContext(loaded: LoadedConfig, repo: Repo): ContextSnapshot {
  const locale = loaded.config.locale || "zh-CN";
  const profile = loadProfile(loaded);
  const profileText = renderProfile(profile, locale);
  let memories: Memory[] = [];
  try {
    memories = repo.memories.active({ minConfidence: 0.5, limit: 60 });
  } catch {
    memories = [];
  }
  const memoriesText = renderMemories(memories, locale);
  // Budget: profile gets up to 2/3, memories the rest.
  let text = `${profileText}\n\n${memoriesText}`.trim();
  if (estimateTokens(text) > MAX_CONTEXT_TOKENS) {
    const p = truncateToTokens(profileText, Math.floor(MAX_CONTEXT_TOKENS * 0.66));
    const m = truncateToTokens(memoriesText, MAX_CONTEXT_TOKENS - estimateTokens(p));
    text = `${p}\n\n${m}`.trim();
  }
  return { profile, profileText, memoriesText, text, locale };
}
