/**
 * The permissions the one-time Cloudflare API token needs. One list, used by
 * the instructions on the page, by the checks before anything is changed, and
 * by the message shown when a step is refused.
 */

export type TokenPermission = {
  readonly id: "apps" | "organization" | "dns";
  /** Where it is picked in Cloudflare's "Create Custom Token" form. */
  readonly scope: "Account" | "Zone";
  readonly name: string;
  readonly level: "Edit";
  readonly why: string;
};

export const TOKEN_PERMISSIONS: readonly TokenPermission[] = [
  {
    id: "apps",
    scope: "Account",
    name: "Access: Apps and Policies",
    level: "Edit",
    why: "creates the two sign-in applications and their rules",
  },
  {
    id: "organization",
    scope: "Account",
    name: "Access: Organizations, Identity Providers, and Groups",
    level: "Edit",
    why: "reads your team name, adds one-time PIN sign-in, and switches on the second factor",
  },
  {
    id: "dns",
    scope: "Zone",
    name: "DNS",
    level: "Edit",
    why: "adds the DNS record for the hostname, in that one zone only",
  },
];

export function permissionLabel(id: TokenPermission["id"]): string {
  const p = TOKEN_PERMISSIONS.find((item) => item.id === id);
  return p ? `${p.scope} - ${p.name} - ${p.level}` : id;
}
