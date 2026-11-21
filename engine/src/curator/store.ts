import { db } from "../db.js";
import { logger } from "../log/logger.js";
import type { Candidate } from "./output.js";

/**
 * The curator's only way into the database: the 0053 functions, granted to
 * the service role alone. No function takes an owner argument; the owner is
 * always the owner of the item named.
 *
 * Log lines carry the function name and error code only, never arguments
 * (they hold page and mail text).
 */

export class StoreError extends Error {
  constructor(
    readonly fn: string,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

async function call(fn: string, args: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
  const { data, error } = await db().rpc(fn, args);
  if (error) {
    logger.warn({ fn, code: error.code }, "curator RPC failed");
    throw new StoreError(fn, error.code, error.code === "22023" ? error.message : `${fn} failed`);
  }
  return data;
}

const rows = (data: unknown): Array<Record<string, unknown>> =>
  Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export type CuratorSettings = {
  readonly enabled: boolean;
  readonly model: string;
  readonly templates: readonly string[];
  readonly batchSize: number;
  readonly hasModelKey: boolean;
};

export type ClaimedItem = {
  readonly id: string;
  readonly owner_email: string | null;
  readonly source: string;
  readonly source_id: string;
  readonly version: number;
  readonly title: string | null;
  readonly body: string;
  readonly topics: readonly string[];
  readonly metadata: Record<string, unknown>;
  readonly source_created_at: string | null;
  readonly received_at: string;
  readonly released: boolean;
};

/** A full page row from curator_candidates: what a save needs to rebuild it. */
export type PageRow = Candidate & {
  readonly template: string | null;
  readonly aliases: readonly string[];
  readonly topics: readonly string[];
  readonly status: string;
  readonly tags: readonly string[];
  readonly related: readonly string[];
  readonly sources: readonly unknown[];
  readonly generated: Record<string, unknown> | null;
  readonly verified: readonly unknown[];
  readonly matched_on: string;
};

export type SaveRow = { readonly id: string; readonly changed: boolean; readonly created: boolean };

export type ApprovedReview = {
  readonly id: string;
  readonly item_id: string;
  readonly page_id: string | null;
  readonly page_key: string;
  readonly kind: "update" | "new_page";
  readonly proposal: Record<string, unknown>;
  readonly base_hash: string | null;
};

export type QueuedSummary = {
  readonly id: string;
  readonly drawer: string;
  readonly title: string;
  readonly description: string | null;
  readonly body: string;
  readonly summary_queued_at: string;
};

function toPageRow(r: Record<string, unknown>): PageRow {
  return {
    id: str(r["id"]),
    drawer: str(r["drawer"]),
    key: str(r["key"]),
    template: strOrNull(r["template"]),
    title: str(r["title"]),
    aliases: list(r["aliases"]),
    description: strOrNull(r["description"]),
    fields: obj(r["fields"]),
    topics: list(r["topics"]),
    status: str(r["status"]) || "unreviewed",
    tags: list(r["tags"]),
    related: list(r["related"]),
    sources: Array.isArray(r["sources"]) ? (r["sources"] as unknown[]) : [],
    generated: r["generated"] ? obj(r["generated"]) : null,
    verified: Array.isArray(r["verified"]) ? (r["verified"] as unknown[]) : [],
    body: str(r["body"]),
    content_hash: str(r["content_hash"]),
    matched_on: str(r["matched_on"]),
  };
}

export const store = {
  async settings(): Promise<CuratorSettings> {
    const r = rows(await call("curator_settings_get"))[0] ?? {};
    return {
      enabled: r["enabled"] === true,
      model: str(r["model"]) || "openai-gpt-oss-120b",
      templates: list(r["templates"]),
      batchSize: typeof r["batch_size"] === "number" ? r["batch_size"] : 10,
      hasModelKey: r["has_model_key"] === true,
    };
  },

  async tickSecretOk(secret: string): Promise<boolean> {
    return (await call("curator_tick_secret_ok", { p_secret: secret })) === true;
  },

  async modelKey(): Promise<string | null> {
    const key = await call("curator_model_key");
    return typeof key === "string" && key !== "" ? key : null;
  },

  async runStart(mode: "tick" | "batch"): Promise<string | null> {
    return strOrNull(await call("curator_run_start", { p_mode: mode }));
  },

  async runFinish(run: string, ok: boolean, stats: Record<string, unknown>): Promise<void> {
    await call("curator_run_finish", { p_run: run, p_ok: ok, p_stats: stats });
  },

  async lastRunAt(): Promise<string | null> {
    return strOrNull(await call("curator_last_run_at"));
  },

  async pokeFailures(since: string): Promise<{ failed: number; lastError: string | null }> {
    const r = rows(await call("curator_poke_failures", { p_since: since }))[0] ?? {};
    return { failed: typeof r["failed"] === "number" ? r["failed"] : 0, lastError: strOrNull(r["last_error"]) };
  },

  async pruneHistory(): Promise<number> {
    const n = await call("page_history_prune", {});
    return typeof n === "number" ? n : 0;
  },

  async claim(limit: number): Promise<readonly ClaimedItem[]> {
    return rows(await call("curator_claim", { p_limit: limit, p_lease_seconds: 600 })).map((r) => ({
      id: str(r["id"]),
      owner_email: strOrNull(r["owner_email"]),
      source: str(r["source"]),
      source_id: str(r["source_id"]),
      version: typeof r["version"] === "number" ? r["version"] : 1,
      title: strOrNull(r["title"]),
      body: str(r["body"]),
      topics: list(r["topics"]),
      metadata: obj(r["metadata"]),
      source_created_at: strOrNull(r["source_created_at"]),
      received_at: str(r["received_at"]),
      released: r["released"] === true,
    }));
  },

  async flag(itemId: string, reason: string): Promise<void> {
    await call("curator_flag", { p_item_id: itemId, p_reason: reason });
  },

  async done(itemId: string, outcome: string, pages: readonly string[], error?: string): Promise<void> {
    await call("curator_item_done", { p_item_id: itemId, p_outcome: outcome, p_pages: pages, p_error: error ?? null });
  },

  /** A decision the consensus runs could not settle (0062): shown on Indexing. */
  async uncertain(itemId: string, decision: string, proposals: readonly string[]): Promise<void> {
    await call("curator_uncertain_record", { p_item_id: itemId, p_decision: decision, p_proposals: proposals });
  },

  /** Consensus settings (0062): on/off and the tiebreak model. */
  async consensus(): Promise<{ readonly enabled: boolean; readonly tiebreakModel: string }> {
    const r = (await call("curator_consensus_get")) as Record<string, unknown> | null;
    return {
      enabled: r?.["enabled"] !== false,
      tiebreakModel: typeof r?.["tiebreak_model"] === "string" ? r["tiebreak_model"] : "deepseek-v4.1-flash",
    };
  },

  async candidates(itemId: string, keys: readonly string[], query: string, limit = 8): Promise<readonly PageRow[]> {
    return rows(
      await call("curator_candidates", { p_item_id: itemId, p_keys: keys, p_query: query, p_limit: limit }),
    ).map(toPageRow);
  },

  async savePage(itemId: string, page: Record<string, unknown>, expectedHash: string | null): Promise<SaveRow> {
    const r = rows(await call("curator_page_save", { p_item_id: itemId, p_page: page, p_expected_hash: expectedHash }))[0];
    if (!r) throw new StoreError("curator_page_save", undefined, "the page could not be saved");
    return { id: str(r["id"]), changed: r["changed"] === true, created: r["created"] === true };
  },

  async queueReview(args: {
    itemId: string;
    pageId: string | null;
    pageKey: string;
    kind: "update" | "new_page";
    reasons: readonly string[];
    proposal: Record<string, unknown>;
    baseHash: string | null;
  }): Promise<string | null> {
    return strOrNull(
      await call("curator_review_add", {
        p_item_id: args.itemId,
        p_page_id: args.pageId,
        p_page_key: args.pageKey,
        p_kind: args.kind,
        p_reasons: args.reasons,
        p_proposal: args.proposal,
        p_base_hash: args.baseHash,
      }),
    );
  },

  async approvedReviews(limit = 20): Promise<readonly ApprovedReview[]> {
    return rows(await call("curator_reviews_approved", { p_limit: limit })).map((r) => ({
      id: str(r["id"]),
      item_id: str(r["item_id"]),
      page_id: strOrNull(r["page_id"]),
      page_key: str(r["page_key"]),
      kind: r["kind"] === "new_page" ? "new_page" : "update",
      proposal: obj(r["proposal"]),
      base_hash: strOrNull(r["base_hash"]),
    }));
  },

  async markReview(id: string, status: "applied" | "stale", error?: string): Promise<void> {
    await call("curator_review_mark", { p_id: id, p_status: status, p_error: error ?? null });
  },

  async summaryQueue(limit = 20): Promise<readonly QueuedSummary[]> {
    return rows(await call("curator_summary_queue", { p_limit: limit })).map((r) => ({
      id: str(r["id"]),
      drawer: str(r["drawer"]),
      title: str(r["title"]),
      description: strOrNull(r["description"]),
      body: str(r["body"]),
      summary_queued_at: str(r["summary_queued_at"]),
    }));
  },

  async writeSummary(pageId: string, queuedAt: string, summary: string, embedding: readonly number[]): Promise<boolean> {
    return (
      (await call("curator_summary_write", {
        p_page_id: pageId,
        p_queued_at: queuedAt,
        p_distillation: summary,
        p_embedding: embedding,
      })) === true
    );
  },
};

export type Store = typeof store;
