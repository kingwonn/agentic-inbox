import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function base36(n: number, width: number): string {
  let s = n.toString(36);
  while (s.length < width) s = "0" + s;
  return s;
}

/**
 * Sortable id: <prefix>_<time base36 (9 chars)><random base36 (8 chars)>.
 * Time-ordered within a millisecond granularity; random tail avoids collisions.
 */
export function newId(prefix: string): string {
  const t = base36(Date.now(), 9);
  const bytes = randomBytes(8);
  let r = "";
  for (let i = 0; i < 8; i++) r += ALPHABET[bytes[i] % 36];
  return `${prefix}_${t}${r}`;
}

export const ID_PREFIX = {
  signal: "sig",
  inbox: "inb",
  task: "tsk",
  run: "run",
  event: "evt",
  approval: "apr",
  artifact: "art",
  notification: "ntf",
  memory: "mem",
} as const;
