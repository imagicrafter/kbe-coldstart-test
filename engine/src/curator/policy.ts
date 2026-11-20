import type { EntitySchema } from "../entities/templates.js";
import type { Candidate, PlannedNewPage, PlannedUpdate } from "./output.js";

/**
 * Small changes apply on their own; large ones wait for the owner's yes.
 *
 * Waits for a yes:
 *   * a field the drawer lists under update_rules.needs_yes (a stage change,
 *     a deal value), or any field it does not list under `auto`
 *   * a new page in a drawer whose template says `curator: {new_page: needs_yes}`
 *     (deals, offers, programs, properties)
 *   * a large text change (more than LARGE_CHANGE_CHARS added)
 *   * anything from an item a person released after the steering screen
 *     held it
 * A change that waits is queued whole: nothing of it is applied until the
 * owner says yes.
 */

export const LARGE_CHANGE_CHARS = 3000;

export type Verdict = { readonly apply: true } | { readonly apply: false; readonly reasons: readonly string[] };

function addedChars(u: PlannedUpdate): number {
  return u.patches.reduce((n, p) => {
    switch (p.op) {
      case "append-bullet":
      case "append-paragraph":
        return n + p.text.length;
      case "replace-line":
        return n + p.new.length;
      case "new-section-after":
        return n + p.heading.length + (p.text ?? "").length;
    }
  }, 0);
}

function verdict(reasons: readonly string[]): Verdict {
  return reasons.length === 0 ? { apply: true } : { apply: false, reasons };
}

export function judgeUpdate(
  u: PlannedUpdate,
  page: Candidate,
  schema: EntitySchema,
  released: boolean,
): Verdict {
  const drawer = schema.drawers.find((d) => d.id === page.drawer);
  const auto = new Set(drawer?.update_rules.auto ?? []);
  const needsYes = new Set(drawer?.update_rules.needs_yes ?? []);
  const changed = Object.entries(u.fields).filter(([n, v]) => page.fields[n] !== v).map(([n]) => n);
  const fieldReasons = changed
    .filter((n) => needsYes.has(n) || !auto.has(n))
    .map((n) => (needsYes.has(n) ? `${n} change needs a yes` : `${n} is not an automatic field`));
  return verdict([
    ...fieldReasons,
    ...(addedChars(u) > LARGE_CHANGE_CHARS ? ["large change"] : []),
    ...(released ? ["item was held by the steering screen"] : []),
  ]);
}

export function judgeNewPage(n: PlannedNewPage, schema: EntitySchema, released: boolean): Verdict {
  const drawer = schema.drawers.find((d) => d.id === n.drawer);
  return verdict([
    ...(drawer?.curator?.new_page === "needs_yes" ? [`new page in ${n.drawer}`] : []),
    ...(released ? ["item was held by the steering screen"] : []),
  ]);
}
