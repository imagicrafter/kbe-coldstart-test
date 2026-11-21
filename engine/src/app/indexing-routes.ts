import { Hono } from "hono";
import { logger } from "../log/logger.js";
import { UUID, readForm } from "./guard.js";
import { card, esc, hidden, postForm, sendMessage, when } from "./html.js";
import { admin, page, type Handler, type SettingsDeps } from "./settings-routes.js";
import type { Row } from "./store.js";
import { adminMigrationState, updateBanner } from "./db-update.js";

/**
 * /setup/indexing, administrators only (admin app, second factor): how far
 * the Engine is with its pages, and two actions.
 *
 *   status    pages, summaries waiting, raw items waiting / flagged / failed,
 *             the last curator run, the models, the last backup
 *   settings  curator on/off (the same switch as /setup/timer), the wake
 *             gap (fixed at 2 minutes, migration 0057), the model key
 *   actions   re-index one page (queue its summary and embedding again);
 *             re-run pending summaries (re-queue them and wake the curator)
 */

export const EMBEDDING_MODEL = "gte-small (384 dimensions, Supabase embed function)";
export const WAKE_GAP = "2 minutes (new items wake the curator at most this often; an hourly tick always runs)";

const object = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const num = (v: unknown): string => esc(Number(v ?? 0).toLocaleString("en-US"));

function statRow(label: string, value: string, warn = false): string {
  return `<tr${warn ? ' class="warn"' : ""}><th scope="row">${esc(label)}</th><td>${value}</td></tr>`;
}

function lastRun(run: Row): string {
  if (!run["started_at"]) return "never";
  const stats = object(run["stats"]);
  const parts = Object.entries(stats)
    .filter(([, v]) => typeof v === "number" && v !== 0)
    .map(([k, v]) => `${esc(k.replace(/_/g, " "))} ${esc(v)}`)
    .join(", ");
  return `${esc(when(run["started_at"]))}: <strong>${esc(run["status"])}</strong>${parts ? ` (${parts})` : ""}`;
}

const indexing: Handler = async (c, me, deps) => {
  const s = await deps.store.indexing(me.email);
  const banner = updateBanner(await adminMigrationState(deps.database, () => deps.store.health(me.email)).catch(() => ({ known: false, exact: false, shipped: 0, applied: 0, pending: [] })));
  const cur = object(s["curator"]);
  const backup = object(s["backup"]);
  const status = card(`<h2>Status</h2><table class="stats"><tbody>
${statRow("Pages", num(s["pages"]))}
${statRow("Summaries pending", num(s["summaries_pending"]), Number(s["summaries_pending"] ?? 0) > 0)}
${statRow("Raw items waiting", num(s["items_waiting"]))}
${statRow("Raw items flagged", num(s["items_flagged"]), Number(s["items_flagged"] ?? 0) > 0)}
${statRow("Failed items", num(s["items_failed"]), Number(s["items_failed"] ?? 0) > 0)}
${statRow("Last curator run", lastRun(object(s["last_run"])))}
${statRow("Curator model", esc(cur["model"] ?? ""))}
${statRow("Embedding model", esc(EMBEDDING_MODEL))}
${statRow("Last backup", backup["last_finished_at"] ? `${esc(when(backup["last_finished_at"]))} (${esc(backup["last_status"])})` : backup["enabled"] ? "not yet" : "backup is off")}
</tbody></table>`);
  const on = cur["enabled"] === true;
  const timerCsrf = deps.csrf.token(me.email, "timer");
  const settings = card(`<h2>Settings</h2>
<p>Curator: <strong>${on ? "on" : "off"}</strong>${cur["has_engine_url"] === true ? "" : ' <span class="hint">(the timer is not set up yet: <a href="/setup/timer">Timer</a>)</span>'}</p>
${cur["has_engine_url"] === true ? postForm("/setup/timer", timerCsrf, hidden("enabled", on ? "no" : "yes"), on ? "Turn the curator off" : "Turn the curator on") : ""}
<p>Wake gap: ${esc(WAKE_GAP)}</p>
<p>Model key: ${s["has_model_key"] === true ? "set" : "<strong>not set</strong>"} · <a href="/setup/model">Change the model key</a></p>`);
  const consensus = cur["consensus"] === false
    ? "<p>Consensus: off (one run per item)</p>"
    : `<p>Consensus: on · two runs of ${esc(cur["model"] ?? "")}, tiebreak ${esc(cur["tiebreak_model"] ?? "")}</p>`;
  const unsure = Array.isArray(s["uncertain"]) ? (s["uncertain"] as Array<Record<string, unknown>>) : [];
  const unsureRows = unsure
    .map((u) => `<tr><td>${esc(when(u["created_at"]))}</td><td>${esc(u["item_title"] ?? "(no title)")} <span class="hint">${esc(u["source"])}</span></td><td><code>${esc(u["decision"])}</code></td><td>${esc((Array.isArray(u["proposals"]) ? u["proposals"] : []).map(String).join(" · "))}</td></tr>`)
    .join("");
  const uncertainCard = card(`<h2>Uncertain decisions</h2>${consensus}
${unsure.length ? `<table><thead><tr><th>When</th><th>Item</th><th>Decision</th><th>Three proposals</th></tr></thead><tbody>${unsureRows}</tbody></table>` : "<p>None. When the three runs all disagree on a decision, it is left out and listed here.</p>"}`);
  const csrf = deps.csrf.token(me.email, "indexing");
  const actions = card(`<h2>Actions</h2>
${postForm("/setup/indexing/rerun", csrf, "", "Re-run pending summaries")}
<p class="hint">Queues every page still waiting for a summary again and wakes the curator. To re-index one page, use Re-index on that page.</p>`);
  return page(c, "/setup/indexing", "Indexing", banner + status + settings + uncertainCard + actions);
};

const rerun: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "indexing");
  if (!sent.ok) return sent.response;
  const n = await deps.store.rerunSummaries(me.email);
  logger.info({ pages: n }, "app: summaries re-run");
  return sendMessage(c, "setup", 200, "Queued", `${n} ${n === 1 ? "page is" : "pages are"} queued for a new summary; the curator was woken.`);
};

const reindex: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "indexing");
  if (!sent.ok) return sent.response;
  const id = sent.form["page"] ?? "";
  if (!UUID.test(id)) return sendMessage(c, "setup", 400, "Not accepted", "No page was named.");
  const ok = await deps.store.reindexPage(me.email, id);
  logger.info({ page: id, ok }, "app: page re-index");
  return ok
    ? sendMessage(c, "setup", 200, "Queued", "The page's summary and embedding will be written again on the curator's next run.")
    : sendMessage(c, "setup", 404, "Not found", "There is no such page.");
};

export function makeIndexingRoutes(use: () => SettingsDeps): Hono {
  const app = new Hono();
  app.get("/indexing", admin(use, indexing));
  app.post("/indexing/rerun", admin(use, rerun));
  app.post("/indexing/reindex", admin(use, reindex));
  return app;
}

