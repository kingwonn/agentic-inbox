import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Category, Level, Priority, Risk } from "./types.js";
import { PRIORITY_RANK } from "./types.js";

const LevelSchema = z.number().int().min(1).max(5);

export const PolicySchema = z.object({
  version: z.number().default(1),
  levels: z
    .object({
      auto_promote: z
        .object({ min_level: LevelSchema.default(3), max_priority: z.enum(["P0", "P1", "P2", "P3"]).default("P2") })
        .default({ min_level: 3, max_priority: "P2" }),
      confidence_floor: z.number().min(0).max(1).default(0.6),
      default_level: LevelSchema.default(2),
    })
    .default({ auto_promote: { min_level: 3, max_priority: "P2" }, confidence_floor: 0.6, default_level: 2 }),
  categories: z.record(z.string(), z.object({ max_level: LevelSchema })).default({}),
  capabilities: z
    .record(z.string(), z.object({ requires: z.array(z.string()).default([]), max_level_without: LevelSchema.default(2) }))
    .default({}),
  overrides: z
    .array(
      z.object({
        match: z.object({ source: z.string().optional(), keyword: z.string().optional(), category: z.string().optional(), tag: z.string().optional() }),
        max_level: LevelSchema.optional(),
        min_level: LevelSchema.optional(),
        category: z.string().optional(),
        priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
      }),
    )
    .default([]),
  tools: z
    .object({
      by_level: z.record(z.string(), z.object({ allow: z.array(z.string()).default([]), deny: z.array(z.string()).default([]) })).default({}),
      always_approve: z
        .object({
          tools: z.array(z.string()).default([]),
          bash_patterns: z.array(z.string()).default([]),
          paths_outside_workspace: z.enum(["approve", "deny", "allow"]).default("approve"),
        })
        .default({ tools: [], bash_patterns: [], paths_outside_workspace: "approve" }),
      always_deny: z.object({ tools: z.array(z.string()).default([]), bash_patterns: z.array(z.string()).default([]) }).default({ tools: [], bash_patterns: [] }),
      level5_preauthorized: z.object({ tools: z.array(z.string()).default([]), bash_patterns: z.array(z.string()).default([]) }).default({ tools: [], bash_patterns: [] }),
    })
    .default({ by_level: {}, always_approve: { tools: [], bash_patterns: [], paths_outside_workspace: "approve" }, always_deny: { tools: [], bash_patterns: [] }, level5_preauthorized: { tools: [], bash_patterns: [] } }),
  risk: z
    .object({ high_patterns: z.array(z.string()).default([]), medium_patterns: z.array(z.string()).default([]) })
    .default({ high_patterns: [], medium_patterns: [] }),
});

export type PolicyConfig = z.infer<typeof PolicySchema>;

export interface LevelInput {
  proposed: Level;
  category: Category | string;
  priority: Priority;
  confidence: number;
  source?: string;
  text?: string; // title + summary for keyword overrides
  tags?: string[];
  requiredCapabilities?: string[];
  availableCapabilities?: string[]; // e.g. ["smtp","github_token"]
}

export interface LevelDecision {
  level: Level;
  category: Category | string;
  priority: Priority;
  reasons: string[];
  autoPromote: boolean;
}

export type GateDecision =
  | { action: "allow"; reason: string }
  | { action: "deny"; reason: string }
  | { action: "approve"; reason: string; risk: Risk };

function clampLevel(n: number): Level {
  return Math.max(1, Math.min(5, Math.round(n))) as Level;
}

function matchesAny(patterns: string[], text: string): string | null {
  for (const p of patterns) {
    try {
      if (new RegExp(p, "i").test(text)) return p;
    } catch {
      /* bad pattern: ignore */
    }
  }
  return null;
}

/** Glob-ish tool matcher: supports trailing `*` and exact names. */
function toolMatches(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true;
  if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1));
  return false;
}

export class Policy {
  constructor(readonly cfg: PolicyConfig) {}

  static load(path: string): Policy {
    const raw = parseYaml(readFileSync(path, "utf8")) ?? {};
    return new Policy(PolicySchema.parse(raw));
  }

  static default(): Policy {
    return new Policy(PolicySchema.parse({}));
  }

  /** Clamp the LLM-proposed level using deterministic rules. */
  decideLevel(input: LevelInput): LevelDecision {
    const reasons: string[] = [];
    let level = clampLevel(input.proposed);
    let category = input.category;
    let priority = input.priority;

    // Overrides (first match wins for each field it sets)
    for (const o of this.cfg.overrides) {
      const m = o.match;
      let hit = true;
      if (m.source && m.source !== input.source) hit = false;
      if (m.category && m.category !== category) hit = false;
      if (m.tag && !(input.tags ?? []).includes(m.tag)) hit = false;
      if (m.keyword && !new RegExp(m.keyword, "i").test(input.text ?? "")) hit = false;
      if (!hit) continue;
      if (o.category) {
        category = o.category;
        reasons.push(`override category=${o.category}`);
      }
      if (o.priority) {
        priority = o.priority;
        reasons.push(`override priority=${o.priority}`);
      }
      if (o.max_level !== undefined && level > o.max_level) {
        level = clampLevel(o.max_level);
        reasons.push(`override max_level=${o.max_level}`);
      }
      if (o.min_level !== undefined && level < o.min_level) {
        level = clampLevel(o.min_level);
        reasons.push(`override min_level=${o.min_level}`);
      }
    }

    // Category cap
    const cat = this.cfg.categories[category] ?? this.cfg.categories["other"];
    if (cat && level > cat.max_level) {
      level = clampLevel(cat.max_level);
      reasons.push(`category ${category} max_level=${cat.max_level}`);
    }

    // Capability availability
    const avail = new Set(input.availableCapabilities ?? []);
    for (const capName of input.requiredCapabilities ?? []) {
      const cap = this.cfg.capabilities[capName];
      if (!cap) continue;
      const missing = cap.requires.filter((r) => !avail.has(r));
      if (missing.length && level > cap.max_level_without) {
        level = clampLevel(cap.max_level_without);
        reasons.push(`missing capability ${capName} (${missing.join(",")}) -> max ${cap.max_level_without}`);
      }
    }

    // Confidence
    if (input.confidence < this.cfg.levels.confidence_floor && level > 1) {
      level = clampLevel(level - 1);
      reasons.push(`confidence ${input.confidence.toFixed(2)} < ${this.cfg.levels.confidence_floor}`);
    }

    const ap = this.cfg.levels.auto_promote;
    const autoPromote = level >= ap.min_level && PRIORITY_RANK[priority] <= PRIORITY_RANK[ap.max_priority];
    return { level, category, priority, reasons, autoPromote };
  }

  /** allowed/disallowed tool lists for a level (for the Agent SDK options). */
  toolsForLevel(level: Level): { allow: string[]; deny: string[] } {
    const t = this.cfg.tools.by_level[String(level)] ?? this.cfg.tools.by_level["2"] ?? { allow: ["Read", "Grep", "Glob"], deny: ["Write", "Edit", "Bash"] };
    return { allow: [...t.allow], deny: [...t.deny] };
  }

  /** Evaluate a tool invocation. `workspace` is the task's writable root. */
  evaluateToolUse(opts: { level: Level; toolName: string; input: Record<string, unknown>; workspace?: string }): GateDecision {
    const { level, toolName, input } = opts;
    const t = this.cfg.tools;
    const command = typeof input.command === "string" ? input.command : "";
    const filePath = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : "";

    // 1. Hard denies
    if (t.always_deny.tools.some((p) => toolMatches(p, toolName))) return { action: "deny", reason: `tool ${toolName} is always denied` };
    if (toolName === "Bash" && command) {
      const hit = matchesAny(t.always_deny.bash_patterns, command);
      if (hit) return { action: "deny", reason: `command matches always_deny pattern ${hit}` };
    }

    // 2. Level allow/deny lists
    const lists = this.toolsForLevel(level);
    if (lists.deny.some((p) => toolMatches(p, toolName))) return { action: "deny", reason: `tool ${toolName} not permitted at L${level}` };
    const allowed = lists.allow.length === 0 || lists.allow.some((p) => toolMatches(p, toolName));
    if (!allowed) return { action: "deny", reason: `tool ${toolName} not in L${level} allow list` };

    // 3. Hard lines requiring approval
    if (t.always_approve.tools.some((p) => toolMatches(p, toolName))) {
      return { action: "approve", reason: `tool ${toolName} always requires approval`, risk: this.riskOf(toolName + " " + JSON.stringify(input)) };
    }
    if (toolName === "Bash" && command) {
      const pre = level >= 5 ? matchesAny(t.level5_preauthorized.bash_patterns, command) : null;
      const hit = matchesAny(t.always_approve.bash_patterns, command);
      if (hit && !pre) return { action: "approve", reason: `command matches approval pattern ${hit}`, risk: this.riskOf(command) };
    }

    // 4. Writes outside the workspace
    if (opts.workspace && filePath && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) {
      const abs = filePath.startsWith("/") ? filePath : `${opts.workspace}/${filePath}`;
      const inside = abs === opts.workspace || abs.startsWith(opts.workspace.replace(/\/$/, "") + "/");
      if (!inside) {
        const mode = t.always_approve.paths_outside_workspace;
        if (mode === "deny") return { action: "deny", reason: `write outside workspace: ${abs}` };
        if (mode === "approve") return { action: "approve", reason: `write outside workspace: ${abs}`, risk: "medium" };
      }
    }

    return { action: "allow", reason: "permitted by policy" };
  }

  riskOf(text: string): Risk {
    if (matchesAny(this.cfg.risk.high_patterns, text)) return "high";
    if (matchesAny(this.cfg.risk.medium_patterns, text)) return "medium";
    return "low";
  }
}
