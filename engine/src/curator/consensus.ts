import type { Plan, PlannedNewPage, PlannedUpdate } from "./output.js";

/**
 * Consensus curation. Runs are compared on their structured decisions only,
 * never on wording:
 *
 *   page:<drawer>:<key>   "create" or "patch" (an update names a shortlist key;
 *                         its drawer is not in the reply, so it is "?")
 *   field:<key>:<name>    the value, as JSON
 *
 * Two runs that agree on every decision: run 1 is used as it is. Otherwise,
 * with a third run, each decision goes to the value at least two runs share
 * (absent counts as a value: two runs leaving a page out drop it). A decision
 * with no majority is dropped and reported as uncertain. Patch text comes
 * from the first run on the winning side.
 */

export type Decisions = ReadonlyMap<string, string>;

const ABSENT = "(absent)";

const pageId = (drawer: string, key: string) => `page:${drawer}:${key}`;

export function decisionsOf(plan: Pick<Plan, "updates" | "newPages">): Map<string, string> {
  const out = new Map<string, string>();
  for (const u of plan.updates) {
    out.set(pageId("?", u.key), "patch");
    for (const [n, v] of Object.entries(u.fields)) out.set(`field:${u.key}:${n}`, JSON.stringify(v));
  }
  for (const n of plan.newPages) {
    out.set(pageId(n.drawer, n.key), "create");
    for (const [f, v] of Object.entries(n.fields)) out.set(`field:${n.key}:${f}`, JSON.stringify(v));
  }
  return out;
}

export function agree(a: Decisions, b: Decisions): boolean {
  return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
}

export type Uncertain = { readonly decision: string; readonly proposals: readonly string[] };
export type Merged = { readonly plan: Plan; readonly uncertain: readonly Uncertain[] };

function winner(values: readonly string[]): string | null {
  for (const v of values) if (values.filter((x) => x === v).length >= 2) return v;
  return null;
}

/** Merge two or three runs by majority per decision. */
export function merge(plans: readonly Plan[]): Merged {
  const ds = plans.map(decisionsOf);
  const keys = [...new Set(ds.flatMap((d) => [...d.keys()]))].sort();
  const won = new Map<string, string>();
  const uncertain: Uncertain[] = [];
  for (const k of keys) {
    const values = ds.map((d) => d.get(k) ?? ABSENT);
    const w = winner(values);
    if (w === null) uncertain.push({ decision: k, proposals: values });
    else if (w !== ABSENT) won.set(k, w);
  }
  const fieldsFor = (key: string, base: Record<string, string | number>) =>
    Object.fromEntries(
      Object.keys(base)
        .concat(plans.flatMap((p) => [...p.updates, ...p.newPages].filter((x) => x.key === key).flatMap((x) => Object.keys(x.fields))))
        .filter((n, i, all) => all.indexOf(n) === i && won.has(`field:${key}:${n}`))
        .map((n) => [n, JSON.parse(won.get(`field:${key}:${n}`) ?? "null") as string | number]),
    );
  const pick = <T extends PlannedUpdate | PlannedNewPage>(id: string, value: string, of: (p: Plan) => readonly T[], key: string): T | null => {
    const i = ds.findIndex((d) => d.get(id) === value);
    const src = i >= 0 ? of(plans[i]!).find((x) => x.key === key) : undefined;
    return src ? { ...src, fields: fieldsFor(key, src.fields) } : null;
  };
  const updates: PlannedUpdate[] = [];
  const newPages: PlannedNewPage[] = [];
  for (const [k, v] of won) {
    if (!k.startsWith("page:")) continue;
    const [, drawer, ...rest] = k.split(":");
    const key = rest.join(":");
    if (v === "patch") {
      const u = pick(k, v, (p) => p.updates, key);
      if (u) updates.push(u);
    } else if (drawer) {
      const n = pick(k, v, (p) => p.newPages, key);
      if (n) newPages.push(n);
    }
  }
  return { plan: { updates, newPages, notes: plans[0]?.notes ?? "" }, uncertain };
}
