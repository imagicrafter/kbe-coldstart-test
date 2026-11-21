import type { EntitySchema } from "../entities/templates.js";
import { alreadyHas, newPage, sourceRef, updatedPage, type Generated } from "./apply.js";
import { inline, screen } from "./guard.js";
import { itemKeys, sourceKeyRules } from "./keys.js";
import type { ModelBackend } from "./model.js";
import { checkReply, type CheckResult, type PlannedNewPage, type PlannedUpdate } from "./output.js";
import { judgeNewPage, judgeUpdate } from "./policy.js";
import { dropRepeats } from "./dedupe.js";
import { consult, type ConsultLabel } from "./consult.js";
import { logger } from "../log/logger.js";
import { missingRequired, requiredNote } from "./required.js";
import { SYSTEM_PROMPT, buildPrompt } from "./prompt.js";
import { StoreError, type ClaimedItem, type PageRow, type Store } from "./store.js";

/**
 * One item through the curator: screen, match, ask, check, apply or queue,
 * close. Every write goes through the 0053 functions, which hold the item to
 * its owner's pages and its own topics whatever happens here.
 */

export type CurateDeps = {
  readonly store: Store;
  readonly model: ModelBackend;
  readonly modelName: string;
  readonly schema: EntitySchema;
  readonly now: () => Date;
  /** Consensus curation: present when on (curator_settings.consensus). */
  readonly consensus?: { readonly tiebreak: ModelBackend; readonly tiebreakName: string };
};

export type ItemOutcome = "flagged" | "applied" | "queued" | "mixed" | "no_change" | "failed";

export type ItemResult = {
  readonly outcome: ItemOutcome;
  readonly pages: readonly string[];
  readonly queued: number;
  readonly reason?: string;
  /** single (consensus off), agreed, tiebreak or uncertain. */
  readonly consensus?: ConsultLabel;
  /** Model tokens (input + output) spent on this item. */
  readonly tokens?: number;
};

const SHORTLIST_SIZE = 8;

function outcomeOf(applied: number, queued: number): ItemOutcome {
  if (applied > 0 && queued > 0) return "mixed";
  if (applied > 0) return "applied";
  if (queued > 0) return "queued";
  return "no_change";
}

function searchText(item: ClaimedItem): string {
  return inline(item.title ?? "", 200).replace(/[^\p{L}\p{N}\s.@-]/gu, " ");
}

type Step = { readonly applied: readonly string[]; readonly queued: number };

async function handleUpdate(item: ClaimedItem, u: PlannedUpdate, page: PageRow, deps: CurateDeps, gen: Generated): Promise<Step> {
  const ref = sourceRef(item);
  const verdict = judgeUpdate(u, page, deps.schema, item.released);
  if (verdict.apply) {
    const saved = await deps.store.savePage(item.id, updatedPage(page, u, ref, gen), page.content_hash);
    return { applied: [saved.id], queued: 0 };
  }
  await deps.store.queueReview({
    itemId: item.id,
    pageId: page.id,
    pageKey: page.key,
    kind: "update",
    reasons: verdict.reasons,
    proposal: { ref, generated: gen, update: { key: u.key, patches: u.patches, fields: u.fields, related: u.related } },
    baseHash: page.content_hash,
  });
  return { applied: [], queued: 1 };
}

async function handleNewPage(item: ClaimedItem, n: PlannedNewPage, deps: CurateDeps, gen: Generated): Promise<Step> {
  const drawer = deps.schema.drawers.find((d) => d.id === n.drawer);
  const page = newPage(n, drawer?.sections ?? [], item.topics, sourceRef(item), gen);
  const verdict = judgeNewPage(n, deps.schema, item.released);
  if (verdict.apply) {
    try {
      const saved = await deps.store.savePage(item.id, page, null);
      return { applied: [saved.id], queued: 0 };
    } catch (err) {
      // The owner already has a page on this key outside the item's topics:
      // a person decides.
      if (!(err instanceof StoreError) || err.code !== "22023") throw err;
      await deps.store.queueReview({
        itemId: item.id, pageId: null, pageKey: n.key, kind: "new_page",
        reasons: [`could not create: ${err.message}`], proposal: { ref: sourceRef(item), page }, baseHash: null,
      });
      return { applied: [], queued: 1 };
    }
  }
  await deps.store.queueReview({
    itemId: item.id, pageId: null, pageKey: n.key, kind: "new_page",
    reasons: verdict.reasons, proposal: { ref: sourceRef(item), page }, baseHash: null,
  });
  return { applied: [], queued: 1 };
}

async function ask(item: ClaimedItem, shortlist: readonly PageRow[], deps: CurateDeps, note = "") {
  const prompt = buildPrompt(item, shortlist, deps.schema);
  const reply = await deps.model.complete(SYSTEM_PROMPT, note ? `${prompt}\n\n${note}` : prompt);
  const tokens = (reply.inputTokens ?? 0) + (reply.outputTokens ?? 0);
  if (reply.finish === "length") return { ok: false as const, reason: "the model reply was cut off", tokens };
  const result = checkReply(reply.text, { shortlist, schema: deps.schema, sourceText: `${item.title ?? ""}\n${item.body}` });
  return { ...result, tokens };
}

async function fail(item: ClaimedItem, deps: CurateDeps, reason: string, pages: readonly string[] = []): Promise<ItemResult> {
  await deps.store.done(item.id, "failed", pages, reason);
  return { outcome: "failed", pages, queued: 0, reason };
}

export async function curateItem(item: ClaimedItem, deps: CurateDeps): Promise<ItemResult> {
  if (!item.released) {
    const held = screen(item.title, item.body);
    if (held.flagged) {
      await deps.store.flag(item.id, held.reason);
      return { outcome: "flagged", pages: [], queued: 0, reason: held.reason };
    }
  }

  const drawers = new Set(deps.schema.drawers.map((d) => d.id));
  const found = await deps.store.candidates(item.id, itemKeys(item, sourceKeyRules(deps.schema.drawers)), searchText(item), SHORTLIST_SIZE);
  // A page that already lists this item was written by an earlier, cut-short
  // run: it counts as touched and is not offered again.
  const done = found.filter((p) => alreadyHas(p, item.id)).map((p) => p.id);
  const shortlist = found.filter((p) => !alreadyHas(p, item.id) && drawers.has(p.drawer));

  const safeAsk = (d: CurateDeps, note = "") =>
    ask(item, shortlist, d, note).catch((err: unknown) => ({
      ok: false as const, reason: err instanceof Error ? err.message : "model call failed", tokens: 0,
    }));
  const consulted = await consult(deps, safeAsk);
  let tokens = consulted.tokens;
  let checked: CheckResult = consulted.result;
  if (!checked.ok) return fail(item, deps, checked.reason, done);
  for (const u of consulted.uncertain) await deps.store.uncertain(item.id, u.decision, u.proposals);

  // A template pattern says this item must reach a drawer (e.g. a deal): ask
  // once more with an explicit note; if still missing, apply the rest and
  // record a failed check.
  const text = `${item.title ?? ""}\n${item.body}`;
  let missing = missingRequired(text, checked.plan, deps.schema, shortlist);
  if (missing.length > 0) {
    // On the one retry, keep what the merged result had and add the pages it missed.
    const again = await safeAsk(deps, requiredNote(missing, deps.schema));
    tokens += again.tokens;
    if (again.ok && checked.ok) {
      const before = checked.plan;
      const extra = again.plan.newPages.filter((n) => missing.includes(n.drawer) && !before.newPages.some((b) => b.key === n.key));
      const extraUpdates = again.plan.updates.filter((u) =>
        shortlist.some((p) => p.key === u.key && missing.includes(p.drawer)) && !before.updates.some((b) => b.key === u.key));
      checked = { ok: true, plan: { ...before, newPages: [...before.newPages, ...extra], updates: [...before.updates, ...extraUpdates] } };
      missing = missingRequired(text, checked.plan, deps.schema, shortlist);
    }
  }
  logger.info({ item: item.id, consensus: consulted.label, uncertain: consulted.uncertain.length, tokens }, "curator: item decided");
  const plan = dropRepeats(checked.plan, shortlist);
  const checkFailed = missing.length > 0
    ? `check failed: the item matches the ${missing.map((id) => deps.schema.drawers.find((d) => d.id === id)?.label ?? id).join(", ")} signal but no page there was made or updated`
    : null;

  const gen: Generated = { by: "curator", model: deps.modelName, at: deps.now().toISOString() };
  const steps: Step[] = [];
  try {
    for (const u of plan.updates) {
      const page = shortlist.find((p) => p.key === u.key);
      const empty = u.patches.length === 0 && Object.keys(u.fields).length === 0 && u.related.length === 0;
      if (page && !empty) steps.push(await handleUpdate(item, u, page, deps, gen));
    }
    for (const n of plan.newPages) steps.push(await handleNewPage(item, n, deps, gen));
  } catch (err) {
    const written = [...done, ...steps.flatMap((s) => s.applied)];
    return fail(item, deps, err instanceof Error ? err.message : "save failed", written);
  }

  const pages = [...done, ...steps.flatMap((s) => s.applied)];
  const queued = steps.reduce((n, s) => n + s.queued, 0);
  const how = { consensus: consulted.label, tokens };
  if (checkFailed) return { ...(await fail(item, deps, checkFailed, pages)), ...how };
  const outcome = outcomeOf(pages.length, queued);
  await deps.store.done(item.id, outcome, pages);
  return { outcome, pages, queued, ...how };
}
