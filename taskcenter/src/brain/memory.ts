/**
 * Memory: record learned facts (deduplicated) and the daily context refresh
 * that consolidates memories and writes data/context/profile.generated.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Config } from "../config/schema.js";
import type { LoadedConfig } from "../config/load.js";
import type { Bus } from "../core/events.js";
import type { Logger } from "../core/logger.js";
import type { Repo } from "../core/repo.js";
import { DAY } from "../core/time.js";
import type { Memory, MemoryKind } from "../core/types.js";
import { loadContext, pickLang, renderMemories } from "./context.js";
import type { LlmProvider } from "./llm.js";
import { truncateChars } from "./providers/util.js";

export function inferMemoryKind(text: string): MemoryKind {
  const t = text.toLowerCase();
  if (/(prefer|likes?|dislikes?|wants?|hates?|favou?rite|喜欢|偏好|不喜欢|希望|倾向)/.test(t)) return "preference";
  if (/(every (day|week|morning|evening)|usually|habit|daily|weekly|routine|每天|每周|习惯|通常|一般)/.test(t)) return "habit";
  if (/(goal|aim|plan(s|ning)? to|objective|目标|计划|打算)/.test(t)) return "goal";
  if (/(project|repo(sitory)?|codebase|release|deploy|项目|仓库|版本|发布)/.test(t)) return "project";
  if (/(@|colleague|collaborator|teammate|manager|client|customer|friend|works at|is (a|the) |同事|合作|客户|朋友|负责人)/.test(t)) return "person";
  return "fact";
}

function normaliseFact(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/[.。]$/, "");
}

/** Save learned facts; returns the number of NEW memories created. */
export function recordLearned(repo: Repo, learned: string[], source: string, bus?: Bus): number {
  let added = 0;
  const seen = new Set<string>();
  for (const raw of learned ?? []) {
    if (typeof raw !== "string") continue;
    const content = normaliseFact(raw);
    if (content.length < 6 || content.length > 500) continue;
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = inferMemoryKind(content);
    const { memory, isNew } = repo.memories.upsertByContent({ kind, content, source, confidence: 0.6, tags: [] });
    if (isNew) {
      added++;
      bus?.record({ type: "memory", message: `learned [${kind}] ${truncateChars(content, 120)}`, task_id: source.startsWith("tsk_") ? source : null, payload: { memory_id: memory.id, kind, source } });
    }
  }
  return added;
}

/** Retire exact-duplicate (case/whitespace-insensitive) and stale low-confidence memories. */
export function consolidateMemories(repo: Repo, now = new Date()): { retired: number } {
  const active = repo.memories.active({ limit: 5000 });
  const byKey = new Map<string, Memory>();
  let retired = 0;
  for (const m of active) {
    const key = normaliseFact(m.content).toLowerCase();
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, m);
      continue;
    }
    // keep the higher-confidence one
    const loser = prev.confidence >= m.confidence ? m : prev;
    const winner = loser === m ? prev : m;
    repo.memories.retire(loser.id);
    byKey.set(key, winner);
    retired++;
  }
  for (const m of byKey.values()) {
    const age = now.getTime() - new Date(m.updated_at).getTime();
    if (m.confidence < 0.5 && age > 30 * DAY) {
      repo.memories.retire(m.id);
      retired++;
    }
  }
  return { retired };
}

export interface RefreshDeps {
  repo: Repo;
  config: Config;
  loaded: LoadedConfig;
  llm?: LlmProvider;
  logger: Logger;
}

export function generatedProfilePath(loaded: LoadedConfig): string {
  return resolve(loaded.resolve(loaded.config.data_dir), "context", "profile.generated.md");
}

/**
 * Daily context refresh:
 *  1. harvest `learned` facts from runs finished in the last 24h
 *  2. consolidate memories
 *  3. write data/context/profile.generated.md (profile + top memories + recent outcomes)
 *  4. optionally ask the LLM (haiku) for profile update suggestions (appended; profile.yaml is never edited)
 */
export async function refreshContext(deps: RefreshDeps): Promise<{ memoriesAdded: number }> {
  const { repo, config, loaded, llm, logger } = deps;
  const now = new Date();
  const since = new Date(now.getTime() - DAY).toISOString();
  let memoriesAdded = 0;

  // 1. harvest from recent run results
  const recentRuns = repo.runs.list({ status: ["succeeded", "waiting_human"], limit: 200 }).filter((r) => (r.ended_at ?? r.updated_at) >= since);
  for (const r of recentRuns) {
    const learned = r.result?.learned;
    if (Array.isArray(learned) && learned.length) memoriesAdded += recordLearned(repo, learned, r.task_id);
  }

  // 2. consolidate
  const { retired } = consolidateMemories(repo, now);

  // 3. render generated profile
  const ctx = loadContext(loaded, repo);
  const lang = pickLang(config.locale);
  const top = repo.memories.active({ minConfidence: 0.5, limit: 80 });
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const recentTasks = repo.tasks.list({ status: ["done", "failed", "review", "waiting_human"], limit: 300 }).filter((t) => (t.finished_at ?? t.updated_at) >= weekAgo).slice(0, 30);
  const outcomes = recentTasks.map((t) => `- [${t.status}] ${t.title}${t.result_summary ? ` — ${truncateChars(t.result_summary, 200)}` : ""}`).join("\n");
  const titles = lang === "zh-CN" ? { h: "生成的个人上下文", o: "最近任务结果", s: "建议的 profile 更新", none: "（无）", gen: "由 Task Center 自动生成；请勿手动编辑，修改请改 config/profile.yaml" } : { h: "Generated personal context", o: "Recent task outcomes", s: "Suggested profile updates", none: "(none)", gen: "Generated by Task Center; do not edit by hand — change config/profile.yaml instead" };
  let md = `# ${titles.h}\n\n> ${titles.gen} · ${now.toISOString()}\n\n${ctx.profileText}\n\n${renderMemories(top, config.locale)}\n\n## ${titles.o}\n${outcomes || titles.none}\n`;

  // 4. optional LLM suggestions
  if (llm && process.env.TC_CONTEXT_LLM !== "off") {
    try {
      const res = await llm.complete({
        model: config.brain.models.classify,
        system: "You maintain a personal context profile for an AI assistant. Be terse and concrete; suggest only changes supported by evidence.",
        prompt: `Current profile:\n${ctx.profileText}\n\nLearned memories:\n${renderMemories(top, config.locale)}\n\nRecent outcomes:\n${outcomes || "(none)"}\n\nPropose updates to the profile (new projects, people, preferences, outdated entries) as a markdown bullet list in ${lang === "zh-CN" ? "Simplified Chinese" : "English"}. If nothing should change, answer with a single bullet saying so. Do not output anything else.`,
        effort: "low",
        purpose: "profile-suggestions",
        logger,
        timeoutMs: 120_000,
      });
      md += `\n## ${titles.s}\n${res.text.trim()}\n`;
    } catch (e) {
      logger.warn(`profile suggestion call failed: ${(e as Error).message}`);
    }
  }

  const path = generatedProfilePath(loaded);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, md);
  } catch (e) {
    logger.warn(`could not write ${path}: ${(e as Error).message}`);
  }
  logger.info(`context refresh: +${memoriesAdded} memories, ${retired} retired, wrote ${path}`);
  return { memoriesAdded };
}
