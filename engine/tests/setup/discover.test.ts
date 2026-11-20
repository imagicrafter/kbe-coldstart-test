import { describe, it, expect } from "vitest";
import { createCloudflareClient } from "../../src/setup/cloudflare-client.js";
import { discover } from "../../src/setup/discover.js";
import {
  createFakeCloudflare,
  GOOD_TOKEN,
  ZONE_ID,
  type FakeOptions,
} from "./fake-cloudflare.js";

const HOST = "engine.example.com";

function run(options: FakeOptions = {}) {
  const fake = createFakeCloudflare(options);
  const client = createCloudflareClient({
    token: GOOD_TOKEN,
    fetch: fake.fetch,
  });
  return { fake, found: discover(client, HOST) };
}

const verifyCalls = (requests: readonly { url: string }[]) =>
  requests
    .map((r) => new URL(r.url).pathname)
    .filter((p) => p.endsWith("/tokens/verify"));

describe("token verification (as seen on a live account)", () => {
  it("a token owned by the user is verified on the user route", async () => {
    const { found } = run();
    await expect(found).resolves.toMatchObject({ zoneId: ZONE_ID });
  });

  it("a 401 on the user route is not a bad token when the account route says active", async () => {
    const { fake, found } = run({ tokenOwner: "account" });
    await expect(found).resolves.toMatchObject({ zoneId: ZONE_ID });
    const calls = verifyCalls(fake.requests);
    expect(calls[0]).toBe("/client/v4/user/tokens/verify");
    expect(calls[1]).toMatch(/^\/client\/v4\/accounts\/[^/]+\/tokens\/verify$/);
  });

  it("a token the account route calls disabled is refused", async () => {
    const { found } = run({ tokenOwner: "account-disabled" });
    await expect(found).rejects.toThrow(/did not accept this token/);
  });
});
