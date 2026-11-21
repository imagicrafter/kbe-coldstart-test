import { z } from "zod";
import { applyPatches, patchSchema, type Patch } from "../entities/sections.js";
import { keyPrefix, type DrawerDef, type EntitySchema } from "../entities/templates.js";

/**
 * The curator's reply contract, and the strict check every reply passes
 * before anything is written. Anything outside the contract rejects the whole
 * reply: the item is tried again later, and nothing is half-applied.
 */

/** One item may name a person, their organisation, a project and a deal. */
export const MAX_UPDATES = 6;
export const MAX_NEW_PAGES = 4;
const MAX_LINKS = 8;

const FieldValue = z.union([z.string().max(300), z.number().finite()]);
const Fields = z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/), FieldValue);
/** Keys of other pages this one links to (the header's `related` list). */
const Related = z.array(z.string().min(1).max(200)).max(MAX_LINKS);

const Update = z
  .object({
    key: z.string().min(1).max(200),
    patches: z.array(patchSchema).max(8),
    fields: Fields.optional(),
    related: Related.optional(),
  })
  .strict();

const NewPage = z
  .object({
    drawer: z.string().regex(/^[a-z][a-z0-9-]*$/),
    key: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    description: z.string().max(300).optional(),
    fields: Fields.optional(),
    related: Related.optional(),
    sections: z
      .array(z.object({ heading: z.string().min(1).max(120), text: z.string().max(4000) }).strict())
      .max(8),
  })
  .strict();

export const replySchema = z
  .object({
    updates: z.array(Update).max(MAX_UPDATES),
    new_pages: z.array(NewPage).max(MAX_NEW_PAGES),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export type Reply = z.infer<typeof replySchema>;
type Linked = { readonly fields: Record<string, string | number>; readonly related: readonly string[] };
export type PlannedUpdate = Omit<z.infer<typeof Update>, "related"> & Linked;
export type PlannedNewPage = Omit<z.infer<typeof NewPage>, "related"> & Linked;

export type Plan = {
  readonly updates: readonly PlannedUpdate[];
  readonly newPages: readonly PlannedNewPage[];
  readonly notes: string;
};

/** A page on the shortlist, as the curator read it. */
export type Candidate = {
  readonly id: string;
  readonly drawer: string;
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly fields: Record<string, unknown>;
  readonly body: string;
  readonly content_hash: string;
};

export type CheckContext = {
  readonly shortlist: readonly Candidate[];
  readonly schema: EntitySchema;
  /** The item's raw text (title and body), for the leak check. */
  readonly sourceText: string;
};

export type CheckResult = { readonly ok: true; readonly plan: Plan } | { readonly ok: false; readonly reason: string };

const MAX_TOTAL_CHARS = 16000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATED = /^\s*(?:[-*]\s+)?(?:\*\*)?\d{4}-\d{2}-\d{2}\b/;
const LEAK_MIN_CHARS = 25;

/** The JSON object in a reply that may be fenced or wrapped in prose. */
export function extractJsonObject(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.split("\n").slice(1).join("\n");
    if (text.trimEnd().endsWith("```")) text = text.trimEnd().slice(0, -3);
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end <= start ? text : text.slice(start, end + 1);
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Why a field value does not fit its drawer, or null when it does. */
export function fieldProblem(drawer: DrawerDef, name: string, value: string | number): string | null {
  const def = drawer.fields.find((f) => f.name === name);
  if (!def) return `"${name}" is not a field of ${drawer.id}`;
  if (def.kind === "number") return typeof value === "number" ? null : `"${name}" must be a number`;
  if (typeof value !== "string") return `"${name}" must be text`;
  if (/[\r\n]/.test(value) || value.trim() === "") return `"${name}" must be one non-empty line`;
  switch (def.kind) {
    case "date":
      return validDate(value) ? null : `"${name}" must be a date YYYY-MM-DD`;
    case "enum":
      return (def.values ?? []).includes(value) ? null : `"${name}" must be one of ${(def.values ?? []).join(", ")}`;
    case "key":
      return /^[^\sA-Z]{1,200}$/.test(value) ? null : `"${name}" must be a lower-case key`;
    case "email":
      return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(value) ? null : `"${name}" must be an email address`;
    case "url":
      return /^https?:\/\/\S+$/.test(value) ? null : `"${name}" must be a web address`;
    default:
      return null;
  }
}

/** Why a new page key breaks its drawer's key rule, or null. */
export function keyProblem(drawer: DrawerDef, key: string): string | null {
  if (key !== key.toLowerCase() || /\s/.test(key)) return "a key is lower case with no spaces";
  switch (drawer.key_rule.kind) {
    case "email":
      return /^[^@]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(key) ? null : `a ${drawer.id} key is an email address`;
    case "domain":
      return /^(?!www\.)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(key) ? null : `a ${drawer.id} key is a web domain`;
    default: {
      const prefix = keyPrefix(drawer);
      return prefix && new RegExp(`^${prefix}:[a-z0-9][a-z0-9._-]*$`).test(key)
        ? null
        : `a ${drawer.id} key starts with "${prefix ?? "?"}:" then a short name`;
    }
  }
}

function patchTexts(p: Patch): readonly string[] {
  switch (p.op) {
    case "append-bullet":
    case "append-paragraph":
      return [p.text];
    case "replace-line":
      return [p.new];
    case "new-section-after":
      return [p.heading, p.text ?? ""];
  }
}

function isDated(p: Patch): boolean {
  switch (p.op) {
    case "append-bullet":
    case "append-paragraph":
      return DATED.test(p.text);
    case "new-section-after":
      return DATED.test(p.heading) || DATED.test(p.text ?? "");
    case "replace-line":
      return true;
  }
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Lines of pages the reply does not target that appear inside `text` and are
 * not in the source: text carried from one page to another.
 */
function leakedLines(text: string, others: readonly Candidate[], source: string): readonly string[] {
  const out = norm(text);
  const src = norm(source);
  return others
    .flatMap((o) => o.body.split("\n"))
    .map((l) => norm(l.replace(/^\s*(?:[-*]|#+)\s+/, "")))
    .filter((l) => l.length >= LEAK_MIN_CHARS && out.includes(l) && !src.includes(l));
}

function drawerOf(schema: EntitySchema, id: string): DrawerDef | undefined {
  return schema.drawers.find((d) => d.id === id);
}

function checkFields(drawer: DrawerDef, fields: Record<string, string | number>): string | null {
  return Object.entries(fields).map(([n, v]) => fieldProblem(drawer, n, v)).find((p) => p !== null) ?? null;
}

function checkUpdate(u: PlannedUpdate, ctx: CheckContext): string | null {
  const page = ctx.shortlist.find((c) => c.key === u.key);
  if (!page) return `"${u.key}" is not on the shortlist`;
  const drawer = drawerOf(ctx.schema, page.drawer);
  if (!drawer) return `drawer ${page.drawer} is not in this Engine's templates`;
  const fieldIssue = checkFields(drawer, u.fields);
  if (fieldIssue) return fieldIssue;
  if (!u.patches.every(isDated)) return "every added bullet, paragraph or section starts with a date YYYY-MM-DD";
  try {
    applyPatches(page.body, u.patches);
  } catch (err) {
    return `a patch for "${u.key}" does not apply: ${err instanceof Error ? err.message : String(err)}`;
  }
  const others = ctx.shortlist.filter((c) => c.key !== u.key);
  const leaked = u.patches.flatMap((p) => patchTexts(p)).flatMap((t) => leakedLines(t, others, ctx.sourceText));
  return leaked.length > 0 ? `a patch for "${u.key}" copies text from another page` : null;
}

function checkNewPage(n: PlannedNewPage, ctx: CheckContext): string | null {
  const drawer = drawerOf(ctx.schema, n.drawer);
  if (!drawer) return `drawer ${n.drawer} is not in this Engine's templates`;
  const keyIssue = keyProblem(drawer, n.key);
  if (keyIssue) return keyIssue;
  if (ctx.shortlist.some((c) => c.key === n.key)) return `"${n.key}" already has a page; update it instead`;
  if (/[\r\n]/.test(n.title) || /[\r\n]/.test(n.description ?? "")) return "title and description are one line";
  const fieldIssue = checkFields(drawer, n.fields);
  if (fieldIssue) return fieldIssue;
  const headings = n.sections.map((s) => norm(s.heading));
  if (new Set(headings).size !== headings.length) return "section headings must differ";
  if (n.sections.some((s) => /[\r\n#]/.test(s.heading))) return "a section heading is one line of plain text";
  const leaked = n.sections.flatMap((s) => leakedLines(s.text, ctx.shortlist, ctx.sourceText));
  return leaked.length > 0 ? "the new page copies text from another page" : null;
}

function dedupe(keys: readonly string[]): readonly string[] {
  return [...new Set(keys)];
}

/**
 * A page may link only to pages the curator was shown or creates in the same
 * reply: it never points at a page outside the item's reach.
 */
function linkProblem(key: string, related: readonly string[], linkable: ReadonlySet<string>): string | null {
  if (related.includes(key)) return `"${key}" links to itself`;
  const stranger = related.find((r) => !linkable.has(r));
  return stranger === undefined ? null : `"${key}" links to "${stranger}", which is not on the shortlist or in this reply`;
}

function totalChars(reply: Reply): number {
  return JSON.stringify(reply).length;
}

/** Parse and check one model reply. Never throws. */
export function checkReply(raw: string, ctx: CheckContext): CheckResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(extractJsonObject(raw));
  } catch {
    return { ok: false, reason: "the reply is not JSON" };
  }
  const parsed = replySchema.safeParse(decoded);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `the reply does not fit the contract: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim() };
  }
  const reply = parsed.data;
  if (totalChars(reply) > MAX_TOTAL_CHARS) return { ok: false, reason: "the reply is too large" };

  const keys = reply.updates.map((u) => u.key);
  if (new Set(keys).size !== keys.length) return { ok: false, reason: "a page is named twice in updates" };

  const newKeys = reply.new_pages.map((n) => n.key);
  if (new Set(newKeys).size !== newKeys.length) return { ok: false, reason: "a new page is named twice" };

  const updates: PlannedUpdate[] = reply.updates
    .map((u) => ({ ...u, fields: u.fields ?? {}, related: dedupe(u.related ?? []) }))
    .filter((u) => u.patches.length > 0 || Object.keys(u.fields).length > 0 || u.related.length > 0);
  const newPages: PlannedNewPage[] = reply.new_pages.map((n) => ({
    ...n,
    fields: n.fields ?? {},
    related: dedupe(n.related ?? []),
  }));

  const linkable = new Set([...ctx.shortlist.map((c) => c.key), ...newKeys]);
  const problem =
    [...updates, ...newPages].map((p) => linkProblem(p.key, p.related, linkable)).find((p) => p !== null) ??
    updates.map((u) => checkUpdate(u, ctx)).find((p) => p !== null) ??
    newPages.map((n) => checkNewPage(n, ctx)).find((p) => p !== null) ??
    null;
  if (problem) return { ok: false, reason: problem };
  return { ok: true, plan: { updates, newPages, notes: reply.notes ?? "" } };
}
