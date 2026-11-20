import { entitySchema } from "../entities/templates.js";
import { logger } from "../log/logger.js";
import { alreadyHas, updatedPage, type Generated, type SourceRef } from "./apply.js";
import { curateItem, type CurateDeps } from "./curate.js";
import { extractJsonObject } from "./output.js";
import { doInference, type ModelBackend } from "./model.js";
import { SUMMARY_SYSTEM, buildSummaryPrompt } from "./prompt.js";
import type { ApprovedReview, Store } from "./store.js";
import type { Patch } from "../entities/sections.js";

/**
 * One curator tick. In order:
 *   1. failed cron pokes since the last run (pg_cron says "succeeded" even
 *      when the HTTP call failed, so pg_net's response table is read)
 *   2. page history thinning
 *   3. the nightly GitHub backup, when one is due (backup/run.ts)
 *   4. when the curator is on and a model key is in the vault:
 *      approved reviews applied; new items curated (one claim in a tick,
 *      claims until none are left in batch mode); summaries and embeddings
 *      for pages marked "summary needed"
 * Only one run at a time, across instances (curator_run_start).
 */

export type TickMode = "tick" | "batch";

export type TickDeps = {
  readonly store: Store;
  readonly embed: (text: string) => Promise<number[]>;
  /** Builds the model backend; the default calls DigitalOcean. */
  readonly makeModel?: (model: string, key: string) => ModelBackend;
  readonly now?: () => Date;
  /** Milliseconds a run may spend before it stops starting new work. */
  readonly budgetMs?: number;
  /** The nightly GitHub backup (backup/run.ts); it decides itself whether one is due. */
  readonly backup?: () => Promise<string>;
};

export type TickStats = Record<string, number | string | boolean | null>;

const BUDGET_MS: Record<TickMode, number> = { tick: 4 * 60_000, batch: 12 * 60_000 };
const SUMMARY_MIN = 20;
const SUMMARY_MAX = 800;

function counter(): { stats: TickStats; add: (k: string, n?: number) => void } {
  const stats: TickStats = {};
  return { stats, add: (k, n = 1) => void (stats[k] = Number(stats[k] ?? 0) + n) };
}

async function applyReview(r: ApprovedReview, deps: TickDeps & { now: () => Date }): Promise<"applied" | "stale"> {
  const p = r.proposal;
  const ref = p["ref"] as SourceRef | undefined;
  if (!ref) return "stale";
  if (r.kind === "new_page") {
    await deps.store.savePage(r.item_id, p["page"] as Record<string, unknown>, null);
    return "applied";
  }
  const update = p["update"] as { patches: Patch[]; fields: Record<string, string | number> } | undefined;
  const page = (await deps.store.candidates(r.item_id, [r.page_key], "", 1)).find((c) => c.key === r.page_key);
  if (!update || !page) return "stale";
  if (alreadyHas(page, r.item_id)) return "applied";
  const gen = (p["generated"] as Generated | undefined) ?? { by: "curator", model: "unknown", at: deps.now().toISOString() };
  // Patches are anchored by section, so they usually still apply to a page
  // that changed since; if not, the review goes stale for a person to redo.
  await deps.store.savePage(r.item_id, updatedPage(page, update, ref, gen), page.content_hash);
  return "applied";
}

async function applyReviews(deps: TickDeps & { now: () => Date }, add: (k: string) => void): Promise<void> {
  for (const r of await deps.store.approvedReviews(20)) {
    try {
      const result = await applyReview(r, deps);
      await deps.store.markReview(r.id, result);
      add(result === "applied" ? "reviews_applied" : "reviews_stale");
    } catch (err) {
      await deps.store.markReview(r.id, "stale", err instanceof Error ? err.message : "could not apply");
      add("reviews_stale");
    }
  }
}

/** Parse a summary reply; null when it is not a usable summary. */
export function parseSummary(text: string): string | null {
  try {
    const value = (JSON.parse(extractJsonObject(text)) as Record<string, unknown>)["summary"];
    if (typeof value !== "string") return null;
    const s = value.replace(/\s+/g, " ").trim();
    return s.length >= SUMMARY_MIN && s.length <= SUMMARY_MAX ? s : null;
  } catch {
    return null;
  }
}

async function writeSummaries(
  deps: TickDeps,
  model: ModelBackend,
  until: number,
  add: (k: string) => void,
): Promise<void> {
  for (const page of await deps.store.summaryQueue(20)) {
    if (Date.now() > until) return;
    try {
      const reply = await model.complete(SUMMARY_SYSTEM, buildSummaryPrompt(page), 600);
      const summary = parseSummary(reply.text);
      if (!summary) {
        add("summary_failed");
        continue;
      }
      const written = await deps.store.writeSummary(page.id, page.summary_queued_at, summary, await deps.embed(summary));
      add(written ? "summaries" : "summary_raced");
    } catch {
      add("summary_failed");
    }
  }
}

async function curateItems(deps: CurateDeps, mode: TickMode, batchSize: number, until: number, add: (k: string, n?: number) => void) {
  // The budget is checked before each claim; a claimed batch is finished.
  while (Date.now() <= until) {
    const items = await deps.store.claim(batchSize);
    for (const item of items) {
      try {
        const result = await curateItem(item, deps);
        add("items");
        add(result.outcome);
        add("queued_changes", result.queued);
      } catch (err) {
        await deps.store.done(item.id, "failed", [], err instanceof Error ? err.message : "error").catch(() => undefined);
        add("items");
        add("failed");
      }
    }
    if (mode === "tick" || items.length === 0) return;
  }
}

async function curatorWork(deps: TickDeps & { now: () => Date }, mode: TickMode, until: number, stats: TickStats, add: (k: string, n?: number) => void) {
  const settings = await deps.store.settings();
  stats["enabled"] = settings.enabled;
  stats["model"] = settings.model;
  if (!settings.enabled) return;
  const key = settings.hasModelKey ? await deps.store.modelKey() : null;
  if (!key) {
    stats["error"] = "no model key in the vault (kbe_model_key)";
    return;
  }
  const model = (deps.makeModel ?? doInference)(settings.model, key);
  const schema = entitySchema(settings.templates);
  await applyReviews(deps, add);
  await curateItems(
    { store: deps.store, model, modelName: settings.model, schema, now: deps.now },
    mode,
    settings.batchSize,
    until,
    add,
  );
  await writeSummaries(deps, model, until, add);
}

/** Run one tick now. Returns null when another run is in progress. */
export async function runTick(mode: TickMode, deps: TickDeps): Promise<TickStats | null> {
  const now = deps.now ?? (() => new Date());
  const full = { ...deps, now };
  const run = await deps.store.runStart(mode);
  if (!run) return null;
  const until = Date.now() + (deps.budgetMs ?? BUDGET_MS[mode]);
  const { stats, add } = counter();
  try {
    const since = (await deps.store.lastRunAt()) ?? new Date(now().getTime() - 3_600_000).toISOString();
    const pokes = await deps.store.pokeFailures(since);
    stats["poke_failures"] = pokes.failed;
    if (pokes.failed > 0) {
      stats["last_poke_error"] = pokes.lastError;
      logger.warn({ failed: pokes.failed }, "curator: cron pokes failed since the last run");
    }
    stats["history_pruned"] = await deps.store.pruneHistory();
    if (deps.backup) stats["backup"] = await deps.backup().catch(() => "failed");
    await curatorWork(full, mode, until, stats, add);
    await deps.store.runFinish(run, true, stats);
    logger.info({ mode, ...stats }, "curator run finished");
    return stats;
  } catch (err) {
    stats["error"] = err instanceof Error ? err.message : "run failed";
    await deps.store.runFinish(run, false, stats).catch(() => undefined);
    logger.error({ mode, error: stats["error"] }, "curator run failed");
    return stats;
  }
}
