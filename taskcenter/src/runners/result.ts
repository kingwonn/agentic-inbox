/**
 * AgentOutput contract helpers: the JSON schema the agent must satisfy, a
 * lenient parser, and extraction from free text.
 */
import { z } from "zod";
import { ARTIFACT_TYPES, type AgentOutput } from "../core/types.js";
import { extractLastJsonObject } from "../brain/providers/util.js";

export const AGENT_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    summary: { type: "string", description: "What was done and the outcome" },
    status: { type: "string", enum: ["done", "partial", "blocked", "needs_human"] },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...ARTIFACT_TYPES] },
          title: { type: "string" },
          path: { type: "string" },
          url: { type: "string" },
          content: { type: "string" },
        },
        required: ["type", "title"],
      },
    },
    verification: {
      type: "object",
      properties: {
        passed: { type: "boolean" },
        details: { type: "string", description: "What was actually checked (commands, outputs)" },
      },
      required: ["passed", "details"],
    },
    follow_ups: { type: "array", items: { type: "string" } },
    needs_human: {
      anyOf: [
        {
          type: "object",
          properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
          required: ["question"],
        },
        { type: "null" },
      ],
    },
    learned: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "status", "verification"],
};

const ArtifactSchema = z
  .object({
    type: z.enum(ARTIFACT_TYPES).catch("text"),
    title: z.string().default("artifact"),
    path: z.string().optional(),
    url: z.string().optional(),
    content: z.string().optional(),
  })
  .passthrough();

export const AgentOutputSchema = z
  .object({
    summary: z.string().default(""),
    status: z.enum(["done", "partial", "blocked", "needs_human"]).catch("partial"),
    artifacts: z.array(ArtifactSchema.catch({ type: "text", title: "artifact" })).default([]),
    verification: z
      .object({ passed: z.boolean().catch(false), details: z.string().catch("") })
      .catch({ passed: false, details: "" }),
    follow_ups: z.array(z.string()).catch([]),
    needs_human: z.object({ question: z.string(), options: z.array(z.string()).optional() }).nullable().catch(null),
    learned: z.array(z.string()).optional().catch(undefined),
  })
  .passthrough();

/** Parse any object into an AgentOutput with lenient defaults; undefined when not an object. */
export function parseAgentOutput(x: unknown): AgentOutput | undefined {
  if (!x || typeof x !== "object" || Array.isArray(x)) return undefined;
  const o = x as Record<string, unknown>;
  // Must look at least vaguely like an agent output.
  if (o.summary === undefined && o.status === undefined && o.verification === undefined && o.artifacts === undefined) return undefined;
  const r = AgentOutputSchema.safeParse(x);
  if (!r.success) return undefined;
  const d = r.data;
  const out: AgentOutput = {
    summary: d.summary || (typeof o.result === "string" ? o.result : ""),
    status: d.status,
    artifacts: d.artifacts.map((a) => ({ type: a.type, title: a.title, path: a.path, url: a.url, content: a.content })),
    verification: { passed: !!d.verification.passed, details: d.verification.details ?? "" },
    follow_ups: d.follow_ups,
    needs_human: d.needs_human ?? null,
  };
  if (d.learned?.length) out.learned = d.learned;
  if (out.status === "needs_human" && !out.needs_human) out.needs_human = { question: out.summary || "Human input required" };
  return out;
}

/** Find the agent output in free text: last ```json block or last {...} object. */
export function extractAgentOutputFromText(text: string): AgentOutput | undefined {
  if (!text) return undefined;
  const obj = extractLastJsonObject(text);
  const parsed = parseAgentOutput(obj);
  if (parsed) return parsed;
  // Some models wrap: {"output": {...}} / {"result": {...}}
  if (obj && typeof obj === "object") {
    for (const k of ["output", "result", "agent_output", "structured_output"]) {
      const inner = (obj as Record<string, unknown>)[k];
      const p = parseAgentOutput(inner);
      if (p) return p;
    }
  }
  return undefined;
}
