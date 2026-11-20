import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { logger } from "../log/logger.js";
import { isEmail } from "../setup/inputs.js";
import type { EngineMode } from "../setup/mode.js";
import { CLAIM_COOKIE, claimCookie, readCookie, type BootCode } from "./boot-code.js";
import { sameSite, isFormPost } from "./csrf.js";
import { DB_STEPS, runDbSetup, type SqlFiles, type StepReport } from "./db-setup.js";
import { appLayout, card, esc, hidden, notice, sendMessage, sendPage } from "./html.js";
import { createMgmt, MgmtError, REF_PATTERN, type FetchLike } from "./mgmt.js";

/**
 * The first two setup screens, before any sign-in exists:
 *
 *   GET  /setup?code=...   claim the app with the first-run code (boot-code.ts)
 *   POST /setup/claim      the same, for a code typed into the claim page
 *   GET  /setup/database   the Database screen
 *   POST /setup/database   project ref + one Supabase access token -> db-setup.ts
 *
 * The gate (firstRunGate) sits in front of the existing /setup routes. It acts
 * only while the Engine is in setup mode AND the code is the first-run one
 * (no SETUP_CODE deployed): without a claim, every /setup page shows the
 * claim page and every post is refused; with a claim and an empty database it
 * sends the person to the Database screen; after that it lets the existing
 * Cloudflare sign-in screen run, which then takes its code from the claim.
 *
 * THE ACCESS TOKEN is read from the form, handed to the Management API client
 * and goes nowhere else. It is never written into a page, a log line or the
 * database, and it is not kept after the request.
 */

export type FirstRunRouteDeps = {
  readonly boot: () => BootCode;
  /** SETUP_CODE was deployed: the operator route, not this one. */
  readonly envCode: string | undefined;
  readonly mode: () => Promise<EngineMode>;
  readonly projectRef: string | null;
  readonly kbSchema: string;
  readonly jwtSecret: string;
  readonly anonKey: string;
  readonly files: () => SqlFiles | null;
  readonly fetch: FetchLike;
  readonly onDatabaseReady: () => void;
};

const secure = (c: Context) => (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")) === "https";

function active(deps: FirstRunRouteDeps): boolean {
  return !deps.envCode && deps.boot().original() !== undefined;
}

/** These screens exist only while the Engine is new. Unknown means no. */
async function stillNew(deps: FirstRunRouteDeps): Promise<boolean> {
  if (!active(deps)) return false;
  try {
    return (await deps.mode()).kind === "setup";
  } catch {
    return false;
  }
}

function session(c: Context, deps: FirstRunRouteDeps) {
  return deps.boot().session(readCookie(c.req.header("cookie"), CLAIM_COOKIE));
}

/** A form token tied to this claim cookie (the cookie is SameSite=Strict as well). */
export function claimFormToken(cookie: string, scope: string): string {
  return createHmac("sha256", cookie).update(`kbe-claim-form|${scope}`).digest("base64url");
}

function tokenOk(given: unknown, want: string): boolean {
  if (typeof given !== "string" || given.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

/** Who is claiming, for the per-client lockout: Cloudflare's header, else the first proxy hop. */
export function clientKey(c: Context): string {
  const cf = c.req.header("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || "unknown";
}

const page = (c: Context, status: 200 | 400 | 401 | 403 | 409 | 422 | 429 | 503, title: string, body: string) =>
  sendPage(c, status, appLayout("setup", "", title, body));

function claimPage(c: Context, status: 200 | 401 | 409 | 429, problem?: string): Response {
  const body = (problem ? notice("error", problem) : "") +
    card(`<p>This Engine is new. To claim it, open the address with the one-time code from the app's own log (in DigitalOcean: your app, then <strong>Runtime Logs</strong>, the line starting <code>FIRST RUN</code>), or type the code here.</p>
<form method="post" action="/setup/claim">
<label for="code">One-time code</label>
<input type="password" id="code" name="code" autocomplete="one-time-code" required maxlength="256">
<p><button type="submit">Claim this Engine</button></p>
</form>
<p class="hint">The code works once. Restarting the app before setup is finished makes a new one.</p>`);
  return page(c, status, "Claim this Engine", body);
}

function claimRefusal(c: Context, reason: "none" | "spent" | "locked" | "wrong", retry: number): Response {
  switch (reason) {
    case "locked":
      c.header("Retry-After", String(Math.max(1, retry)));
      return claimPage(c, 429, "Too many wrong codes from here. Claiming is locked for an hour; restarting the app resets the lock and makes a new code.");
    case "spent":
      return claimPage(c, 409, "This Engine has already been claimed. Restart the app for a new code if that was not you.");
    default:
      return claimPage(c, 401, "That is not the code.");
  }
}

function doClaim(c: Context, deps: FirstRunRouteDeps, code: unknown): Response {
  const result = deps.boot().claim(code, clientKey(c));
  if (!result.ok) {
    logger.warn({ reason: result.reason }, "first run: claim refused");
    return claimRefusal(c, result.reason, result.retryAfterSeconds);
  }
  logger.info("first run: Engine claimed");
  c.header("Set-Cookie", claimCookie(result.cookie, secure(c)));
  // Off the address bar and the history: the code is spent anyway.
  return c.redirect("/setup/database", 303);
}

// ── the gate in front of /setup ─────────────────────────────────────────────

export function firstRunGate(use: () => FirstRunRouteDeps): MiddlewareHandler {
  return async (c, next) => {
    const deps = use();
    if (!active(deps)) return next();
    let mode: EngineMode;
    try {
      mode = await deps.mode();
    } catch {
      return sendMessage(c, "setup", 503, "Setup is unavailable", "The Engine's database did not answer. Try again in a minute.");
    }
    if (mode.kind !== "setup") return next();

    const path = c.req.path;
    if (path === "/setup/claim" || path.startsWith("/setup/assets/")) return next();
    const code = c.req.method === "GET" && path === "/setup" ? c.req.query("code") : undefined;
    if (code !== undefined) return doClaim(c, deps, code);

    if (!session(c, deps)) {
      return c.req.method === "GET" ? claimPage(c, 200) : sendMessage(c, "setup", 401, "Claim this Engine first", "Open /setup with the one-time code from the app's log.");
    }
    if (path === "/setup/database") return next();
    if (mode.databaseMissing) {
      return c.req.method === "GET" ? c.redirect("/setup/database", 303) : sendMessage(c, "setup", 409, "Set up the database first", "Finish the Database screen, then come back.");
    }
    return next();
  };
}

// ── the Database screen ─────────────────────────────────────────────────────

function stepsTable(steps: readonly StepReport[]): string {
  const rows = steps
    .map((s) => `<tr><td>${esc(s.status.replace("_", " "))}</td><td>${esc(s.title)}</td><td>${esc(s.note ?? "")}</td></tr>`)
    .join("");
  return `<table><thead><tr><th>Result</th><th>Step</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function databaseForm(deps: FirstRunRouteDeps, cookie: string, values: { ref: string; owner: string }): string {
  const plan = DB_STEPS.map((s) => `<li>${esc(s.title)}</li>`).join("");
  return card(`<p>The Engine keeps everything in your Supabase project <strong>${esc(deps.projectRef ?? "(unknown)")}</strong>. This screen sets it up for you:</p><ol>${plan}</ol>`) +
    card(`<h2>Make a Supabase access token</h2>
<ol>
<li>In Supabase open <strong>Account</strong>, then <strong>Access Tokens</strong>, then <strong>Generate new token</strong>.</li>
<li>If Supabase offers it, limit the token to this one project. Set it to expire tomorrow.</li>
<li>Copy it. It is used for this one request and not saved anywhere. Delete it in Supabase when setup is done.</li>
</ol>`) +
    card(`<form method="post" action="/setup/database">
${hidden("csrf", claimFormToken(cookie, "database"))}
<label for="owner_email">Your email (you become the owner)</label>
<input type="email" id="owner_email" name="owner_email" value="${esc(values.owner)}" autocomplete="email" required maxlength="254">
<label for="ref">Supabase project ref</label>
<input type="text" id="ref" name="ref" value="${esc(values.ref)}" required maxlength="20" pattern="[a-z0-9]{20}" spellcheck="false">
<p class="hint">The 20 letters in your project's address, https://<strong>ref</strong>.supabase.co. It must be the project this app is deployed with.</p>
<label for="access_token">Supabase access token</label>
<input type="password" id="access_token" name="access_token" autocomplete="off" spellcheck="false" required maxlength="512">
<p><button type="submit">Set up the database</button></p>
</form>`);
}

function getDatabase(use: () => FirstRunRouteDeps) {
  return async (c: Context) => {
    const deps = use();
    if (!(await stillNew(deps))) return sendMessage(c, "setup", 404, "Not here", "This screen is only for a new Engine.");
    const s = session(c, deps);
    if (!s) return claimPage(c, 200);
    const owner = deps.boot().claimedOwner() ?? "";
    const form = databaseForm(deps, s.cookie, { ref: deps.projectRef ?? "", owner });
    if (c.req.query("again") === undefined && (await databaseReady(deps))) {
      return page(c, 200, "Database is ready", doneView(lastResult));
    }
    return page(c, 200, "Database", form);
  };
}

/** The last successful run in this process, to show when the screen is opened again. */
let lastResult: readonly StepReport[] | null = null;

/** The database has the Engine's schema already. Unknown means no. */
async function databaseReady(deps: FirstRunRouteDeps): Promise<boolean> {
  try {
    const mode = await deps.mode();
    return mode.kind === "setup" && mode.databaseMissing !== true;
  } catch {
    return false;
  }
}

function doneView(steps: readonly StepReport[] | null): string {
  const table = steps ? card(stepsTable(steps)) : card("<p>The Engine's database is set up.</p>");
  return notice("ok", "The database is set up.") + table +
    card(`<p>Next: <a href="/setup">set up Cloudflare sign-in</a>. Then delete the Supabase access token.</p>
<p class="hint">Something to fix? <a href="/setup/database?again=1">Run the database setup again</a>: finished steps are not repeated.</p>`);
}

/** "migrations:done:41200ms", one per step, for the log. */
const timed = (steps: readonly StepReport[]) => steps.map((x) => `${x.id}:${x.status}${x.ms === undefined ? "" : `:${x.ms}ms`}`);

let running = false;

function postDatabase(use: () => FirstRunRouteDeps) {
  return async (c: Context) => {
    const deps = use();
    if (!(await stillNew(deps))) return sendMessage(c, "setup", 404, "Not here", "This screen is only for a new Engine.");
    const s = session(c, deps);
    if (!s) return sendMessage(c, "setup", 401, "Claim this Engine first", "Open /setup with the one-time code from the app's log.");
    if (!sameSite(c) || !isFormPost(c)) return sendMessage(c, "setup", 403, "Not accepted", "Send this form from the page itself.");
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      return sendMessage(c, "setup", 400, "Not accepted", "The form could not be read.");
    }
    if (!tokenOk(form["csrf"], claimFormToken(s.cookie, "database"))) {
      return sendMessage(c, "setup", 403, "Not accepted", "This form is out of date. Open the page again.");
    }
    const owner = String(form["owner_email"] ?? "").trim().toLowerCase();
    const ref = String(form["ref"] ?? "").trim().toLowerCase();
    const errors = [
      ...(isEmail(owner) ? [] : ["Your email is not a plain email address."]),
      ...(REF_PATTERN.test(ref) ? [] : ["The project ref is the 20 letters and digits in the project's address."]),
      ...(deps.projectRef && ref === deps.projectRef ? [] : ["That is not the project this app is deployed with (its SUPABASE_URL)."]),
    ];
    const files = deps.files();
    if (!files) errors.push("This app was built without the repository's SQL files, so it cannot set up the database itself. Use `kbe db migrate`.");
    if (errors.length > 0) {
      return page(c, 400, "Database", errors.map((e) => notice("error", e)).join("") + databaseForm(deps, s.cookie, { ref, owner }));
    }
    if (running) return sendMessage(c, "setup", 409, "Already running", "The database is being set up right now. Wait a minute, then open this page again.");
    running = true;
    try {
      let mgmt;
      try {
        mgmt = createMgmt(String(form["access_token"] ?? "").trim(), ref, deps.fetch);
      } catch (err) {
        const text = err instanceof MgmtError ? err.message : "That token was not accepted.";
        return page(c, 400, "Database", notice("error", text) + databaseForm(deps, s.cookie, { ref, owner }));
      }
      const result = await runDbSetup({
        mgmt,
        ownerEmail: owner,
        bootCode: deps.boot().original() ?? "",
        jwtSecret: deps.jwtSecret,
        anonKey: deps.anonKey,
        kbSchema: deps.kbSchema,
        files: files as SqlFiles,
      });
      const totalMs = result.steps.reduce((sum, x) => sum + (x.ms ?? 0), 0);
      logger.info({ ok: result.ok, total_ms: totalMs, steps: timed(result.steps) }, "first run: database setup finished");
      if (!result.ok) {
        // 422, not 502: DigitalOcean's edge replaces an app's 502 with its own page.
        return page(c, 422, "Database", notice("error", "Setup stopped. Fix what the table says, then run it again: finished steps are not repeated.") + card(stepsTable(result.steps)) + databaseForm(deps, s.cookie, { ref, owner }));
      }
      deps.boot().setOwner(owner);
      deps.onDatabaseReady();
      lastResult = result.steps;
      return page(c, 200, "Database is ready", doneView(result.steps));
    } finally {
      running = false;
    }
  };
}

export function makeFirstRunRoutes(use: () => FirstRunRouteDeps): Hono {
  const app = new Hono();
  app.post("/claim", async (c) => {
    const deps = use();
    if (!(await stillNew(deps))) return sendMessage(c, "setup", 404, "Not here", "This Engine does not use a first-run code.");
    if (!sameSite(c) || !isFormPost(c)) return sendMessage(c, "setup", 403, "Not accepted", "Send this form from the page itself.");
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    return doClaim(c, deps, (form as Record<string, unknown>)["code"]);
  });
  app.get("/database", getDatabase(use));
  app.post("/database", postDatabase(use));
  return app;
}
