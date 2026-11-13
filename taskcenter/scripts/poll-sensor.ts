/**
 * Run one sensor against the real config + database and print the upserted signals.
 *   node --import tsx scripts/poll-sensor.ts github
 *   node --import tsx scripts/poll-sensor.ts localgit --json
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.js";
import { openDb } from "../src/core/db.js";
import { createLogger } from "../src/core/logger.js";
import { Repo } from "../src/core/repo.js";
import { createSensors, makeSensorContext } from "../src/sensors/registry.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
const asJson = args.includes("--json");
const force = args.includes("--force"); // run even when the config says disabled/unconfigured

if (!name) {
  console.error("usage: poll-sensor.ts <github|imap|ics|localgit|fsdocs|manual> [--json] [--force]");
  process.exit(2);
}

const loaded = loadConfig({ cwd: rootDir });
const { config } = loaded;
const logger = createLogger({ scope: "poll-sensor", level: (process.env.TC_LOG_LEVEL as "debug" | "info" | undefined) ?? "info" });
const dbPath = resolve(loaded.resolve(config.data_dir), "taskcenter.db");
const db = openDb(dbPath);
const repo = new Repo(db);

const entries = createSensors(config);
const entry = entries.find((e) => e.sensor.name === name);
if (!entry) {
  console.error(`unknown sensor ${name}; available: ${entries.map((e) => e.sensor.name).join(", ")}`);
  process.exit(2);
}
if (!entry.enabled && !force) {
  console.error(`sensor ${name} is disabled or not configured (use --force to run anyway)`);
  process.exit(1);
}

const ctx = makeSensorContext(entry, { repo, logger, loaded });
const started = Date.now();
try {
  const result = await entry.sensor.poll(ctx);
  const rows: Array<{ id: string; external_id: string; kind: string; title: string; status: string }> = [];
  for (const s of result.signals) {
    const r = repo.signals.upsert(s);
    rows.push({ id: r.signal.id, external_id: s.external_id, kind: s.kind, title: s.title, status: r.isNew ? "new" : r.changed ? "changed" : "unchanged" });
  }
  const out = {
    sensor: name,
    config: loaded.configPath,
    db: dbPath,
    durationMs: Date.now() - started,
    summary: result.summary ?? "",
    warnings: result.warnings ?? [],
    signals: rows,
    cursors: repo.cursors.all(name).map((c) => ({ key: c.key, value: c.value.length > 80 ? c.value.slice(0, 77) + "..." : c.value })),
  };
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`sensor=${name} db=${dbPath} (${out.durationMs}ms)`);
    console.log(`summary: ${out.summary}`);
    for (const w of out.warnings) console.log(`warning: ${w}`);
    console.log(`signals (${rows.length}):`);
    for (const r of rows) console.log(`  [${r.status.padEnd(9)}] ${r.kind.padEnd(18)} ${r.external_id}  —  ${r.title}`);
    console.log(`cursors:`);
    for (const c of out.cursors) console.log(`  ${c.key} = ${c.value}`);
  }
} catch (e) {
  console.error(`poll failed: ${(e as Error).stack ?? e}`);
  process.exitCode = 1;
} finally {
  db.close();
}
