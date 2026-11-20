import { describe, expect, it } from "vitest";
import { entitySchema } from "../../src/entities/templates.js";
import { checkReply, extractJsonObject, fieldProblem, keyProblem } from "../../src/curator/output.js";
import { judgeNewPage, judgeUpdate } from "../../src/curator/policy.js";
import { itemKeys, meetingKey } from "../../src/curator/keys.js";
import { ALL_PAGES, INVOICES, OVENS, PILOT, item } from "./fixtures.js";

const schema = entitySchema(["consulting"]);
const ctx = { shortlist: ALL_PAGES, schema, sourceText: item().body };
const drawer = (id: string) => schema.drawers.find((d) => d.id === id)!;

const good = {
  updates: [
    {
      key: PILOT.key,
      patches: [{ op: "append-bullet", section: "Timeline", text: "2026-11-19: map pack installed on all six tablets, so launch can move to 2026-11-30." }],
      fields: { next_step: "Launch on 2026-11-30" },
    },
  ],
  new_pages: [],
  notes: "",
};

describe("checkReply accepts only the contract", () => {
  it("accepts a good reply, fenced or not", () => {
    const r = checkReply("```json\n" + JSON.stringify(good) + "\n```", ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.updates[0]?.fields).toEqual({ next_step: "Launch on 2026-11-30" });
  });

  it.each([
    ["not JSON", "sure, here you go"],
    ["an extra key", { ...good, set_role: "admin" }],
    ["an unknown op", { ...good, updates: [{ key: PILOT.key, patches: [{ op: "rewrite", section: "Summary", text: "x" }] }] }],
    ["a key not on the shortlist", { ...good, updates: [{ ...good.updates[0], key: "project:other" }] }],
    ["a field the drawer lacks", { ...good, updates: [{ ...good.updates[0], fields: { owner_email: "x@y.com" } }] }],
    ["topics in an update", { ...good, updates: [{ ...good.updates[0], topics: ["private"] }] }],
    ["an undated bullet", { ...good, updates: [{ key: PILOT.key, patches: [{ op: "append-bullet", section: "Timeline", text: "map pack done" }] }] }],
    ["a missing section", { ...good, updates: [{ key: PILOT.key, patches: [{ op: "append-bullet", section: "Risks", text: "2026-11-19: x" }] }] }],
    ["the same page twice", { ...good, updates: [good.updates[0], good.updates[0]] }],
    ["too many updates", { ...good, updates: [1, 2, 3, 4].map(() => good.updates[0]) }],
    ["a bad enum value", { ...good, updates: [{ key: OVENS.key, patches: [], fields: { stage: "closed-won" } }] }],
    ["a bad date", { ...good, updates: [{ key: OVENS.key, patches: [], fields: { next_date: "2026-02-30" } }] }],
    ["a new page with a bad key", { ...good, updates: [], new_pages: [{ drawer: "deals", key: "Big Deal", title: "Big", sections: [] }] }],
    ["a new page in an unknown drawer", { ...good, updates: [], new_pages: [{ drawer: "secrets", key: "secret:x", title: "X", sections: [] }] }],
    ["a new page on a shortlist key", { ...good, updates: [], new_pages: [{ drawer: "projects", key: PILOT.key, title: "X", sections: [] }] }],
  ])("rejects %s", (_why, reply) => {
    const r = checkReply(typeof reply === "string" ? reply : JSON.stringify(reply), ctx);
    expect(r.ok).toBe(false);
  });

  it("rejects text copied from another page (exfiltration)", () => {
    const leak = {
      ...good,
      updates: [{ key: PILOT.key, patches: [{ op: "append-paragraph", section: "Notes",
        text: "2026-11-19: The private bank reference for refunds is REF-NW-PRIVATE-2291 and stays internal." }] }],
    };
    const r = checkReply(JSON.stringify(leak), ctx);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("copies text from another page") });
  });

  it("allows text the source itself contains even if a page has it too", () => {
    const quote = "The private bank reference for refunds is REF-NW-PRIVATE-2291 and stays internal.";
    const r = checkReply(
      JSON.stringify({ ...good, updates: [{ key: PILOT.key, patches: [{ op: "append-paragraph", section: "Notes", text: `2026-11-19: ${quote}` }] }] }),
      { ...ctx, sourceText: quote },
    );
    expect(r.ok).toBe(true);
  });

  it("drops empty updates and accepts a dated new section", () => {
    const r = checkReply(JSON.stringify({ updates: [
      { key: INVOICES.key, patches: [] },
      { key: PILOT.key, patches: [{ op: "new-section-after", after: "Timeline", heading: "2026-11-19 launch plan", text: "Launch moves." }] },
    ], new_pages: [] }), ctx);
    expect(r.ok && r.plan.updates.map((u) => u.key)).toEqual([PILOT.key]);
  });

  it("extracts the object from prose", () => {
    expect(extractJsonObject('Here: {"a":1} done')).toBe('{"a":1}');
  });
});

describe("field and key rules", () => {
  it("checks field kinds", () => {
    expect(fieldProblem(drawer("deals"), "value", 10)).toBeNull();
    expect(fieldProblem(drawer("deals"), "value", "ten")).toMatch(/number/);
    expect(fieldProblem(drawer("deals"), "next_step", "a\nb")).toMatch(/one/);
    expect(fieldProblem(drawer("people"), "organisation", "acme.com")).toBeNull();
  });

  it("checks key rules by drawer", () => {
    expect(keyProblem(drawer("people"), "dana@example.com")).toBeNull();
    expect(keyProblem(drawer("people"), "dana")).not.toBeNull();
    expect(keyProblem(drawer("organisations"), "example.com")).toBeNull();
    expect(keyProblem(drawer("organisations"), "www.example.com")).not.toBeNull();
    expect(keyProblem(drawer("deals"), "deal:example.com-2026-audit")).toBeNull();
    expect(keyProblem(drawer("deals"), "project:x")).not.toBeNull();
    expect(keyProblem(drawer("meetings"), "meeting:01abc")).toBeNull();
  });
});

describe("policy: small applies, large waits", () => {
  const upd = (fields: Record<string, string | number>, text = "2026-11-19: ok") => ({
    key: OVENS.key, patches: [{ op: "append-bullet" as const, section: "Timeline", text }], fields,
  });

  it("applies automatic fields and small text", () => {
    expect(judgeUpdate(upd({ next_step: "Call Priya" }), OVENS, schema, false)).toEqual({ apply: true });
  });

  it("queues a stage change, an unlisted field, a large change and a released item", () => {
    expect(judgeUpdate(upd({ stage: "won" }), OVENS, schema, false)).toEqual({ apply: false, reasons: ["stage change needs a yes"] });
    expect(judgeUpdate(upd({ value: 3000 }), OVENS, schema, false).apply).toBe(false);
    expect(judgeUpdate(upd({}, `2026-11-19: ${"x".repeat(3100)}`), OVENS, schema, false)).toEqual({ apply: false, reasons: ["large change"] });
    expect(judgeUpdate(upd({}), OVENS, schema, true).apply).toBe(false);
  });

  it("does not count a field set to its current value", () => {
    expect(judgeUpdate(upd({ stage: "proposal" }), OVENS, schema, false)).toEqual({ apply: true });
  });

  it("queues a new deal, applies a new meeting page", () => {
    const n = (d: string) => ({ drawer: d, key: "x", title: "X", sections: [], fields: {} });
    expect(judgeNewPage(n("deals"), schema, false)).toEqual({ apply: false, reasons: ["new page in deals"] });
    expect(judgeNewPage(n("offers"), schema, false).apply).toBe(false);
    expect(judgeNewPage(n("meetings"), schema, false)).toEqual({ apply: true });
    expect(judgeNewPage(n("meetings"), schema, true).apply).toBe(false);
  });
});

describe("keys an item names", () => {
  it("finds addresses and domains, without the owner and free mail", () => {
    const keys = itemKeys(item({
      body: "From: Dana <dana@northwind.example.com>\nTo: owner@example.com\nCc: pal@gmail.com\n\nhello carl@other.com",
      metadata: { participants: ["priya@harbor.example.org"] },
    }));
    expect(keys).toEqual([
      "priya@harbor.example.org", "dana@northwind.example.com", "pal@gmail.com",
      "harbor.example.org", "northwind.example.com",
    ]);
  });

  it("makes a meeting key for meeting sources and meeting ids", () => {
    expect(meetingKey({ source: "fireflies", source_id: "01ABC", metadata: {} })).toBe("meeting:01abc");
    expect(meetingKey({ source: "gmail", source_id: "t1", metadata: { meeting_id: "M 2" } })).toBe("meeting:m-2");
    expect(meetingKey({ source: "gmail", source_id: "t1", metadata: {} })).toBeNull();
  });
});
