import { db } from "../db.js";
import { logger } from "../log/logger.js";
import { runTwoStep, type TwoStepResult, type TwoStepSpec } from "../tools/admin/rpc.js";

/**
 * The app screens' calls into the database (migration 0054, plus the admin
 * functions of 0033). Each takes the signed-in email first; the database
 * resolves it to an active person and applies the rules. Log lines carry the
 * function and SQLSTATE only, never arguments (they hold page text and keys).
 */

/** The database refused on purpose (22023): the message is for the person. */
export class AppInputError extends Error {}
/** Not allowed (42501). */
export class AppDeniedError extends Error {}
/** Anything else. The page says "try again" without detail. */
export class AppStoreError extends Error {}

export type Row = Record<string, unknown>;

export type SaveResult = { readonly id: string; readonly content_hash: string; readonly changed: boolean };

export type AppStore = {
  readonly whoami: (email: string) => Promise<Row | null>;
  readonly reviews: (email: string, status: string | null) => Promise<Row[]>;
  readonly review: (email: string, id: string) => Promise<Row | null>;
  readonly decide: (email: string, id: string, approve: boolean) => Promise<boolean>;
  readonly flagged: (email: string) => Promise<Row[]>;
  readonly release: (email: string, id: string) => Promise<boolean>;
  readonly discard: (email: string, id: string) => Promise<boolean>;
  readonly pages: (email: string, query: string | null) => Promise<Row[]>;
  readonly page: (email: string, id: string) => Promise<Row | null>;
  readonly savePage: (email: string, page: Row, expectedHash: string | null) => Promise<SaveResult>;
  readonly history: (email: string, pageId: string) => Promise<Row[]>;
  readonly version: (email: string, historyId: string) => Promise<Row | null>;
  readonly restore: (email: string, historyId: string, expectedHash: string) => Promise<SaveResult>;
  // settings (administrators)
  readonly templates: () => Promise<string[]>;
  readonly setTemplates: (email: string, names: readonly string[]) => Promise<string[]>;
  readonly topics: (email: string) => Promise<Row[]>;
  readonly addTopic: (email: string, topic: string, label: string, sensitive: boolean) => Promise<boolean>;
  readonly people: (email: string) => Promise<Row[]>;
  /** An admin change in two steps (0033): no code previews, a code applies. */
  readonly twoStep: (email: string, spec: TwoStepSpec) => Promise<TwoStepResult>;
  readonly setModelKey: (email: string, value: string) => Promise<void>;
  readonly timer: (email: string) => Promise<Row>;
  readonly setTimer: (email: string, host: string, everyMinutes: number, enabled: boolean) => Promise<Row>;
  readonly testTimer: (email: string) => Promise<number | null>;
  readonly timerResult: (email: string, id: number) => Promise<Row | null>;
  readonly health: (email: string) => Promise<Row>;
  // backup (the Engine owner only; 0056)
  readonly backup: (email: string) => Promise<Row>;
  readonly setBackup: (email: string, repo: string | null, branch: string, enabled: boolean) => Promise<Row>;
  readonly requestBackup: (email: string) => Promise<Row>;
  readonly setBackupToken: (email: string, value: string) => Promise<void>;
};

async function rpc(fn: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
  const { data, error } = await db().rpc(fn, args).abortSignal(AbortSignal.timeout(15_000));
  if (error) {
    logger.warn({ fn, code: error.code }, "app RPC failed");
    if (error.code === "22023") throw new AppInputError(error.message.slice(0, 300));
    if (error.code === "42501") throw new AppDeniedError("not allowed");
    throw new AppStoreError("database error");
  }
  return data;
}

const list = (data: unknown): Row[] => (Array.isArray(data) ? (data as Row[]) : []);
const obj = (data: unknown): Row | null =>
  data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Row) : null;

function saved(data: unknown): SaveResult {
  const row = list(data)[0];
  if (!row) throw new AppStoreError("no result");
  return { id: String(row["id"]), content_hash: String(row["content_hash"]), changed: row["changed"] === true };
}

export const liveStore: AppStore = {
  whoami: async (email) => obj(await rpc("app_whoami", { p_email: email })),
  reviews: async (email, status) => list(await rpc("app_review_list", { p_email: email, p_status: status })),
  review: async (email, id) => obj(await rpc("app_review_get", { p_email: email, p_id: id })),
  decide: async (email, id, approve) =>
    (await rpc("app_review_decide", { p_email: email, p_id: id, p_approve: approve })) === true,
  flagged: async (email) => list(await rpc("app_flagged_list", { p_email: email })),
  release: async (email, id) => (await rpc("app_flagged_release", { p_email: email, p_id: id })) === true,
  discard: async (email, id) => (await rpc("app_flagged_discard", { p_email: email, p_id: id })) === true,
  pages: async (email, query) => list(await rpc("app_pages_list", { p_email: email, p_query: query, p_limit: 200 })),
  page: async (email, id) => obj(await rpc("app_page_get", { p_email: email, p_id: id })),
  savePage: async (email, page, expectedHash) =>
    saved(await rpc("app_page_save", { p_email: email, p_page: page, p_expected_hash: expectedHash })),
  history: async (email, pageId) => list(await rpc("app_page_history", { p_email: email, p_page_id: pageId })),
  version: async (email, historyId) => obj(await rpc("app_page_version", { p_email: email, p_history_id: historyId })),
  restore: async (email, historyId, expectedHash) =>
    saved(await rpc("app_page_restore", { p_email: email, p_history_id: historyId, p_expected_hash: expectedHash })),
  templates: async () => {
    const data = await rpc("engine_templates_get", {});
    return Array.isArray(data) ? data.map(String) : [];
  },
  setTemplates: async (email, names) => {
    const data = await rpc("app_templates_set", { p_email: email, p_names: names });
    return Array.isArray(data) ? data.map(String) : [];
  },
  topics: async (email) => list(await rpc("app_topics_list", { p_email: email })),
  addTopic: async (email, topic, label, sensitive) =>
    (await rpc("app_topic_add", { p_email: email, p_topic: topic, p_label: label, p_sensitive: sensitive })) === true,
  people: async (email) => list(await rpc("admin_people_list", { p_email: email })),
  twoStep: (email, spec) => runTwoStep(spec, email),
  setModelKey: async (email, value) => {
    await rpc("app_secret_set", { p_email: email, p_name: "kbe_model_key", p_value: value });
  },
  timer: async (email) => obj(await rpc("app_timer_get", { p_email: email })) ?? {},
  setTimer: async (email, host, everyMinutes, enabled) =>
    obj(await rpc("app_timer_set", { p_email: email, p_host: host, p_every_minutes: everyMinutes, p_enabled: enabled })) ?? {},
  testTimer: async (email) => {
    const data = await rpc("app_timer_test", { p_email: email });
    return typeof data === "number" ? data : null;
  },
  timerResult: async (email, id) => obj(await rpc("app_timer_result", { p_email: email, p_request: id })),
  health: async (email) => obj(await rpc("app_health", { p_email: email })) ?? {},
  backup: async (email) => obj(await rpc("app_backup_get", { p_email: email })) ?? {},
  setBackup: async (email, repo, branch, enabled) =>
    obj(await rpc("app_backup_set", { p_email: email, p_repo: repo, p_branch: branch, p_enabled: enabled })) ?? {},
  requestBackup: async (email) => obj(await rpc("app_backup_request", { p_email: email })) ?? {},
  setBackupToken: async (email, value) => {
    await rpc("app_secret_set", { p_email: email, p_name: "kbe_backup_token", p_value: value });
  },
};
