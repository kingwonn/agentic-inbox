/**
 * Screenshot the dashboard with demo data.
 *
 *   node --no-warnings=ExperimentalWarning --import tsx scripts/screenshot-dashboard.ts [--out docs/screenshots] [--keep]
 *
 * Starts the HTTP server on a free port with an in-memory, seeded AppContext
 * (src/server/seed.ts), serves web/dist, and captures every main view at
 * 1280×800 (desktop) and 390×844 (iPhone) with Playwright's bundled Chromium.
 * `--keep` leaves the server running (prints the URL) for manual inspection.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createServer } from "../src/server/app.js";
import { createMemoryContext, seedDemo, taskcenterRoot } from "../src/server/seed.js";

const require = createRequire(import.meta.url);
// Playwright may be installed globally (NODE_PATH); fall back to a global require.
let pw: typeof import("playwright");
try {
  pw = require("playwright");
} catch {
  pw = require(resolve(process.env.NODE_PATH ?? "/usr/local/lib/node_modules", "playwright"));
}

const args = process.argv.slice(2);
const outArg = args.includes("--out") ? args[args.indexOf("--out") + 1] : "docs/screenshots";
const keep = args.includes("--keep");
const root = taskcenterRoot();
const outDir = resolve(root, outArg);
mkdirSync(outDir, { recursive: true });

const ctx = createMemoryContext({ rootDir: root, config: { server: { host: "127.0.0.1", port: 0 }, data_dir: "./data" } });
const seeded = seedDemo(ctx.repo, ctx.bus);
const server = createServer(ctx);
const { port } = await server.start();
const base = `http://127.0.0.1:${port}`;
console.log(`server: ${base}`);

const running = seeded.tasks.find((t) => t.status === "running")!;
const failedRun = seeded.runs.find((r) => r.status === "failed")!;
const views: Array<{ name: string; hash: string; settle?: number }> = [
  { name: "overview", hash: "#/" },
  { name: "inbox", hash: "#/inbox" },
  { name: "inbox-detail", hash: `#/inbox/${seeded.inbox[1].id}` },
  { name: "outbox", hash: "#/outbox" },
  { name: "tasks-board", hash: "#/tasks" },
  { name: "task-detail", hash: `#/tasks/${running.id}` },
  { name: "runs", hash: "#/runs" },
  { name: "run-detail", hash: `#/runs/${failedRun.id}` },
  { name: "events", hash: "#/events" },
  { name: "artifacts", hash: `#/artifacts/${seeded.artifacts[0].id}` },
  { name: "memory", hash: "#/memory" },
  { name: "status", hash: "#/status" },
];
const viewports = [
  { w: 1280, h: 800, suffix: "1280x800", mobile: false },
  { w: 390, h: 844, suffix: "390x844", mobile: true },
];

if (keep) {
  console.log(`--keep: open ${base}/ (Ctrl-C to stop)`);
} else {
  const browser = await pw.chromium.launch();
  try {
    for (const vp of viewports) {
      const context = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        deviceScaleFactor: vp.mobile ? 2 : 1,
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
        locale: "zh-CN",
        colorScheme: "light",
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => console.error(`[pageerror ${vp.suffix}]`, e.message));
      page.on("console", (m) => {
        if (m.type() === "error") console.error(`[console ${vp.suffix}]`, m.text());
      });
      for (const v of views) {
        await page.goto(`${base}/${v.hash}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(v.settle ?? 350);
        const file = resolve(outDir, `${v.name}-${vp.suffix}.png`);
        await page.screenshot({ path: file, fullPage: false });
        console.log(`wrote ${file}`);
      }
      await context.close();
    }
    // One dark-mode desktop shot of the overview.
    const dark = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark", locale: "zh-CN" });
    const dpage = await dark.newPage();
    await dpage.goto(`${base}/#/`, { waitUntil: "networkidle" });
    await dpage.waitForTimeout(350);
    await dpage.screenshot({ path: resolve(outDir, "overview-dark-1280x800.png") });
    console.log(`wrote ${resolve(outDir, "overview-dark-1280x800.png")}`);
    await dark.close();
  } finally {
    await browser.close();
  }
  await server.stop();
  await ctx.shutdown();
}
