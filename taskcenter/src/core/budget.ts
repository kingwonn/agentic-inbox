import type { Repo } from "./repo.js";
import { dayKey } from "./time.js";

export interface BudgetStatus {
  day: string;
  spentUsd: number;
  limitUsd: number;
  ratio: number; // 0..∞
  warn: boolean; // >= 80%
  exhausted: boolean; // >= 100%
  runs: number;
}

/** Daily budget accounting (80% warn / 100% hard stop, like Paperclip). */
export class Budget {
  constructor(
    private repo: Repo,
    private limitUsd: number,
    private timeZone?: string,
  ) {}

  status(now = new Date()): BudgetStatus {
    const day = dayKey(now, this.timeZone);
    const b = this.repo.budgets.get(day);
    const ratio = this.limitUsd > 0 ? b.cost_usd / this.limitUsd : 0;
    return {
      day,
      spentUsd: b.cost_usd,
      limitUsd: this.limitUsd,
      ratio,
      warn: this.limitUsd > 0 && ratio >= 0.8,
      exhausted: this.limitUsd > 0 && ratio >= 1,
      runs: b.runs,
    };
  }

  record(usd: number, now = new Date()): BudgetStatus {
    this.repo.budgets.add(dayKey(now, this.timeZone), usd, 1);
    return this.status(now);
  }

  /** Add cost that is not a run (triage, planning, digest). Does not bump the run counter. */
  addCost(usd: number, now = new Date()): BudgetStatus {
    if (usd > 0) this.repo.budgets.add(dayKey(now, this.timeZone), usd, 0);
    return this.status(now);
  }

  canSpend(estimateUsd = 0, now = new Date()): boolean {
    const s = this.status(now);
    if (this.limitUsd <= 0) return true;
    return s.spentUsd + estimateUsd <= this.limitUsd;
  }
}
