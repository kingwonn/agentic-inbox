/**
 * Tiny argument parser (no dependencies).
 *   tc tasks create "Title" --level 3 --priority P1 --json
 * → { _: ["tasks", "create", "Title"], flags: { level: "3", priority: "P1", json: true } }
 * Rules: `--k=v`, `--k v` (when v does not start with "-"), `--flag` (boolean when
 * listed in BOOLEAN_FLAGS or when no value follows), `--no-k` → k=false, `-h`.
 */
export interface ParsedArgs {
  _: string[];
  flags: Record<string, string | boolean>;
}

export const BOOLEAN_FLAGS = new Set(["json", "dry", "once", "follow", "send", "serve", "probe", "help", "version", "all", "force", "quiet", "cloud", "wait", "verbose"]);

export function parseArgs(argv: string[], booleans: Set<string> = BOOLEAN_FLAGS): ParsedArgs {
  const out: ParsedArgs = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h") {
      out.flags.help = true;
      continue;
    }
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        out.flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (body.startsWith("no-")) {
        out.flags[body.slice(3)] = false;
        continue;
      }
      const next = argv[i + 1];
      if (booleans.has(body) || next === undefined || (next.startsWith("-") && next !== "-")) {
        out.flags[body] = true;
      } else {
        out.flags[body] = next;
        i++;
      }
      continue;
    }
    out._.push(a);
  }
  return out;
}

export function flagStr(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagNum(args: ParsedArgs, name: string): number | undefined {
  const v = flagStr(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

export const HELP = `tc — Task Center CLI

Usage: tc <command> [options]

Daemon
  daemon [--no-serve]             run patrol/triage/plan/execute loops (+ API & dashboard)
  serve                           API + dashboard only
  status                          counts, budget, daemon state, schedules
  doctor [--probe]                environment checks (--probe makes one haiku call)
  init                            create config/taskcenter.yaml, profile.yaml and .env from examples

Loops (one-shot)
  patrol [--once] [--sensor name] poll sensors (without --once: also triage afterwards)
  triage                          classify untriaged signals into the inbox
  plan [taskId]                   plan pending L3+ tasks (or one task)
  run <taskId>                    run a task now and stream its events
  digest [--send]                 build (and send) the daily digest
  context refresh                 consolidate learned memories into the profile

Inbox / tasks / approvals
  capture "<text>"                add a note to the inbox (manual signal)
  inbox list|show <id>|promote <id> [--level n --priority P1]|dismiss <id>|snooze <id> <1d|3d|7d>
  tasks list [--status s]|show <id>|create "<title>" [--level n --category c --priority p --description "..."]|retry <id>|cancel <id>
  approvals list|show <id>|approve <id> [note]|reject <id> [note]|respond <id> "<text>"
  events [--task id --run id --type t --limit n --follow]

State
  state export [dir] [--since days]   write JSONL per table (+manifest)
  state import <dir>                  upsert rows from an export
  demo                                seed demo data

Global flags: --config <path>  --json  --dry  --help
`;
