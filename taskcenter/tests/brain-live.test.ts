/**
 * Live classifier check against `claude -p` (haiku). Skipped unless TC_LIVE=1.
 *   TC_LIVE=1 npx vitest run tests/brain-live.test.ts
 */
import { describe, expect, it } from "vitest";
import { triageSignals } from "../src/brain/classifier.js";
import { loadContext } from "../src/brain/context.js";
import { createClaudeCliProvider } from "../src/brain/providers/claude-cli.js";
import { cfg, loaded, mem, policy, sig } from "./brain-helpers.js";

const live = process.env.TC_LIVE === "1";

describe.skipIf(!live)("classifier (live, haiku)", () => {
  it("triages 3 synthetic signals", { timeout: 240_000 }, async () => {
    const { repo, logger } = mem();
    const llm = createClaudeCliProvider();
    const config = cfg({ locale: "zh-CN", brain: { models: { classify: "haiku" } } });
    const context = loadContext(loaded(config), repo);
    const signals = [
      sig({ id: "sig_live_pr", source: "github", kind: "pull_request", title: "PR #7: add IMAP sensor retry logic — review requested", body: "bob requested your review. 3 files changed. CI green.", actor: "bob", url: "https://github.com/kingwonn/agentic-inbox/pull/7", metadata: { repo: "kingwonn/agentic-inbox", number: 7 } }),
      sig({ id: "sig_live_news", source: "imap", kind: "email", title: "Your weekly Cloudflare newsletter", body: "Top stories this week. Unsubscribe here.", actor: "newsletter@cloudflare.com" }),
      sig({ id: "sig_live_inv", source: "imap", kind: "email", title: "Invoice #2024-11 overdue — please transfer by Friday", body: "Hi, the invoice for October consulting is overdue. Please wire 1200 USD by Friday.", actor: "billing@vendor.example" }),
    ];
    const { results, costUsd } = await triageSignals(signals, { llm, policy: policy(), config, context, logger, availableCapabilities: ["github_token"] });
    console.log("LIVE TRIAGE cost=$" + costUsd.toFixed(4));
    console.log(JSON.stringify(results, null, 2));
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.flatMap((r) => r.signal_ids).sort()).toEqual(signals.map((s) => s.id).sort());
    expect(costUsd).toBeGreaterThan(0);
    const inv = results.find((r) => r.signal_ids.includes("sig_live_inv"))!;
    expect(inv.level).toBeLessThanOrEqual(2); // finance override clamps
    for (const r of results) expect(r.level_proposed).toBeDefined();
  });
});
