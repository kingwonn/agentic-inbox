#!/usr/bin/env node
// CLI launcher. Suppresses the node:sqlite ExperimentalWarning on Node 22 and
// loads the compiled CLI (dist) or, when running from source, the tsx loader.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning") return;
  console.error(w);
});
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "cli.js");
if (existsSync(dist)) {
  await import(dist);
} else {
  // Development: register tsx and run from source.
  const { register } = await import("tsx/esm/api");
  register();
  await import(join(here, "..", "src", "cli.ts"));
}
