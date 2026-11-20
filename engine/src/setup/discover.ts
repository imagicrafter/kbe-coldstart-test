import { z } from "zod";
import { CloudflareError, type CloudflareClient } from "./cloudflare-client.js";
import { permissionLabel, type TokenPermission } from "./permissions.js";

/**
 * Before anything is changed: check the token works, find the zone and the
 * account the hostname belongs to, and check the token can at least read
 * each of the three areas setup will write to.
 *
 * Cloudflare offers no way for a token to list its own permissions without a
 * further permission, so write access cannot be proven here. A token that can
 * read but not write is caught at the first write, which names the missing
 * permission and changes nothing.
 */

/** A problem a person can act on. The message is shown to them as is. */
export class SetupStepError extends Error {
  /** A fixed word for a problem the command line has its own words for. */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "SetupStepError";
    if (code) this.code = code;
  }
}

const HexId = z.string().regex(/^[a-f0-9]{32}$/i);

const Zone = z.object({
  id: HexId,
  name: z.string(),
  account: z.object({ id: HexId }),
});
type Zone = z.infer<typeof Zone>;

export type Discovery = {
  readonly accountId: string;
  readonly zoneId: string;
  readonly zoneName: string;
  readonly warnings: readonly string[];
};

const TOKEN_REFUSED =
  "Cloudflare did not accept this token. Check that all of it was copied and that it has not expired.";

/** engine.sub.example.com -> itself, sub.example.com, example.com. */
export function zoneCandidates(host: string): readonly string[] {
  const labels = host.split(".");
  return labels
    .slice(0, Math.max(labels.length - 1, 1))
    .map((_, i) => labels.slice(i).join("."));
}

async function findZone(
  client: CloudflareClient,
  host: string,
): Promise<Zone | null> {
  for (const name of zoneCandidates(host)) {
    const found = await client.list(["zones"], { name });
    const zone = found
      .map((item) => Zone.safeParse(item))
      .find((parsed) => parsed.success && parsed.data.name === name);
    if (zone?.success) return zone.data;
  }
  return null;
}

async function tokenIsActive(
  client: CloudflareClient,
  accountId: string,
): Promise<boolean> {
  const Status = z.object({ status: z.string() });
  const paths = [
    ["user", "tokens", "verify"],
    ["accounts", accountId, "tokens", "verify"],
  ];
  for (const path of paths) {
    try {
      const parsed = Status.safeParse(await client.get(path));
      if (parsed.success) return parsed.data.status === "active";
    } catch (err) {
      if (!(err instanceof CloudflareError)) throw err;
      if (err.kind === "network" || err.kind === "timeout") throw err;
      // Seen on a live account: a token owned by the account gets 401 on the
      // user route and is verified on the account route. So a refusal here
      // is not yet a bad token: try the next route.
    }
  }
  return false;
}

/** The permission a read needs, or null when the read was allowed. */
async function missing(
  id: TokenPermission["id"],
  read: () => Promise<unknown>,
): Promise<TokenPermission["id"] | null> {
  try {
    await read();
    return null;
  } catch (err) {
    if (!(err instanceof CloudflareError)) throw err;
    if (err.kind === "forbidden" || err.kind === "auth") return id;
    // Not found (no Zero Trust team yet) is dealt with by its own step.
    if (err.kind === "not_found") return null;
    throw err;
  }
}

async function missingPermissions(
  client: CloudflareClient,
  zone: Zone,
  host: string,
): Promise<readonly TokenPermission["id"][]> {
  const account = ["accounts", zone.account.id, "access"];
  const one = { per_page: "1" };
  const checks = await Promise.all([
    missing("apps", () => client.get([...account, "apps"], one)),
    missing("apps", () => client.get([...account, "policies"], one)),
    missing("organization", () => client.get([...account, "organizations"])),
    missing("organization", () =>
      client.get([...account, "identity_providers"], one),
    ),
    missing("dns", () =>
      client.get(["zones", zone.id, "dns_records"], { ...one, name: host }),
    ),
  ]);
  return [...new Set(checks.filter((id) => id !== null))];
}

async function breadthWarnings(
  client: CloudflareClient,
): Promise<readonly string[]> {
  try {
    const zones = await client.get(["zones"], { per_page: "5" });
    return Array.isArray(zones) && zones.length > 1
      ? [
          "This token can reach more than one zone. It works, but a token limited to the one zone is safer. Delete it when setup is done.",
        ]
      : [];
  } catch {
    return [];
  }
}

export async function discover(
  client: CloudflareClient,
  host: string,
): Promise<Discovery> {
  let zone: Zone | null;
  try {
    zone = await findZone(client, host);
  } catch (err) {
    if (err instanceof CloudflareError && err.kind === "auth")
      throw new SetupStepError(TOKEN_REFUSED);
    if (!(err instanceof CloudflareError && err.kind === "forbidden"))
      throw err;
    zone = null;
  }
  if (!zone) {
    throw new SetupStepError(
      `The token cannot see a Cloudflare zone for ${host}. The domain must be on this Cloudflare account, and the token needs ${permissionLabel("dns")} for that zone.`,
    );
  }

  if (!(await tokenIsActive(client, zone.account.id)))
    throw new SetupStepError(TOKEN_REFUSED);

  const lacking = await missingPermissions(client, zone, host);
  if (lacking.length > 0) {
    throw new SetupStepError(
      `The token is missing: ${lacking.map(permissionLabel).join("; ")}. Make a new token with the permissions listed on the setup page.`,
    );
  }

  return {
    accountId: zone.account.id,
    zoneId: zone.id,
    zoneName: zone.name,
    warnings: await breadthWarnings(client),
  };
}
