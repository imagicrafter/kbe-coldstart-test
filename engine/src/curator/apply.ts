import { applyPatches } from "../entities/sections.js";
import type { PlannedNewPage, PlannedUpdate } from "./output.js";
import type { ClaimedItem, PageRow } from "./store.js";

/**
 * Turning a checked plan into the page a save writes. Pure functions.
 *
 * Every page the curator touches records the item in `sources`
 * ({item, source, source_id, version}). That record is what makes a re-run
 * safe: a page that already lists the item is not patched again.
 */

export type SourceRef = {
  readonly item: string;
  readonly source: string;
  readonly source_id: string;
  readonly version: number;
};

export function sourceRef(item: Pick<ClaimedItem, "id" | "source" | "source_id" | "version">): SourceRef {
  return { item: item.id, source: item.source, source_id: item.source_id, version: item.version };
}

export function alreadyHas(page: Pick<PageRow, "sources">, itemId: string): boolean {
  return page.sources.some(
    (s) => s !== null && typeof s === "object" && (s as Record<string, unknown>)["item"] === itemId,
  );
}

export type Generated = { readonly by: "curator"; readonly model: string; readonly at: string };

/** The whole page after an update: patches applied, fields merged, source added. */
export function updatedPage(
  page: PageRow,
  u: Pick<PlannedUpdate, "patches" | "fields"> & { readonly related?: readonly string[] },
  ref: SourceRef,
  generated: Generated,
): Record<string, unknown> {
  return {
    drawer: page.drawer,
    key: page.key,
    template: page.template ?? undefined,
    title: page.title,
    aliases: page.aliases,
    description: page.description ?? undefined,
    fields: { ...page.fields, ...u.fields },
    topics: page.topics,
    status: page.status,
    tags: page.tags,
    related: [...new Set([...page.related, ...(u.related ?? [])])],
    sources: [...page.sources, ref],
    generated,
    verified: page.verified,
    body: applyPatches(page.body, u.patches),
  };
}

/** A new page in the item's topics: title heading, then the drawer's sections in order. */
export function newPage(
  n: PlannedNewPage,
  sectionOrder: readonly string[],
  topics: readonly string[],
  ref: SourceRef,
  generated: Generated,
): Record<string, unknown> {
  const rank = (h: string): number => {
    const i = sectionOrder.findIndex((s) => s.toLowerCase() === h.trim().toLowerCase());
    return i === -1 ? sectionOrder.length : i;
  };
  const sections = [...n.sections].sort((a, b) => rank(a.heading) - rank(b.heading));
  const body = [
    `# ${n.title.trim()}`,
    ...sections.flatMap((s) => ["", `## ${s.heading.trim()}`, ...(s.text.trim() ? [s.text.trim()] : [])]),
    "",
  ].join("\n");
  return {
    drawer: n.drawer,
    key: n.key,
    title: n.title.trim(),
    description: n.description?.trim() || undefined,
    fields: n.fields,
    topics,
    related: [...n.related],
    status: "unreviewed",
    sources: [ref],
    generated,
    body,
  };
}
