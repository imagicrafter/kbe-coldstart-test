import { Hono } from "hono";
import { logger } from "../log/logger.js";
import { readForm } from "./guard.js";
import { card, esc, notice, postForm, sendMessage, when } from "./html.js";
import { admin, page, type Handler, type SettingsDeps } from "./settings-routes.js";

/**
 * /setup/backup: the nightly one-way GitHub backup (backup/run.ts), for the
 * Engine OWNER only. The admin sign-in lets administrators reach the page;
 * the database (0056 app_backup_*) then refuses anyone but the owner, because
 * the backup repository holds every page with no row protection.
 *
 * The GitHub token goes straight into Supabase Vault (kbe_backup_token) and
 * is only ever reported as "saved".
 */

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

const yes = (v: unknown) => (v === true ? "yes" : "no");

function lastRun(b: Record<string, unknown>): string {
  if (!b["last_status"]) return "never";
  const commit = typeof b["last_commit"] === "string" ? `, commit ${esc(String(b["last_commit"]).slice(0, 7))}` : "";
  const files = b["last_files"] !== null && b["last_files"] !== undefined ? `, ${esc(b["last_files"])} files` : "";
  const error = b["last_error"] ? ` <span class="hint">(${esc(b["last_error"])})</span>` : "";
  return `${esc(b["last_status"])}, ${esc(when(b["last_finished_at"] ?? b["last_started_at"]))}${files}${commit}${error}`;
}

const show: Handler = async (c, me, deps) => {
  const b = await deps.store.backup(me.email);
  const csrf = deps.csrf.token(me.email, "backup");
  const body =
    card(`<p>Each night the Engine writes every page to one <strong>private</strong> GitHub repository as Markdown that opens as an Obsidian vault: a file per page named by its title, a folder per drawer, the header as frontmatter, <code>[[Title]]</code> links, and a generated <code>index.md</code> and <code>log.md</code>.</p>
<p>It is one way: the database always wins. Anything edited in the repository is overwritten on the next run, and nothing is ever read back. The repository holds every person's pages with no sharing rules, so it is for you, the Engine owner, alone.</p>
<table><tbody>
<tr><td>Repository</td><td>${b["repo"] ? esc(b["repo"]) : "not set"}</td></tr>
<tr><td>Branch</td><td>${esc(b["branch"] ?? "main")}</td></tr>
<tr><td>Token saved</td><td>${yes(b["has_token"])}</td></tr>
<tr><td>Backup on</td><td>${yes(b["enabled"])}</td></tr>
<tr><td>Last run</td><td>${lastRun(b)}</td></tr>
</tbody></table>
<p class="hint">It runs on the curator timer (the Timer screen), at most once every 20 hours.</p>`) +
    card(`<h2>Token</h2><p>Make a fine-grained GitHub token for this one repository only, with <em>Contents: read and write</em>. It is kept in Supabase Vault and never shown again.</p>
${postForm("/setup/backup/token", csrf, `<label for="backup_token">${b["has_token"] ? "Replace the token" : "GitHub token"}</label>
<input type="password" id="backup_token" name="backup_token" autocomplete="off" spellcheck="false" required maxlength="4096">`, "Save the token")}`) +
    card(`<h2>Repository</h2>${postForm("/setup/backup", csrf, `<label for="repo">Private repository (owner/name)</label>
<input type="text" id="repo" name="repo" value="${esc(b["repo"] ?? "")}" maxlength="140" pattern="[A-Za-z0-9-]+/[A-Za-z0-9._-]+" placeholder="acme/knowledge-backup">
<label for="branch">Branch</label><input type="text" id="branch" name="branch" value="${esc(b["branch"] ?? "main")}" maxlength="100">
<label><input type="checkbox" name="enabled" value="yes"${b["enabled"] ? " checked" : ""}> Back up every night</label>`, "Save")}`) +
    card(`${postForm("/setup/backup/now", csrf, "", "Back up on the next timer run")}<p class="hint">Use this after changing the repository, or to test the token.</p>`);
  return page(c, "/setup/backup", "Backup", body);
};

const save: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "backup");
  if (!sent.ok) return sent.response;
  const repo = (sent.form["repo"] ?? "").trim();
  const branch = (sent.form["branch"] ?? "").trim() || "main";
  if ((repo !== "" && !REPO.test(repo)) || !BRANCH.test(branch) || branch.includes("..")) {
    return page(c, "/setup/backup", "Not saved", notice("error", "The repository is owner/name and the branch a plain branch name."), 400);
  }
  const enabled = sent.form["enabled"] === "yes";
  await deps.store.setBackup(me.email, repo === "" ? null : repo, branch, enabled);
  logger.info({ enabled }, "app: backup settings saved");
  return sendMessage(c, "setup", 200, "Saved", enabled ? `Pages are backed up to ${repo} each night.` : "The backup is off.");
};

const saveToken: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "backup");
  if (!sent.ok) return sent.response;
  const value = (sent.form["backup_token"] ?? "").trim();
  if (value.length < 10 || value.length > 4096 || /\s/.test(value)) {
    return page(c, "/setup/backup", "Not saved", notice("error", "Paste the whole token and nothing else (10 to 4096 characters, no spaces)."), 400);
  }
  await deps.store.setBackupToken(me.email, value);
  logger.info({ secret: "kbe_backup_token" }, "app: backup token stored in vault");
  return sendMessage(c, "setup", 200, "Token saved", "The GitHub token is in Supabase Vault. It is not shown again.");
};

const now: Handler = async (c, me, deps) => {
  const sent = await readForm(c, deps, "setup", me.email, "backup");
  if (!sent.ok) return sent.response;
  await deps.store.requestBackup(me.email);
  return sendMessage(c, "setup", 200, "Asked", "The backup runs on the next timer run, if it is on.");
};

export function makeBackupRoutes(use: () => SettingsDeps): Hono {
  const app = new Hono();
  const wrap = (h: Handler) => admin(use, h);
  app.get("/backup", wrap(show));
  app.post("/backup", wrap(save));
  app.post("/backup/token", wrap(saveToken));
  app.post("/backup/now", wrap(now));
  return app;
}
