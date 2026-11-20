/**
 * Entity keys an item names, for matching by key before any search:
 * email addresses, web domains (from those addresses) and a meeting id.
 *
 * Keys are read from the item's metadata and from the header lines at the top
 * of its text (From, To, Cc, Attendees). The owner's own address and domain
 * are left out (every mail of theirs names them), and so are the big free
 * mail domains (gmail.com names no organisation).
 */

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const HEADER_LINE = /^(?:from|to|cc|reply-to|attendees?|participants?|organi[sz]er)\s*:(.*)$/gim;
const HEADER_SCAN_CHARS = 4000;
const MAX_KEYS = 20;

export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
  "gmx.com", "zoho.com", "fastmail.com",
]);

const MEETING_SOURCES: ReadonlySet<string> = new Set(["fireflies", "meetings", "meeting", "calendar", "zoom", "teams"]);

export type KeyItem = {
  readonly source: string;
  readonly source_id: string;
  readonly body: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly owner_email: string | null;
};

function stringsIn(value: unknown, depth = 0): readonly string[] {
  if (depth > 4) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => stringsIn(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((v) => stringsIn(v, depth + 1));
  }
  return [];
}

function emailsIn(text: string): readonly string[] {
  return (text.match(EMAIL) ?? []).map((e) => e.toLowerCase().replace(/\.+$/, ""));
}

function headerText(body: string): string {
  const top = body.slice(0, HEADER_SCAN_CHARS);
  return [...top.matchAll(HEADER_LINE)].map((m) => m[1] ?? "").join(" ");
}

export function domainOf(email: string): string {
  return (email.split("@")[1] ?? "").replace(/^www\./, "");
}

/** Meeting key for a meeting-like item, else null. */
export function meetingKey(item: Pick<KeyItem, "source" | "source_id" | "metadata">): string | null {
  const metaId = item.metadata["meeting_id"];
  const id = typeof metaId === "string" && metaId.trim() !== "" ? metaId : MEETING_SOURCES.has(item.source) ? item.source_id : null;
  if (!id) return null;
  const clean = id.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 190);
  return clean ? `meeting:${clean}` : null;
}

/** The keys this item names, most specific first, at most MAX_KEYS. */
export function itemKeys(item: KeyItem): readonly string[] {
  const owner = item.owner_email?.toLowerCase() ?? null;
  const ownerDomain = owner ? domainOf(owner) : null;
  const emails = [...emailsIn(stringsIn(item.metadata).join(" ")), ...emailsIn(headerText(item.body))].filter(
    (e) => e !== owner,
  );
  const domains = emails
    .map(domainOf)
    .filter((d) => d !== "" && d !== ownerDomain && !FREE_MAIL_DOMAINS.has(d));
  const meeting = meetingKey(item);
  const all = [...(meeting ? [meeting] : []), ...emails, ...domains];
  return [...new Set(all)].slice(0, MAX_KEYS);
}
