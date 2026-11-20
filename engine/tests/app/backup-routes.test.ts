import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { makeBackupRoutes } from "../../src/app/backup-routes.js";
import { AppDeniedError } from "../../src/app/store.js";
import { _captureLogsForTests } from "../../src/log/logger.js";
import { ASSERT, client, createScreens, csrfIn } from "./fakes.js";

function world(over: Parameters<typeof createScreens>[0] = {}) {
  const screens = createScreens(over);
  const app = new Hono();
  app.route("/setup", makeBackupRoutes(() => screens.deps));
  return { ...screens, http: client(app) };
}

describe("the Backup screen", () => {
  it("refuses no sign-in, a reader and a stranger", async () => {
    const w = world();
    expect((await w.http.get("/setup/backup")).status).toBe(401);
    expect((await w.http.get("/setup/backup", ASSERT.reader)).status).toBe(403);
    expect((await w.http.get("/setup/backup", ASSERT.stranger)).status).toBe(403);
  });

  it("shows the state and the one-way warning, with no script", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/backup", ASSERT.owner)).text();
    expect(html).toContain("private");
    expect(html).toMatch(/one way/i);
    expect(html).toMatch(/Token saved<\/td><td>no/);
    expect(html).not.toMatch(/<script/i);
  });

  it("an administrator who is not the owner gets 'No access' (the database refuses)", async () => {
    const w = world();
    const denied = async () => {
      throw new AppDeniedError("not allowed");
    };
    w.fake.store.backup = denied;
    expect((await w.http.get("/setup/backup", ASSERT.owner)).status).toBe(403);
  });

  it("stores the token in the vault and never shows or logs it", async () => {
    const w = world();
    const token = "github_pat_SECRET_0123456789abcdef";
    const csrf = csrfIn(await (await w.http.get("/setup/backup", ASSERT.owner)).text());
    const logs = _captureLogsForTests();
    try {
      const res = await w.http.post("/setup/backup/token", { csrf, backup_token: token }, ASSERT.owner);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(token);
      expect(logs.lines().join("\n")).not.toContain(token);
    } finally {
      logs.stop();
    }
    expect(w.fake.state.backupToken).toBe(token);
    const after = await (await w.http.get("/setup/backup", ASSERT.owner)).text();
    expect(after).toMatch(/Token saved<\/td><td>yes/);
    expect(after).not.toContain(token);
  });

  it("refuses a token with spaces without echoing it", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/backup", ASSERT.owner)).text());
    const res = await w.http.post("/setup/backup/token", { csrf, backup_token: "two words token" }, ASSERT.owner);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("two words token");
  });

  it("saves the repository and switches the backup on once a token is saved", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/backup", ASSERT.owner)).text());
    const early = await w.http.post("/setup/backup", { csrf, repo: "acme/kb-backup", branch: "main", enabled: "yes" }, ASSERT.owner);
    expect(early.status).toBe(400);
    expect(await early.text()).toMatch(/token/);
    await w.http.post("/setup/backup/token", { csrf, backup_token: "github_pat_0123456789abcdef" }, ASSERT.owner);
    const res = await w.http.post("/setup/backup", { csrf, repo: "acme/kb-backup", branch: "", enabled: "yes" }, ASSERT.owner);
    expect(res.status).toBe(200);
    expect(w.fake.state.backup).toMatchObject({ repo: "acme/kb-backup", branch: "main", enabled: true });
  });

  it("refuses a bad repository or branch before the database", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/backup", ASSERT.owner)).text());
    for (const form of [{ repo: "https://github.com/acme/kb" }, { repo: "acme/kb", branch: "../main" }, { repo: "acme/kb", branch: "a b" }]) {
      const res = await w.http.post("/setup/backup", { csrf, branch: "main", ...form }, ASSERT.owner);
      expect(res.status).toBe(400);
    }
    expect(w.fake.calls.filter((c) => c.fn === "setBackup")).toHaveLength(0);
  });

  it("needs the page's own form token", async () => {
    const w = world();
    const res = await w.http.post("/setup/backup/now", { csrf: "forged" }, ASSERT.owner);
    expect(res.status).toBe(403);
    expect(w.fake.calls.filter((c) => c.fn === "requestBackup")).toHaveLength(0);
    const csrf = csrfIn(await (await w.http.get("/setup/backup", ASSERT.owner)).text());
    expect((await w.http.post("/setup/backup/now", { csrf }, ASSERT.owner)).status).toBe(200);
  });
});
