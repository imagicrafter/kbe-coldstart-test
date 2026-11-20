import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The first-run claim (Phase 10 build order, Step D).
 *
 * A fresh Engine has no sign-in yet, so nobody can be checked. On boot it
 * makes a random one-time code and writes it once to its own log (the
 * DigitalOcean run log, which only the person who deployed the app can read).
 * Whoever opens /setup?code=<that code> claims the app, then names its owner
 * on the Database screen.
 *
 * SINGLE USE: a claim spends the code in this process. From then on the
 * claimant carries a signed cookie (claim session), not the code. A restart
 * before setup finishes makes a new code; once an owner is stored in the
 * database, a later claim must name that same owner.
 *
 * LOCKOUT, per client: five wrong codes from one client (CF-Connecting-IP,
 * else the first X-Forwarded-For address) lock that client out for an hour,
 * so a stranger cannot lock the owner out. A global ceiling (100 wrong codes
 * in 15 minutes from anyone) locks claiming for everyone as a backstop. The
 * per-client table is bounded (oldest dropped first). All of it lives in this
 * process: RESTARTING THE APP RESETS EVERY LOCK (and makes a new code).
 * (The database lockout of 0034 cannot be used: on first boot the database
 * may hold no tables yet.)
 *
 * ONE INSTANCE during setup: each instance makes its own code and holds its
 * own claim. The deploy file runs one.
 */

export const CLAIM_COOKIE = "kbe_claim";
const SESSION_MS = 2 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 60 * 60 * 1000;
const GLOBAL_MAX_FAILURES = 100;
const MAX_CLIENTS = 1000;

type ClientState = { readonly failures: readonly number[]; readonly lockedUntil: number };

export type ClaimResult =
  | { readonly ok: true; readonly cookie: string }
  | { readonly ok: false; readonly reason: "none" | "spent" | "locked" | "wrong"; readonly retryAfterSeconds: number };

export type ClaimSession = { readonly expiresAt: number; readonly cookie: string };

export type BootCode = {
  /** The code, while it is still unspent. Never put in a page or a log line by callers. */
  readonly peek: () => string | undefined;
  /** The code this process was started with, spent or not (for the setup steps' own checks). */
  readonly original: () => string | undefined;
  /** `client` names who is asking (an IP address); unknown callers share one bucket. */
  readonly claim: (submitted: unknown, client?: string) => ClaimResult;
  readonly session: (cookie: string | undefined) => ClaimSession | null;
  /** The owner named on the Database screen, once the database stored them. */
  readonly claimedOwner: () => string | null;
  readonly setOwner: (email: string) => void;
};

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

function equal(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function newCode(): string {
  return randomBytes(24).toString("base64url");
}

export function createBootCode(code: string | undefined, now: () => number = Date.now): BootCode {
  const key = randomBytes(32);
  let spent = false;
  let owner: string | null = null;
  let globalFailures: number[] = [];
  let globalLockedUntil = 0;
  let clients = new Map<string, ClientState>();

  const remember = (who: string, state: ClientState): void => {
    const next = new Map(clients);
    next.delete(who);
    next.set(who, state);
    while (next.size > MAX_CLIENTS) {
      const oldest = next.keys().next().value as string;
      next.delete(oldest);
    }
    clients = next;
  };

  const sign = (payload: string): string => createHmac("sha256", key).update(payload).digest("base64url");

  const claim = (submitted: unknown, client = "unknown"): ClaimResult => {
    const t = now();
    if (!code) return { ok: false, reason: "none", retryAfterSeconds: 0 };
    const who = client.slice(0, 64) || "unknown";
    const mine = clients.get(who) ?? { failures: [], lockedUntil: 0 };
    const lockedUntil = Math.max(globalLockedUntil, mine.lockedUntil);
    if (lockedUntil > t) {
      return { ok: false, reason: "locked", retryAfterSeconds: Math.ceil((lockedUntil - t) / 1000) };
    }
    const given = typeof submitted === "string" ? submitted.trim() : "";
    const plausible = given.length > 0 && given.length <= 256;
    const matches = equal(plausible ? given : "", code);
    if (!plausible || !matches) {
      globalFailures = [...globalFailures.filter((f) => t - f < FAILURE_WINDOW_MS), t];
      if (globalFailures.length >= GLOBAL_MAX_FAILURES) {
        globalLockedUntil = t + LOCK_MS;
        globalFailures = [];
      }
      const failures = [...mine.failures.filter((f) => t - f < FAILURE_WINDOW_MS), t];
      const locked = failures.length >= MAX_FAILURES;
      remember(who, locked ? { failures: [], lockedUntil: t + LOCK_MS } : { failures, lockedUntil: 0 });
      return locked || globalLockedUntil > t
        ? { ok: false, reason: "locked", retryAfterSeconds: LOCK_MS / 1000 }
        : { ok: false, reason: "wrong", retryAfterSeconds: 0 };
    }
    if (spent) return { ok: false, reason: "spent", retryAfterSeconds: 0 };
    spent = true;
    const payload = `claimed|${t + SESSION_MS}|${randomBytes(9).toString("base64url")}`;
    return { ok: true, cookie: `${Buffer.from(payload).toString("base64url")}.${sign(payload)}` };
  };

  const session = (cookie: string | undefined): ClaimSession | null => {
    if (!cookie || cookie.length > 1024 || !spent) return null;
    const [body, mac] = cookie.split(".");
    if (!body || !mac) return null;
    const payload = Buffer.from(body, "base64url").toString("utf8");
    const want = sign(payload);
    if (mac.length !== want.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
    const [kind, exp] = payload.split("|");
    const expiresAt = Number(exp);
    if (kind !== "claimed" || !Number.isFinite(expiresAt) || expiresAt <= now()) return null;
    return { expiresAt, cookie };
  };

  return {
    peek: () => (spent ? undefined : code),
    original: () => code,
    claim,
    session,
    claimedOwner: () => owner,
    setOwner: (email) => {
      owner = email;
    },
  };
}

/** The cookie header value that sets (or clears) the claim session. */
export function claimCookie(value: string | null, secure: boolean): string {
  const flags = `Path=/setup; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  return value === null
    ? `${CLAIM_COOKIE}=; Max-Age=0; ${flags}`
    : `${CLAIM_COOKIE}=${value}; Max-Age=${SESSION_MS / 1000}; ${flags}`;
}

/** Read one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}
