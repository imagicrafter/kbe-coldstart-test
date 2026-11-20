import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_OUTPUT_TOKENS, ModelError, doInference } from "../../src/curator/model.js";
import { keyPrefix, loadTemplates } from "../../src/entities/templates.js";

const ok = (content: string, finish = "stop") =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe("doInference (DigitalOcean serverless inference)", () => {
  it("posts the chat in JSON mode with the bearer key and the model from settings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('{"updates":[]}'));
    vi.stubGlobal("fetch", fetchMock);
    const reply = await doInference("deepseek-v4.1-flash", "k-123").complete("sys", "user", 99999);
    expect(reply).toEqual({ text: '{"updates":[]}', finish: "stop", inputTokens: 10, outputTokens: 5 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://inference.do-ai.run/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer k-123");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "deepseek-v4.1-flash", max_tokens: MAX_OUTPUT_TOKENS, temperature: 0, response_format: { type: "json_object" } });
    expect(body.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "user" }]);
  });

  it("retries once without JSON mode on HTTP 400", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("bad", { status: 400 })).mockResolvedValueOnce(ok("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await doInference("openai-gpt-oss-120b", "k").complete("s", "u");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).response_format).toBeUndefined();
  });

  it("raises a ModelError that never carries the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
    const err = await doInference("openai-gpt-oss-120b", "secret-key-xyz").complete("s", "u").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(String((err as Error).message)).toBe("model answered HTTP 401");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret-key-xyz in a stack")));
    const err2 = await doInference("openai-gpt-oss-120b", "secret-key-xyz").complete("s", "u").catch((e: unknown) => e);
    expect(String((err2 as Error).message)).not.toContain("secret-key-xyz");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await expect(doInference("m", "k").complete("s", "u")).rejects.toThrow("no choices");
  });
});

describe("templates carry what the curator needs", () => {
  it("every slug and source-id drawer has a key prefix", () => {
    const drawers = [...loadTemplates().values()].flatMap((t) => t.drawers);
    for (const d of drawers) {
      if (d.key_rule.kind === "slug" || d.key_rule.kind === "source_id") expect(keyPrefix(d), d.id).toMatch(/^[a-z-]+$/);
      else expect(keyPrefix(d)).toBeNull();
    }
  });

  it("CRM-like drawers hold new pages for a yes", () => {
    const held = [...loadTemplates().values()].flatMap((t) => t.drawers).filter((d) => d.curator?.new_page === "needs_yes").map((d) => d.id);
    expect([...new Set(held)].sort()).toEqual(["deals", "offers", "programs", "properties"]);
  });
});
