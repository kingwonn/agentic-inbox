/**
 * Shared helpers for LLM providers and runners: JSON extraction from free text,
 * a clean subprocess environment for nested `claude` processes, and a rough
 * token estimator used to keep prompts within budget.
 */

/** Environment for child `claude` processes: strips the nested-session markers. */
export function cleanClaudeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE" || k === "CLAUDE_CODE_CHILD_SESSION") continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}

/**
 * Find the first balanced JSON object or array in `text`. Handles fenced
 * ```json blocks, strings with braces, and leading prose. Returns the parsed
 * value or undefined.
 */
export function extractFirstJson(text: string): unknown {
  if (!text) return undefined;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) {
    const v = tryParse(fence[1].trim());
    if (v !== undefined) return v;
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "{" && c !== "[") continue;
    const end = balancedEnd(text, i);
    if (end > i) {
      const v = tryParse(text.slice(i, end + 1));
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/** Last balanced JSON object in text (used for agent final messages). */
export function extractLastJsonObject(text: string): unknown {
  if (!text) return undefined;
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const v = tryParse(fences[i][1].trim());
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  }
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== "}") continue;
    const start = balancedStart(text, i);
    if (start >= 0) {
      const v = tryParse(text.slice(start, i + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    }
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function balancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return c === close ? i : -1;
    }
  }
  return -1;
}

function balancedStart(text: string, end: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = end; i >= 0; i--) {
    const c = text[i];
    if (inStr) {
      if (c === '"' && text[i - 1] !== "\\") inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "}" || c === "]") depth++;
    else if (c === "{" || c === "[") {
      depth--;
      if (depth === 0) return c === "{" ? i : -1;
    }
  }
  return -1;
}

/** Rough token estimate: CJK ≈ 1 token/char, other text ≈ 1 token/4 chars. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) if (/[　-鿿豈-﫿]/.test(ch)) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** Truncate text to roughly `maxTokens` tokens, appending a marker. */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, Math.max(0, lo - 20)) + "\n…[truncated]";
}

export function truncateChars(text: string, max: number): string {
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max) + `…[+${text.length - max} chars]`;
}

/** Normalise a model alias/id for comparisons. */
export function modelAlias(model: string): "haiku" | "sonnet" | "opus" | "other" {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("opus")) return "opus";
  return "other";
}
