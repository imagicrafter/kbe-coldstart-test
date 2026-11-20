import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const rpcMock = vi.fn();

vi.mock("../../src/supabase.js", () => ({
  embedText: vi.fn(),
  supabase: { schema: () => ({ rpc: rpcMock }) },
}));

const { pageTools } = await import("../../src/tools/pages/index.js");
const { INGEST_SOURCES } = await import("../../src/tools/pages/ingest-plan.js");

const CTX = { sub: "sub-ann", email: "ann@example.com" };
const NOW = new Date("2026-11-19T12:00:00Z");

function plan() {
  const t = pageTools.find((x) => x.name === "get_ingest_plan");
  if (!t) throw new Error("no get_ingest_plan tool");
  return t;
}

beforeEach(() => {
  rpcMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("get_ingest_plan", () => {
  it("reads the caller's own cursor by signed-in subject, never by an argument", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    await plan().run({ source: "gmail" }, CTX);
    const [fn, args] = rpcMock.mock.calls[0]!;
    expect(fn).toBe("source_cursor_get");
    expect(args).toEqual({ p_oauth_subject: "sub-ann", p_source: "gmail" });
  });

  it("first run: no cursor, looks back the default window", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const out = (await plan().run({ source: "gmail" }, CTX)) as Record<string, unknown>;
    expect(out["first_run"]).toBe(true);
    expect(out["cursor"]).toBeNull();
    expect(out["since"]).toBe("2026-11-12T12:00:00.000Z");
    expect(out["max_items"]).toBe(25);
    expect(out["record_with"]).toBe("record_source_item");
    expect(out["source"]).toBe("gmail");
  });

  it("later run: since is the saved cursor when it is a date and time", async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          last_seen_id: "2026-11-18T09:30:00Z",
          last_received_at: "2026-11-18T10:00:00Z",
          items_received: 7,
          items_saved: 6,
        },
      ],
      error: null,
    });
    const out = (await plan().run({ source: "fireflies" }, CTX)) as Record<string, unknown>;
    expect(out["first_run"]).toBe(false);
    expect(out["since"]).toBe("2026-11-18T09:30:00.000Z");
    expect(out["cursor"]).toEqual({
      last_seen: "2026-11-18T09:30:00Z",
      last_received_at: "2026-11-18T10:00:00Z",
      items_received: 7,
      items_saved: 6,
    });
  });

  it("falls back to the last received time when the cursor is not a date", async () => {
    rpcMock.mockResolvedValue({
      data: [
        { last_seen_id: "thread-abc", last_received_at: "2026-11-17T08:00:00Z", items_received: 1, items_saved: 1 },
      ],
      error: null,
    });
    const out = (await plan().run({ source: "drive" }, CTX)) as Record<string, unknown>;
    expect(out["since"]).toBe("2026-11-17T08:00:00.000Z");
  });

  it("gives every source a scope with a list step, a source_id rule and a body rule", async () => {
    for (const source of INGEST_SOURCES) {
      rpcMock.mockResolvedValue({ data: [], error: null });
      const out = (await plan().run({ source }, CTX)) as Record<string, unknown>;
      const scope = out["scope"] as Record<string, unknown>;
      expect(typeof scope["list"]).toBe("string");
      expect(typeof scope["source_id"]).toBe("string");
      expect(typeof scope["body"]).toBe("string");
    }
  });

  it("gmail scope carries a ready search query built from since", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const out = (await plan().run({ source: "gmail" }, CTX)) as Record<string, unknown>;
    const scope = out["scope"] as Record<string, unknown>;
    expect(scope["query"]).toBe(`after:${Math.floor(Date.parse("2026-11-12T12:00:00Z") / 1000)}`);
  });

  it("refuses an unknown source or extra arguments before any database call", async () => {
    await expect(plan().run({ source: "slack" }, CTX)).rejects.toThrow();
    await expect(plan().run({ source: "gmail", owner: "eve" }, CTX)).rejects.toThrow();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("hides an unexpected database error behind a plain message", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom internal" } });
    await expect(plan().run({ source: "gmail" }, CTX)).rejects.toThrow(/could not be read/);
  });
});
