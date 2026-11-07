/**
 * Single-instance lock for the daemon: data/taskcenter.lock holds {pid, startedAt, host}.
 * A lock whose pid is no longer alive is stale and gets replaced.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

export interface LockInfo {
  pid: number;
  startedAt: string;
  host: string;
  alive: boolean;
}

export class LockHeldError extends Error {
  constructor(readonly info: LockInfo) {
    super(`another task center daemon is running (pid ${info.pid}, started ${info.startedAt})`);
    this.name = "LockHeldError";
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(path: string): LockInfo | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
    const pid = Number(raw.pid);
    return { pid, startedAt: String(raw.startedAt ?? ""), host: String(raw.host ?? ""), alive: pidAlive(pid) };
  } catch {
    return { pid: 0, startedAt: "", host: "", alive: false };
  }
}

export function acquireLock(path: string): { info: LockInfo; release(): void } {
  const existing = readLock(path);
  if (existing?.alive && existing.pid !== process.pid) throw new LockHeldError(existing);
  if (existing && !existing.alive) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
  }
  const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString(), host: hostname(), alive: true };
  writeFileSync(path, JSON.stringify(info), { flag: "w" });
  let released = false;
  return {
    info,
    release() {
      if (released) return;
      released = true;
      const cur = readLock(path);
      if (cur && cur.pid === process.pid) {
        try {
          rmSync(path, { force: true });
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/** Remove a stale lock (dead pid). Returns true when something was cleaned. */
export function cleanStaleLock(path: string): boolean {
  const cur = readLock(path);
  if (cur && !cur.alive) {
    try {
      rmSync(path, { force: true });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
