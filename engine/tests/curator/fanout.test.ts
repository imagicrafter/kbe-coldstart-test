import { describe, expect, it } from "vitest";
import { curateItem } from "../../src/curator/curate.js";
import { checkReply } from "../../src/curator/output.js";
import { SYSTEM_PROMPT, buildPrompt } from "../../src/curator/prompt.js";
import { entitySchema } from "../../src/entities/templates.js";
import { ALL_PAGES, fakeStore, modelSaying, page } from "./fixtures.js";
import { NORTHWIND_EMAIL, NORTHWIND_EXPECTED, NORTHWIND_PLAN } from "./northwind.js";

/**
 * Regression for the 2026-11-20 G1 live run: one email named a person, their
 * organisation, a pilot project and a deal, and the curator made ONE page.
 * One item must now fan out to every entity it names, linked together.
 */

const schema = entitySchema(["consulting"]);
const NOW = () => new Date("2026-11-20T12:00:00Z");
const deps = (model: ReturnType<typeof modelSaying>, store = fakeStore().store) => ({
  store, model, modelName: "openai-gpt-oss-120b", schema, now: NOW,
});
const ctx = { shortlist: [...ALL_PAGES], schema, sourceText: NORTHWIND_EMAIL.body };

describe("curator fan-out: the Northwind email", () => {
  it("matches by the sender's email and domain first", async () => {
    const f = fakeStore();
    await curateItem(NORTHWIND_EMAIL, deps(modelSaying({ updates: [], new_pages: [] }), f.store));
    expect(f.store.candidates.mock.calls[0]![1]).toEqual(["pat.rivera@northwind-test.com", "northwind-test.com"]);
  });

  it("creates person, organisation and project, queues the deal, and links them", async () => {
    const f = fakeStore();
    const r = await curateItem(NORTHWIND_EMAIL, deps(modelSaying(NORTHWIND_PLAN), f.store));

    expect(r.outcome).toBe("mixed");
    expect(r.queued).toBe(1);
    expect(r.pages).toHaveLength(3);
    const byKey = new Map(f.saves.map((s) => [String(s.page["key"]), s.page]));
    for (const e of NORTHWIND_EXPECTED) {
      if (e.queued) expect(byKey.has(e.key)).toBe(false);
      else expect(byKey.get(e.key)?.["drawer"]).toBe(e.drawer);
    }

    const person = byKey.get("pat.rivera@northwind-test.com")!;
    expect(person["body"]).toMatch(/## Timeline\n- 2026-11-20: /);
    expect(person["related"]).toEqual(["northwind-test.com", "project:northwind-pilot", "deal:northwind-test.com-pilot"]);
    expect(byKey.get("northwind-test.com")!["related"]).toContain("pat.rivera@northwind-test.com");
    expect(byKey.get("project:northwind-pilot")!["fields"]).toMatchObject({ organisation: "northwind-test.com", start_date: "2026-12-01" });

    // A new deal waits for a yes (consulting: new_page needs_yes), with stage and value.
    expect(f.reviews).toHaveLength(1);
    const review = f.reviews[0]!;
    expect(review).toMatchObject({ kind: "new_page", pageKey: "deal:northwind-test.com-pilot" });
    const deal = (review["proposal"] as { page: Record<string, unknown> }).page;
    expect(deal["fields"]).toMatchObject({ stage: "lead", value: 12000, organisation: "northwind-test.com" });
    expect(deal["related"]).toEqual(["pat.rivera@northwind-test.com", "northwind-test.com", "project:northwind-pilot"]);
    // Every page stays in the item's own topics.
    for (const s of f.saves) expect(s.page["topics"]).toEqual(NORTHWIND_EMAIL.topics);
  });

  it("updates an existing person page by key and adds links to it", async () => {
    const pat = page({ key: "pat.rivera@northwind-test.com", drawer: "people", title: "Pat Rivera", related: ["northwind-test.com"],
      body: "# Pat Rivera\n\n## Summary\nCOO.\n\n## Timeline\n- 2026-10-01: first call.\n" });
    const f = fakeStore([...ALL_PAGES, pat]);
    const plan = {
      ...NORTHWIND_PLAN,
      updates: [{ key: pat.key, patches: [{ op: "append-bullet", section: "Timeline",
        text: "2026-11-20: asked for a SOW by 2026-11-25 for a 6-week pilot from 2026-12-01." }],
        fields: { last_contact: "2026-11-20" }, related: ["northwind-test.com", "project:northwind-pilot"] }],
      new_pages: NORTHWIND_PLAN.new_pages.filter((n) => n.drawer !== "people"),
    };
    const r = await curateItem(NORTHWIND_EMAIL, deps(modelSaying(plan), f.store));
    expect(r.outcome).toBe("mixed");
    const saved = f.saves.find((s) => s.page["key"] === pat.key)!;
    expect(saved.hash).toBe(pat.content_hash);
    expect(saved.page["related"]).toEqual(["northwind-test.com", "project:northwind-pilot"]);
    expect(saved.page["body"]).toContain("- 2026-11-20: asked for a SOW");
  });

  it("rejects a link to a page that is neither on the shortlist nor in the reply", () => {
    const bad = { ...NORTHWIND_PLAN, new_pages: [{ ...NORTHWIND_PLAN.new_pages[0]!, related: ["secret:payroll"] }] };
    const r = checkReply(JSON.stringify(bad), ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/links to "secret:payroll"/);
  });

  it("rejects a page linking to itself and two new pages on one key", () => {
    const first = NORTHWIND_PLAN.new_pages[0]!;
    const self = { ...NORTHWIND_PLAN, new_pages: [{ ...first, related: [first.key] }] };
    expect(checkReply(JSON.stringify(self), ctx).ok).toBe(false);
    const twice = { ...NORTHWIND_PLAN, new_pages: [first, first] };
    expect(checkReply(JSON.stringify(twice), ctx).ok).toBe(false);
  });

  it("tells the model to file the item on every entity it names, with links", () => {
    const prompt = buildPrompt(NORTHWIND_EMAIL, [], schema, "0123456789abcdef");
    expect(prompt).toMatch(/every entity/i);
    expect(prompt).toContain('"related"');
    expect(prompt).toContain("At most 6 updates and 4 new pages");
    expect(SYSTEM_PROMPT).toMatch(/untrusted/);
    const before = prompt.split("<<<SOURCE_TEXT id=0123456789abcdef>>>")[0]!;
    expect(before).not.toContain("$12,000");
  });
});
