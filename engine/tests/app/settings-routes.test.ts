import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeSettingsRoutes } from "../../src/app/settings-routes.js";
import { _captureLogsForTests } from "../../src/log/logger.js";
import { ASSERT, OWNER, client, createScreens, csrfIn } from "./fakes.js";

function world() {
  const screens = createScreens();
  const app = new Hono();
  app.route("/setup", makeSettingsRoutes(() => screens.deps));
  return { ...screens, http: client(app) };
}

const SCREENS = ["/setup/people", "/setup/template", "/setup/model", "/setup/timer", "/setup/health"];

describe("settings screens: administrators only", () => {
  it.each(SCREENS)("%s refuses no sign-in, a reader, and a stranger", async (path) => {
    const w = world();
    expect((await w.http.get(path)).status).toBe(401);
    expect((await w.http.get(path, ASSERT.reader)).status).toBe(403);
    expect((await w.http.get(path, ASSERT.stranger)).status).toBe(403);
  });

  it.each(SCREENS)("%s opens for the owner", async (path) => {
    const w = world();
    const res = await w.http.get(path, ASSERT.owner);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toMatch(/<script/i);
  });

  it("refuses a post from a reader even with a token made for them", async () => {
    const w = world();
    const csrf = w.deps.csrf.token("reader@example.com", "model");
    const res = await w.http.post("/setup/model", { csrf, model_key: "k".repeat(40) }, ASSERT.reader);
    expect(res.status).toBe(403);
    expect(w.fake.state.modelKey).toBeNull();
  });
});

describe("the model key", () => {
  it("goes to the vault and is never shown or logged", async () => {
    const w = world();
    const key = "do-model-key-SECRET-0123456789abcdef";
    const csrf = csrfIn(await (await w.http.get("/setup/model", ASSERT.owner)).text());
    const logs = _captureLogsForTests();
    try {
      const res = await w.http.post("/setup/model", { csrf, model_key: key }, ASSERT.owner);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(key);
      expect(w.fake.state.modelKey).toBe(key);
      expect(logs.lines().join("\n")).not.toContain(key);
    } finally {
      logs.stop();
    }
    const after = await (await w.http.get("/setup/model", ASSERT.owner)).text();
    expect(after).toMatch(/Key stored: <strong>yes/);
    expect(after).not.toContain(key);
    expect(after).not.toMatch(/value="do-model/);
  });

  it("refuses a key with spaces or too short, without echoing it", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/model", ASSERT.owner)).text());
    const res = await w.http.post("/setup/model", { csrf, model_key: "two words here" }, ASSERT.owner);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("two words here");
    expect(w.fake.state.modelKey).toBeNull();
  });
});

describe("the template", () => {
  it("shows every choosable template and saves the chosen ones", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/template", ASSERT.owner)).text();
    expect(html).toContain('value="consulting"');
    expect(html).toContain('value="property"');
    expect(html).not.toContain('value="base"');
    const res = await w.http.post("/setup/template", { csrf: csrfIn(html), template: ["consulting", "property"] }, ASSERT.owner);
    expect(res.status).toBe(200);
    expect(w.fake.state.templates).toEqual(["consulting", "property"]);
  });

  it("refuses a name that is not a template", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/template", ASSERT.owner)).text());
    const res = await w.http.post("/setup/template", { csrf, template: ["../etc"] }, ASSERT.owner);
    expect(res.status).toBe(400);
    expect(w.fake.state.templates).toEqual([]);
  });
});

describe("topics and people", () => {
  it("adds a topic", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/people", ASSERT.owner)).text());
    expect((await w.http.post("/setup/people/topic", { csrf, topic: "deals", label: "Deals" }, ASSERT.owner)).status).toBe(200);
    expect((await w.http.post("/setup/people/topic", { csrf, topic: "Bad Topic", label: "x" }, ASSERT.owner)).status).toBe(400);
    expect(w.fake.calls.filter((c) => c.fn === "addTopic")).toHaveLength(1);
  });

  it("previews a person add, then applies only with the returned code", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/people", ASSERT.owner)).text());
    const fields = { csrf, action: "add", email: "new@example.com", display_name: "New", role: "reader" };
    const preview = await w.http.post("/setup/people/change", fields, ASSERT.owner);
    const html = await preview.text();
    expect(html).toContain("Add reader@example.com as a reader.");
    expect(html).toContain(`name="confirm_code" value="${"f".repeat(32)}"`);
    const first = w.fake.calls.find((c) => c.fn === "twoStep")?.args[1] as { confirmCode?: string };
    expect(first.confirmCode).toBeUndefined();

    const apply = await w.http.post("/setup/people/change", { ...fields, csrf: csrfIn(html), confirm_code: "f".repeat(32) }, ASSERT.owner);
    expect(apply.status).toBe(200);
    const second = w.fake.calls.filter((c) => c.fn === "twoStep")[1]?.args[1] as { fn: string; confirmCode?: string };
    expect(second).toMatchObject({ fn: "admin_person_add", confirmCode: "f".repeat(32) });
  });

  it("validates grant fields", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/people", ASSERT.owner)).text());
    expect((await w.http.post("/setup/people/change", { csrf, action: "grant", email: "not an email", topic: "x" }, ASSERT.owner)).status).toBe(400);
    expect((await w.http.post("/setup/people/change", { csrf, action: "grant", email: "a@example.com", topic: "x", confirm_code: "zz" }, ASSERT.owner)).status).toBe(400);
  });
});

describe("the timer", () => {
  it("suggests the Engine's own tick address and saves it", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/timer", ASSERT.owner)).text();
    expect(html).toContain('value="https://engine.example.com/internal/curator/tick"');
    expect(html).toMatch(/bypass/);
    const res = await w.http.post("/setup/timer", { csrf: csrfIn(html), engine_url: "https://engine.example.com/internal/curator/tick", every: "15", enabled: "yes" }, ASSERT.owner);
    expect(res.status).toBe(200);
    expect(w.fake.calls.find((c) => c.fn === "setTimer")?.args).toEqual([OWNER, "engine.example.com", 15, true]);
  });

  it("refuses another address or interval", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/timer", ASSERT.owner)).text());
    expect((await w.http.post("/setup/timer", { csrf, engine_url: "https://evil.example.com/steal", every: "5" }, ASSERT.owner)).status).toBe(400);
    expect((await w.http.post("/setup/timer", { csrf, engine_url: "https://evil.example.com/internal/curator/tick", every: "5", enabled: "yes" }, ASSERT.owner)).status).toBe(400);
    expect(w.fake.calls.some((c) => c.fn === "setTimer")).toBe(false);
    expect((await w.http.post("/setup/timer", { csrf, engine_url: "https://engine.example.com/internal/curator/tick", every: "1" }, ASSERT.owner)).status).toBe(400);
  });

  it("a test poke that Cloudflare stops says to add the bypass", async () => {
    const w = world();
    const csrf = csrfIn(await (await w.http.get("/setup/timer", ASSERT.owner)).text());
    const res = await w.http.post("/setup/timer/test", { csrf }, ASSERT.owner);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/setup/timer?test=42");
    const html = await (await w.http.get("/setup/timer?test=42", ASSERT.owner)).text();
    expect(html).toMatch(/Cloudflare sign-in stopped the poke \(302\)/);
  });
});

describe("health", () => {
  it("lists the checks and the connector address", async () => {
    const w = world();
    const html = await (await w.http.get("/setup/health", ASSERT.owner)).text();
    expect(html).toContain("https://engine.example.com/mcp");
    expect(html).toContain("0054_app_screens.sql");
    expect(html).toMatch(/Model key<\/td><td>not set/);
  });

  it("shows a failing embed check without breaking the page", async () => {
    const w = createScreens({ embedCheck: async () => { throw new Error("down"); } });
    const app = new Hono();
    app.route("/setup", makeSettingsRoutes(() => w.deps));
    const html = await (await client(app).get("/setup/health", ASSERT.owner)).text();
    expect(html).toMatch(/Needs work<\/td><td>Embedding/);
  });
});
