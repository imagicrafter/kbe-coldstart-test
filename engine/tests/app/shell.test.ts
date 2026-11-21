import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { app } from "../../src/index.js";
import { makeOwnerRoutes } from "../../src/app/owner-routes.js";
import { appLayout } from "../../src/app/html.js";
import { chosenDrawers, folders, foldersHtml } from "../../src/app/knowledge.js";
import { drawerIcon } from "../../src/app/icons.js";
import { layout, infoPage } from "../../src/setup/page.js";
import { brandName } from "../../src/status/page.js";
import { ASSERT, PAGE_ID, client, createScreens } from "./fakes.js";

function world() {
  const screens = createScreens();
  const routes = new Hono();
  routes.route("/app", makeOwnerRoutes(() => screens.deps));
  return { ...screens, http: client(routes) };
}

const noScriptNoStyle = (html: string) => {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/\sstyle=/i);
  expect(html).not.toMatch(/\son[a-z]+=/i);
};

describe("the product name", () => {
  it("app and setup pages say Knowledge Base Engine, never AI Engine", () => {
    for (const html of [appLayout("app", "/app", "Home", ""), appLayout("setup", "/setup", "X", ""), layout("Set up", "")]) {
      expect(html).toContain("Knowledge Base Engine");
      expect(html).not.toContain("AI Engine");
    }
  });

  it("the dashboard brand drops the old and the new suffix", () => {
    expect(brandName("Acme's Knowledge Base Engine")).toBe("Acme");
    expect(brandName("Acme's AI Engine")).toBe("Acme");
  });
});

describe("the shared shell", () => {
  it("has a sidebar menu with icons, marks the current screen, and no script or inline style", () => {
    const html = appLayout("app", "/app/knowledge", "Knowledge", "<p>x</p>");
    expect(html).toContain('class="sidebar"');
    expect(html).toMatch(/<a class="nav-item active" href="\/app\/knowledge" aria-current="page"><svg/);
    expect(html).toContain('href="/app/reviews"');
    noScriptNoStyle(html);
  });

  it("setup screens use the same shell with the setup menu", () => {
    const html = layout("Set up sign-in", "<p>x</p>");
    expect(html).toContain('class="sidebar"');
    for (const href of ["/setup/people", "/setup/template", "/setup/timer", "/setup/health"]) expect(html).toContain(`href="${href}"`);
    noScriptNoStyle(html);
  });
});

describe("Cloudflare email obfuscation is switched off", () => {
  it("wraps the whole body of app and setup pages in email_off markers", () => {
    for (const html of [appLayout("app", "/app", "Home", "<p>pat@example.com</p>"), layout("t", "<p>pat@example.com</p>")]) {
      const on = html.indexOf("<!--email_off-->");
      const off = html.indexOf("<!--/email_off-->");
      const at = html.indexOf("pat@example.com");
      expect(on).toBeGreaterThan(html.indexOf("<body>"));
      expect(on).toBeLessThan(at);
      expect(off).toBeGreaterThan(at);
    }
  });

  it("the closed sign-in page, which shows the admin's email, is covered", () => {
    const html = infoPage({ host: "kb.example.com", level: null, source: "database", reason: "complete", email: "admin@example.com" } as never, "v");
    expect(html.indexOf("<!--email_off-->")).toBeLessThan(html.indexOf("admin@example.com"));
  });
});

describe("the Knowledge menu", () => {
  it("has a folder per drawer of base plus the chosen templates, with an icon each", () => {
    const base = chosenDrawers([]).map((d) => d.id);
    expect(base).toContain("people");
    expect(base).toContain("organisations");
    expect(chosenDrawers(["consulting", "no-such"]).length).toBeGreaterThan(base.length);
    expect(drawerIcon("people")).toBe("user");
    expect(drawerIcon("organisations")).toBe("building");
    expect(drawerIcon("deals")).toBe("dollar");
    expect(drawerIcon("unknown-thing")).toBe("folder");
  });

  it("counts pages per drawer and keeps a drawer that has pages but is no longer chosen", () => {
    const list = folders(chosenDrawers([]), [
      { drawer: "people" }, { drawer: "people" }, { drawer: "organisations" }, { drawer: "old-drawer" },
    ]);
    expect(list.find((f) => f.id === "people")?.count).toBe(2);
    expect(list.find((f) => f.id === "organisations")?.count).toBe(1);
    expect(list.find((f) => f.id === "old-drawer")?.count).toBe(1);
    const html = foldersHtml(list);
    expect(html).toContain('href="/app/knowledge/people"');
    expect(html).toContain("2 pages");
    expect(html).toContain("<svg");
  });

  it("GET /app/knowledge shows the drawers with counts", async () => {
    const w = world();
    const res = await w.http.get("/app/knowledge", ASSERT.reader);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/app/knowledge/organisations"');
    expect(html).toContain("1 page<");
    noScriptNoStyle(html);
  });

  it("GET /app/knowledge/:drawer lists the person's pages in that drawer", async () => {
    const w = world();
    const html = await (await w.http.get("/app/knowledge/organisations", ASSERT.reader)).text();
    expect(html).toContain(`/app/pages/${PAGE_ID}`);
    expect(html).toContain("Acme &lt;Corp&gt;");
    const empty = await (await w.http.get("/app/knowledge/people", ASSERT.reader)).text();
    expect(empty).toContain("No pages in People yet");
  });

  it("refuses a drawer that does not exist or a malformed name", async () => {
    const w = world();
    expect((await w.http.get("/app/knowledge/nope", ASSERT.reader)).status).toBe(404);
    expect((await w.http.get("/app/knowledge/..%2Fx", ASSERT.reader)).status).toBe(404);
  });

  it("needs a sign-in", async () => {
    const w = world();
    expect((await w.http.get("/app/knowledge")).status).toBe(401);
  });
});

describe("dead ends get a page, not a bare 404", () => {
  const get = (path: string, host = "engine.example.com", accept = "text/html") =>
    app.request(path, { headers: { host, accept } });

  it("/setup/ and /app/ redirect to the screen without the slash", async () => {
    const a = await get("/setup/");
    expect(a.status).toBe(301);
    expect(a.headers.get("location")).toBe("/setup");
    expect((await get("/app/")).headers.get("location")).toBe("/app");
  });

  it("an unknown /setup screen shows the setup menu", async () => {
    const res = await get("/setup/no-such-screen");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Setup screens");
    expect(html).toContain('href="/setup/timer"');
  });

  it("the platform's own hostname gets a page with a link to the real one", async () => {
    const res = await get("/app/pages", "app-abc.ondigitalocean.app");
    expect(res.status).toBe(421);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toMatch(/href="https:\/\/[^"]+\/app\/pages"/);
    expect(html).not.toContain("Invalid host");
    noScriptNoStyle(html);
  });

  it("a machine on the platform hostname still gets the short JSON answer", async () => {
    const res = await app.request("/mcp", { method: "POST", headers: { host: "app-abc.ondigitalocean.app", accept: "application/json" } });
    expect(res.status).toBe(421);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "Invalid host" } });
  });
});
