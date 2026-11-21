import { agree, decisionsOf, merge, type Uncertain, type VoteContext } from "./consensus.js";
import type { CurateDeps } from "./curate.js";
import type { CheckResult, Plan } from "./output.js";

/**
 * How one item's decisions are reached. Consensus off: one run. On: two
 * primary runs in parallel; if their decisions agree, run 1 is used; if not,
 * one tiebreak run and a majority per decision (consensus.ts). A decision
 * with no majority is dropped (never queued) and returned as uncertain.
 */

export type ConsultLabel = "single" | "agreed" | "tiebreak" | "uncertain";

export type Asked = CheckResult & { readonly tokens: number };
export type Ask = (deps: CurateDeps, note?: string) => Promise<Asked>;

export type Consulted = {
  readonly result: CheckResult;
  readonly label: ConsultLabel;
  readonly uncertain: readonly Uncertain[];
  readonly tokens: number;
};

const plans = (runs: readonly Asked[]): Plan[] => runs.flatMap((r) => (r.ok ? [r.plan] : []));

export async function consult(deps: CurateDeps, ask: Ask, ctx?: VoteContext): Promise<Consulted> {
  if (!deps.consensus) {
    const one = await ask(deps);
    return { result: one, label: "single", uncertain: [], tokens: one.tokens };
  }
  const [a, b] = await Promise.all([ask(deps), ask(deps)]);
  let tokens = a.tokens + b.tokens;
  if (a.ok && b.ok && agree(decisionsOf(a.plan, ctx), decisionsOf(b.plan, ctx))) {
    return { result: a, label: "agreed", uncertain: [], tokens };
  }
  const c = await ask({ ...deps, model: deps.consensus.tiebreak, modelName: deps.consensus.tiebreakName });
  tokens += c.tokens;
  const ok = plans([a, b, c]);
  if (ok.length === 0) return { result: a, label: "tiebreak", uncertain: [], tokens };
  if (ok.length === 1) return { result: { ok: true, plan: ok[0]! }, label: "tiebreak", uncertain: [], tokens };
  const merged = merge(ok, ctx);
  return {
    result: { ok: true, plan: merged.plan },
    label: merged.uncertain.length > 0 ? "uncertain" : "tiebreak",
    uncertain: merged.uncertain,
    tokens,
  };
}
