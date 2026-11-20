import { allowOutboundHost } from "../http/outbound-allowlist.js";

/**
 * The curator's model: a DigitalOcean serverless inference model behind the
 * OpenAI-style chat endpoint. Which model is a database setting
 * (curator_settings.model, held to the floor measured in test A1). The key is
 * read from the vault for each run and is never logged.
 *
 * `ModelBackend` is the seam the tests mock.
 */

export const DO_INFERENCE_HOST = "inference.do-ai.run";
const CHAT_URL = `https://${DO_INFERENCE_HOST}/v1/chat/completions`;
// gpt-oss-120b is capped at 4,096 output tokens on DigitalOcean (A1 finding).
export const MAX_OUTPUT_TOKENS = 4096;
const TIMEOUT_MS = 120_000;

export type ModelReply = {
  readonly text: string;
  readonly finish: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
};

export interface ModelBackend {
  complete(system: string, user: string, maxTokens?: number): Promise<ModelReply>;
}

export class ModelError extends Error {}

type ChatBody = {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  max_tokens: number;
  temperature: number;
  response_format?: { type: "json_object" };
};

async function post(key: string, body: ChatBody): Promise<Response> {
  return fetch(CHAT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/** A backend for one DigitalOcean model. JSON mode first; on HTTP 400 once without it. */
export function doInference(model: string, key: string): ModelBackend {
  allowOutboundHost(DO_INFERENCE_HOST);
  return {
    async complete(system, user, maxTokens = MAX_OUTPUT_TOKENS) {
      const body: ChatBody = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: Math.min(maxTokens, MAX_OUTPUT_TOKENS),
        temperature: 0,
      };
      let res: Response;
      try {
        res = await post(key, { ...body, response_format: { type: "json_object" } });
        if (res.status === 400) res = await post(key, body);
      } catch (err) {
        throw new ModelError(`model request failed: ${err instanceof Error ? err.name : "error"}`);
      }
      if (!res.ok) throw new ModelError(`model answered HTTP ${res.status}`);
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const choice = Array.isArray(data?.["choices"]) ? (data["choices"][0] as Record<string, unknown>) : null;
      const message = (choice?.["message"] ?? {}) as Record<string, unknown>;
      const usage = (data?.["usage"] ?? {}) as Record<string, unknown>;
      if (!choice) throw new ModelError("model reply had no choices");
      return {
        text: typeof message["content"] === "string" ? message["content"] : "",
        finish: typeof choice["finish_reason"] === "string" ? choice["finish_reason"] : null,
        inputTokens: num(usage["prompt_tokens"]),
        outputTokens: num(usage["completion_tokens"]),
      };
    },
  };
}
