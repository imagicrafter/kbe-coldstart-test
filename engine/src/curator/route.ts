import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../log/logger.js";
import { liveBackupStore, runBackup } from "../backup/run.js";
import { embedText } from "../supabase.js";
import { runTick, type TickDeps, type TickMode } from "./run.js";
import { store as defaultStore } from "./store.js";

/**
 * POST /internal/curator/tick, the address Supabase cron pokes (test A3:
 * pg_cron + pg_net, secret kept in Vault).
 *
 * Guarded by a shared secret in the X-Kbe-Tick header. The service never
 * holds the secret: it hands what arrived to curator_tick_secret_ok, which
 * compares it with the vault copy. Wrong or missing: 401 with no detail.
 *
 * The run is started and the call answered at once (202), because pg_net
 * gives up after a few seconds and would record a long run as a failure.
 * A second poke while a run is going answers 200 {busy: true}.
 */

export const TICK_PATH = "/internal/curator/tick";
export const TICK_HEADER = "x-kbe-tick";

const Body = z.object({ mode: z.enum(["tick", "batch"]).default("tick") }).strict();

export type TickRouteDeps = {
  readonly checkSecret: (secret: string) => Promise<boolean>;
  readonly start: (mode: TickMode) => Promise<unknown>;
};

const defaultTickDeps: TickDeps = {
  store: defaultStore,
  embed: embedText,
  backup: () => runBackup({ store: liveBackupStore, fetch: (url, init) => fetch(url, init) }),
};

export const defaultRouteDeps: TickRouteDeps = {
  checkSecret: (secret) => defaultStore.tickSecretOk(secret),
  start: (mode) => runTick(mode, defaultTickDeps),
};

export function makeTickRoute(deps: TickRouteDeps = defaultRouteDeps): Hono {
  const app = new Hono();
  let running = false;

  app.post("/", async (c) => {
    const secret = c.req.header(TICK_HEADER) ?? "";
    let ok = false;
    try {
      ok = secret.length >= 32 && secret.length <= 512 && (await deps.checkSecret(secret));
    } catch {
      return c.json({ error: { code: "unavailable", message: "Unavailable" } }, 503);
    }
    if (!ok) return c.json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);

    const raw = await c.req.json().catch(() => ({}));
    const parsed = Body.safeParse(raw ?? {});
    if (!parsed.success) return c.json({ error: { code: "invalid_argument", message: "Bad body" } }, 400);

    if (running) return c.json({ busy: true }, 200);
    running = true;
    void deps
      .start(parsed.data.mode)
      .catch((err: unknown) =>
        logger.error({ error: err instanceof Error ? err.message : "error" }, "curator tick failed"),
      )
      .finally(() => {
        running = false;
      });
    return c.json({ started: true, mode: parsed.data.mode }, 202);
  });

  return app;
}
