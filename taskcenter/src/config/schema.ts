import { z } from "zod";

const Bool = z.boolean().default(false);
/** String that tolerates null (empty ${VAR:-} substitutions parse as null in YAML). */
const Str = z.preprocess((v) => (v === null || v === undefined ? "" : v), z.string()).default("");
/** Array of strings; null/empty entries are dropped. */
const StrList = z
  .array(z.string().nullable())
  .default([])
  .transform((a) => a.filter((x): x is string => typeof x === "string" && x.length > 0));

export const SensorGithubSchema = z.object({
  enabled: Bool,
  token: Str,
  use_gh_cli: z.boolean().default(true),
  user: Str,
  repos: StrList,
  include_notifications: z.boolean().default(true),
  include_searches: z.boolean().default(true),
});

export const SensorImapSchema = z.object({
  enabled: Bool,
  host: z.string().default("imap.gmail.com"),
  port: z.coerce.number().default(993),
  user: Str,
  password: Str,
  mailbox: z.string().default("INBOX"),
  since_days: z.coerce.number().default(7),
  max_messages: z.coerce.number().default(50),
});

export const SensorIcsSchema = z.object({
  enabled: Bool,
  urls: StrList,
  horizon_days: z.coerce.number().default(7),
});

export const SensorLocalGitSchema = z.object({
  enabled: Bool,
  repos: StrList,
  stale_days: z.coerce.number().default(30),
});

export const SensorFsDocsSchema = z.object({
  enabled: Bool,
  paths: StrList,
  extensions: z.array(z.string()).default(["md", "txt"]),
  max_file_kb: z.coerce.number().default(512),
});

export const ChannelTelegramSchema = z.object({
  enabled: Bool,
  bot_token: Str,
  chat_id: Str,
  allowed_user_ids: z.array(z.coerce.string()).default([]),
  poll: z.boolean().default(true),
});

export const ChannelNtfySchema = z.object({
  enabled: Bool,
  server: z.string().default("https://ntfy.sh"),
  topic: Str,
  token: Str,
});

export const ChannelEmailSchema = z.object({
  enabled: Bool,
  smtp_host: Str,
  smtp_port: z.coerce.number().default(587),
  smtp_user: Str,
  smtp_password: Str,
  from: Str,
  to: Str,
});

export const ConfigSchema = z.object({
  data_dir: z.string().default("./data"),
  timezone: z.string().default("UTC"),
  locale: z.string().default("zh-CN"),
  profile_path: z.string().default("./config/profile.yaml"),
  policy_path: z.string().default("./config/policy.yaml"),
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.coerce.number().default(4800),
      token: Str,
      public_url: Str,
    })
    .prefault({}),
  brain: z
    .object({
      provider: z.enum(["claude-sdk", "claude-cli", "anthropic-api", "dry"]).default("claude-sdk"),
      models: z
        .object({
          classify: z.string().default("haiku"),
          plan: z.string().default("sonnet"),
          execute: z.string().default("sonnet"),
          heavy: z.string().default("opus"),
        })
        .prefault({}),
      max_turns: z.coerce.number().default(40),
      timeout_seconds: z.coerce.number().default(1800),
      budget_usd_per_run: z.coerce.number().default(2),
      daily_budget_usd: z.coerce.number().default(20),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
    })
    .prefault({}),
  executor: z
    .object({
      concurrency: z.coerce.number().default(2),
      max_attempts: z.coerce.number().default(3),
      backoff_seconds: z.array(z.coerce.number()).default([60, 300, 900]),
      workspace_root: z.string().default("./data/workspaces"),
      repo_root: z.string().default(".."),
    })
    .prefault({}),
  patrol: z
    .object({ interval_minutes: z.coerce.number().default(15), triage_batch_size: z.coerce.number().default(20) })
    .prefault({}),
  approval: z.object({ wait_seconds: z.coerce.number().default(600), expire_hours: z.coerce.number().default(72) }).prefault({}),
  sensors: z
    .object({
      github: SensorGithubSchema.prefault({}),
      imap: SensorImapSchema.prefault({}),
      ics: SensorIcsSchema.prefault({}),
      localgit: SensorLocalGitSchema.prefault({}),
      fsdocs: SensorFsDocsSchema.prefault({}),
      manual: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    })
    .prefault({}),
  notifications: z
    .object({
      channels: z
        .object({
          console: z.object({ enabled: z.boolean().default(true) }).prefault({}),
          telegram: ChannelTelegramSchema.prefault({}),
          ntfy: ChannelNtfySchema.prefault({}),
          email: ChannelEmailSchema.prefault({}),
          webhook: z.object({ enabled: Bool, url: Str }).prefault({}),
        })
        .prefault({}),
      digest: z.object({ enabled: z.boolean().default(true), cron: z.string().default("30 8 * * *") }).prefault({}),
      notify_on: z
        .array(z.string())
        .default(["approval_requested", "task_done", "task_failed", "review_ready", "digest", "budget_warning"]),
    })
    .prefault({}),
  schedules: z
    .object({
      patrol: z.string().default("*/15 * * * *"),
      context_refresh: z.string().default("15 7 * * *"),
      maintenance: z.string().default("45 3 * * *"),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type SensorGithubConfig = z.infer<typeof SensorGithubSchema>;
export type SensorImapConfig = z.infer<typeof SensorImapSchema>;
export type SensorIcsConfig = z.infer<typeof SensorIcsSchema>;
export type SensorLocalGitConfig = z.infer<typeof SensorLocalGitSchema>;
export type SensorFsDocsConfig = z.infer<typeof SensorFsDocsSchema>;
export type ChannelTelegramConfig = z.infer<typeof ChannelTelegramSchema>;
export type ChannelNtfyConfig = z.infer<typeof ChannelNtfySchema>;
export type ChannelEmailConfig = z.infer<typeof ChannelEmailSchema>;
