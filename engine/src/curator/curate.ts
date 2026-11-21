import type { EntitySchema } from "../entities/templates.js";
import { alreadyHas, newPage, sourceRef, updatedPage, type Generated } from "./apply.js";
import { inline, screen } from "./guard.js";
import { itemKeys } from "./keys.js";
import type { ModelBackend } from "./model.js";
import { checkReply, type PlannedNewPage, type PlannedUpdate } from "./output.js";
import { judgeNewPage, judgeUpdate } from "./policy.js";
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
};

export type ItemOutcome = "flagged" | "applied" | "queued" | "mixed" | "no_change" | "failed";

export type ItemResult = {
  readonly outcome: ItemOutcome;
  readonly pages: readonly string[];
  readonly queued: number;
  readonly reason?: string;
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

async function ask(item: ClaimedItem, shortlist: readonly PageRow[], deps: CurateDeps) {
  const reply = await deps.model.complete(SYSTEM_PROMPT, buildPrompt(item, shortlist, deps.schema));
  if (reply.finish === "length") return { ok: false as const, reason: "the model reply was cut off" };
  return checkReply(reply.text, { shortlist, schema: deps.schema, sourceText: `${item.title ?? ""}\n${item.body}` });
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
  const found = await deps.store.candidates(item.id, itemKeys(item), searchText(item), SHORTLIST_SIZE);
  // A page that already lists this item was written by an earlier, cut-short
  // run: it counts as touched and is not offered again.
  const done = found.filter((p) => alreadyHas(p, item.id)).map((p) => p.id);
  const shortlist = found.filter((p) => !alreadyHas(p, item.id) && drawers.has(p.drawer));

  let checked;
  try {
    checked = await ask(item, shortlist, deps);
  } catch (err) {
    return fail(item, deps, err instanceof Error ? err.message : "model call failed", done);
  }
  if (!checked.ok) return fail(item, deps, checked.reason, done);

  const gen: Generated = { by: "curator", model: deps.modelName, at: deps.now().toISOString() };
  const steps: Step[] = [];
  try {
    for (const u of checked.plan.updates) {
      const page = shortlist.find((p) => p.key === u.key);
      if (page) steps.push(await handleUpdate(item, u, page, deps, gen));
    }
    for (const n of checked.plan.newPages) steps.push(await handleNewPage(item, n, deps, gen));
  } catch (err) {
    const written = [...done, ...steps.flatMap((s) => s.applied)];
    return fail(item, deps, err instanceof Error ? err.message : "save failed", written);
  }

  const pages = [...done, ...steps.flatMap((s) => s.applied)];
  const queued = steps.reduce((n, s) => n + s.queued, 0);
  const outcome = outcomeOf(pages.length, queued);
  await deps.store.done(item.id, outcome, pages);
  return { outcome, pages, queued };
}
