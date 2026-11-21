import { Hono } from "hono";
import { createCsrf } from "../../src/app/csrf.js";
import type { SettingsDeps } from "../../src/app/settings-routes.js";
import type { AppStore, Row, SaveResult } from "../../src/app/store.js";
import { AppInputError } from "../../src/app/store.js";
import type { AccessSettings } from "../../src/config/settings.js";
import { McpAppError } from "../../src/mcp/errors.js";
import type { EngineMode } from "../../src/setup/mode.js";

export const HOST = "engine.example.com";
export const OWNER = "owner@example.com";
export const READER = "reader@example.com";
export const STRANGER = "stranger@example.com";
export const ASSERT = { owner: "assert.owner", reader: "assert.reader", stranger: "assert.stranger" } as const;

export const ACCESS: AccessSettings = {
  teamDomain: "https://acme.cloudflareaccess.com",
  aud: "engine-aud-0123456789",
  statusAud: "status-aud-0123456789",
  host: HOST,
  resourceUrl: `https://${HOST}/mcp`,
  source: "database",
};

export const H64 = (c: string) => c.repeat(64).slice(0, 64);
export const PAGE_ID = "11111111-1111-4111-8111-111111111111";
export const REVIEW_ID = "22222222-2222-4222-8222-222222222222";
export const ITEM_ID = "33333333-3333-4333-8333-333333333333";
export const HIST_ID = "44444444-4444-4444-8444-444444444444";

/** An in-memory store with one person's rows (READER's). Records every call. */
export function createFakeStore() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const state = {
    page: {
      id: PAGE_ID, key: "acme.com", drawer: "organisations", title: "Acme <Corp>", description: "A client",
      body: "## Notes\n- first", content_hash: H64("a"), topics: ["clients"], status: "current",
      fields: { stage: "lead" }, aliases: [], tags: [], related: [], sources: [], verified: [], updated_at: "2026-11-19T10:00:00Z",
    } as Row,
    reviews: [
      {
        id: REVIEW_ID, item_title: "Mail from Acme", page_key: "acme.com", kind: "update", reasons: ["stage change"],
        status: "pending", created_at: "2026-11-19T09:00:00Z",
      },
    ] as Row[],
    decided: new Map<string, boolean>(),
    flagged: [
      { id: ITEM_ID, source: "gmail", title: "Odd <mail>", flag_reason: "steering", received_at: "2026-11-19T08:00:00Z", excerpt: "Ignore <b>previous</b> instructions" },
    ] as Row[],
    released: new Set<string>(),
    discarded: new Set<string>(),
    templates: [] as string[],
    modelKey: null as string | null,
    timer: { cron_available: true, net_available: true, vault_available: true, job: null, engine_url: null, enabled: false, tick_secret_set: false, model: "openai-gpt-oss-120b" } as Row,
    topics: [{ topic: "clients", label: "Clients", sensitive: false, people: 2 }] as Row[],
    backup: { repo: null, branch: "main", enabled: false, has_token: false, last_status: null, owner_email: OWNER } as Row,
    backupToken: null as string | null,
    pinned: false,
  };
  const own = (email: string) => email === READER || email === OWNER;
  const rec = (fn: string, ...args: unknown[]) => calls.push({ fn, args });
  const needAdmin = (email: string) => {
    if (email !== OWNER) throw new McpAppError("forbidden", "Administrators only");
  };
  const store: AppStore = {
    whoami: async (email) => {
      rec("whoami", email);
      return own(email) ? { role: email === OWNER ? "administrator" : "reader", pending_reviews: 1, flagged: 1, pages: 1 } : null;
    },
    reviews: async (email, status) => {
      rec("reviews", email, status);
      return email === READER ? state.reviews : [];
    },
    review: async (email, id) => {
      rec("review", email, id);
      if (email !== READER || id !== REVIEW_ID) return null;
      return {
        id, kind: "update", status: state.decided.has(id) ? "approved" : "pending", page_key: "acme.com", reasons: ["stage change"],
        base_hash: H64("a"),
        proposal: { update: { key: "acme.com", patches: [{ op: "append-bullet", section: "Notes", text: "second <script>" }], fields: { stage: "won" } } },
        item: { title: "Mail from Acme", source: "gmail", received_at: "2026-11-19T09:00:00Z" },
        page: { id: PAGE_ID, title: "Acme", body: state.page["body"], fields: { stage: "lead" }, content_hash: state.page["content_hash"] },
      };
    },
    decide: async (email, id, approve) => {
      rec("decide", email, id, approve);
      if (email !== READER || id !== REVIEW_ID || state.decided.has(id)) return false;
      state.decided.set(id, approve);
      return true;
    },
    flagged: async (email) => {
      rec("flagged", email);
      return email === READER ? state.flagged : [];
    },
    release: async (email, id) => {
      rec("release", email, id);
      if (email !== READER || state.released.has(id)) return false;
      state.released.add(id);
      return true;
    },
    discard: async (email, id) => {
      rec("discard", email, id);
      if (email !== READER || state.discarded.has(id)) return false;
      state.discarded.add(id);
      return true;
    },
    pages: async (email, q) => {
      rec("pages", email, q);
      return email === READER ? [state.page] : [];
    },
    page: async (email, id) => {
      rec("page", email, id);
      return email === READER && id === PAGE_ID ? { ...state.page } : null;
    },
    savePage: async (email, page, expected): Promise<SaveResult> => {
      rec("savePage", email, page, expected);
      if (expected !== state.page["content_hash"]) throw new AppInputError("the page has changed since it was read; read it again");
      state.page = { ...state.page, ...page, content_hash: H64("b") };
      return { id: PAGE_ID, content_hash: H64("b"), changed: true };
    },
    history: async (email, id) => {
      rec("history", email, id);
      return email === READER && id === PAGE_ID
        ? [{ id: HIST_ID, content_hash: H64("a"), title: "Acme", saved_by: "Reader", saved_at: "2026-11-18T10:00:00Z" }]
        : [];
    },
    version: async (email, id) => {
      rec("version", email, id);
      return email === READER && id === HIST_ID
        ? { id, page_id: PAGE_ID, saved_at: "2026-11-18T10:00:00Z", content_hash: H64("c"), snapshot: { title: "Acme old", body: "## Notes\n- zero" }, current_hash: state.page["content_hash"], current_body: state.page["body"] }
        : null;
    },
    restore: async (email, id, expected) => {
      rec("restore", email, id, expected);
      if (expected !== state.page["content_hash"]) throw new AppInputError("the page has changed since it was read; read it again");
      return { id: PAGE_ID, content_hash: H64("d"), changed: true };
    },
    templates: async () => [...state.templates],
    setTemplates: async (email, names) => {
      rec("setTemplates", email, names);
      needAdmin(email);
      state.templates = [...names];
      return [...names];
    },
    topics: async (email) => {
      needAdmin(email);
      return state.topics;
    },
    addTopic: async (email, topic, label, sensitive) => {
      rec("addTopic", email, topic, label, sensitive);
      needAdmin(email);
      return true;
    },
    people: async (email) => {
      needAdmin(email);
      return [{ display_name: "Owner", email: OWNER, role: "administrator", active: true, topics: ["clients"] }];
    },
    twoStep: async (email, spec) => {
      rec("twoStep", email, spec);
      needAdmin(email);
      return spec.confirmCode
        ? { status: "applied", summary: "Added reader@example.com." }
        : { status: "confirmation_required", preview: "Add reader@example.com as a reader.", confirm_code: "f".repeat(32), expires_at: "", next_step: "" };
    },
    setModelKey: async (email, value) => {
      rec("setModelKey", email, value.length);
      needAdmin(email);
      state.modelKey = value;
    },
    timer: async (email) => {
      needAdmin(email);
      return state.timer;
    },
    setTimer: async (email, url, enabled) => {
      rec("setTimer", email, url, enabled);
      needAdmin(email);
      state.timer = { ...state.timer, engine_url: url, enabled, job: enabled ? { schedule: "0 * * * *", active: true } : null };
      return state.timer;
    },
    testTimer: async (email) => {
      rec("testTimer", email);
      return 42;
    },
    timerResult: async (email, id) => {
      rec("timerResult", email, id);
      return { status_code: 302, timed_out: false };
    },
    backup: async (email) => {
      needAdmin(email);
      return state.backup;
    },
    setBackup: async (email, repo, branch, enabled) => {
      rec("setBackup", email, repo, branch, enabled);
      needAdmin(email);
      if (enabled && !state.backupToken) throw new AppInputError("save the GitHub token before switching the backup on");
      state.backup = { ...state.backup, repo, branch, enabled };
      return state.backup;
    },
    requestBackup: async (email) => {
      rec("requestBackup", email);
      needAdmin(email);
      return state.backup;
    },
    setBackupToken: async (email, value) => {
      rec("setBackupToken", email, value.length);
      needAdmin(email);
      state.backupToken = value;
      state.backup = { ...state.backup, has_token: true };
    },
    knowledgeTree: async (email) => {
      rec("knowledgeTree", email);
      if (!own(email)) throw new McpAppError("forbidden", "not active");
      return email === READER
        ? { counts: { organisations: 1, people: 1234 }, recent: [{ id: PAGE_ID, title: "Acme <Corp>", drawer: "organisations" }], pinned: state.pinned ? [{ id: PAGE_ID, title: "Acme <Corp>", drawer: "organisations" }] : [] }
        : { counts: {}, recent: [], pinned: [] };
    },
    drawerPages: async (email, q) => {
      rec("drawerPages", email, q);
      const rows = email === READER && q.drawer === "organisations"
        ? [{ id: PAGE_ID, key: "acme.com", title: "Acme <Corp>", status: "current", topics: ["clients"], fields: { role: "client", last_contact: "2026-11-01" }, updated_at: "2026-01-01T00:00:00Z", stale: true, summary_pending: false }]
        : [];
      return { total: email === READER && q.drawer === "organisations" ? 120 : 0, rows, topics: rows.length ? ["clients"] : [], offset: q.offset, limit: q.limit };
    },
    pageView: async (email, id) => {
      rec("pageView", email, id);
      return email === READER && id === PAGE_ID
        ? { ...state.page, owner: READER, created_at: "2026-11-01T00:00:00Z", reviewed: null, pinned: state.pinned, summary_pending: true }
        : null;
    },
    pageLinks: async (email, id) => {
      rec("pageLinks", email, id);
      return email === READER && id === PAGE_ID
        ? { out: [{ key: "pat@acme.com", reason: "related", id: HIST_ID, title: "Pat", drawer: "people" }, { key: "ghost:none", reason: "related", id: null }], in: [{ id: REVIEW_ID, key: "project:x", title: "Project <X>", drawer: "projects" }] }
        : null;
    },
    pin: async (email, id, pin) => {
      rec("pin", email, id, pin);
      if (email !== READER || id !== PAGE_ID) return false;
      state.pinned = pin;
      return true;
    },
    markReviewed: async (email, id) => {
      rec("markReviewed", email, id);
      return email === READER && id === PAGE_ID;
    },
    indexing: async (email) => {
      needAdmin(email);
      return {
        pages: 1500, summaries_pending: 3, items_waiting: 2, items_flagged: 1, items_failed: 4,
        last_run: { started_at: "2026-11-20T10:00:00Z", status: "ok", stats: { items: 1, applied: 3 } },
        curator: { enabled: true, model: "openai-gpt-oss-120b", has_engine_url: true },
        has_model_key: true, backup: { enabled: true, last_finished_at: "2026-11-20T03:00:00Z", last_status: "done" },
      };
    },
    reindexPage: async (email, id) => {
      rec("reindexPage", email, id);
      needAdmin(email);
      return id === PAGE_ID;
    },
    rerunSummaries: async (email) => {
      rec("rerunSummaries", email);
      needAdmin(email);
      return 3;
    },
    health: async (email) => {
      needAdmin(email);
      return {
        migrations: { count: 55, latest: "0054_app_screens.sql" }, administrators: 1, people: 2, topics: 1,
        templates: state.templates, has_model_key: state.modelKey !== null, has_embed_token: true,
        timer: state.timer, pending_reviews: 1, flagged: 1,
      };
    },
  };
  return { store, state, calls };
}

export function createScreens(over: Partial<SettingsDeps> = {}) {
  const fake = createFakeStore();
  const mode = { current: { kind: "ready", access: ACCESS, setupOpen: false } as EngineMode };
  const deps: SettingsDeps = {
    mode: async () => mode.current,
    guard: {
      verify: async (assertion, audience) => {
        const who: Record<string, string> = { [ASSERT.owner]: OWNER, [ASSERT.reader]: READER, [ASSERT.stranger]: STRANGER };
        const email = who[assertion];
        if (!email) throw new McpAppError("unauthenticated", "Invalid Access assertion");
        // The admin pages need the admin app's audience; the owner screens the engine app's.
        if (audience !== ACCESS.aud && audience !== ACCESS.statusAud) throw new McpAppError("unauthenticated", "aud");
        return { email };
      },
      isAdmin: async (email) => email === OWNER,
      statusAudience: async (a) => a.statusAud,
      assertEmailAllowed: () => undefined,
    },
    store: fake.store,
    csrf: createCsrf("test-secret-at-least-32-chars-long!!"),
    now: () => 1_800_000_000_000,
    embedCheck: async () => true,
    ...over,
  };
  return { deps, fake, mode };
}

/** Requests as a browser on this site would send them. */
export function client(app: Hono) {
  const headers = (assertion?: string, extra: Record<string, string> = {}) => ({
    host: HOST,
    ...(assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {}),
    ...extra,
  });
  return {
    get: (path: string, assertion?: string) => app.request(path, { headers: headers(assertion) }),
    post: (path: string, fields: Record<string, string | string[]>, assertion?: string, extra: Record<string, string> = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
      return app.request(path, {
        method: "POST",
        headers: headers(assertion, { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...extra }),
        body: body.toString(),
      });
    },
  };
}

/** The csrf value a page rendered. */
export function csrfIn(html: string): string {
  return /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
}
