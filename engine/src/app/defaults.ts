import { invalidateSettings } from "../config/settings.js";
import { env } from "../env.js";
import { setupDeps } from "../setup/defaults.js";
import { currentMode } from "../setup/mode.js";
import { embedText } from "../supabase.js";
import { createCsrf } from "./csrf.js";
import { findRepoDir, repoSqlFiles } from "./db-setup.js";
import { bootCode } from "./first-run.js";
import type { FirstRunRouteDeps } from "./first-run-routes.js";
import { refFromUrl } from "./mgmt.js";
import type { SettingsDeps } from "./settings-routes.js";
import { liveStore } from "./store.js";

/** The app screens' real dependencies, read on every request. */

const csrf = createCsrf(env.SUPABASE_JWT_SECRET);

const liveScreens = (): SettingsDeps => ({
  mode: currentMode,
  guard: setupDeps().guard,
  store: liveStore,
  csrf,
  now: Date.now,
  embedCheck: async () => (await embedText("health check")).length > 0,
});

const liveFirstRun = (): FirstRunRouteDeps => ({
  boot: bootCode,
  envCode: env.SETUP_CODE,
  mode: currentMode,
  projectRef: refFromUrl(env.SUPABASE_URL),
  kbSchema: env.KB_SCHEMA,
  jwtSecret: env.SUPABASE_JWT_SECRET,
  anonKey: env.SUPABASE_ANON_KEY,
  files: () => {
    const dir = findRepoDir();
    return dir ? repoSqlFiles(dir) : null;
  },
  // The process-wide fetch, which the outbound allowlist limits; the first
  // run adds api.supabase.com to it (first-run.ts).
  fetch: (url, init) => fetch(url, init),
  onDatabaseReady: invalidateSettings,
});

let screens: () => SettingsDeps = liveScreens;
let firstRun: () => FirstRunRouteDeps = liveFirstRun;

export const screenDeps = (): SettingsDeps => screens();
export const firstRunDeps = (): FirstRunRouteDeps => firstRun();

/** Tests only: replace some dependencies; pass nothing to restore them. */
export function _setAppDepsForTests(over?: {
  screens?: Partial<SettingsDeps>;
  firstRun?: Partial<FirstRunRouteDeps>;
}): void {
  screens = over?.screens ? () => ({ ...liveScreens(), ...over.screens }) : liveScreens;
  firstRun = over?.firstRun ? () => ({ ...liveFirstRun(), ...over.firstRun }) : liveFirstRun;
}
