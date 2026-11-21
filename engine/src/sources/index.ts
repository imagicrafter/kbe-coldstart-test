import { calendarProvider } from "./providers/calendar.js";
import { driveProvider } from "./providers/drive.js";
import { firefliesProvider } from "./providers/fireflies.js";
import { gmailProvider } from "./providers/gmail.js";
import type { RawTag, SourceTag, TagProvider } from "./types.js";

export { MAX_TAGS } from "./clean.js";
export type { RawTag, SourceTag, TagProvider } from "./types.js";

/**
 * Every tag provider, by source. To add a source, write one module in
 * providers/ that exports a TagProvider and list it here (docs/source-tags.md).
 */
export const PROVIDERS: ReadonlyMap<string, TagProvider> = new Map(
  [gmailProvider, driveProvider, firefliesProvider, calendarProvider].map((p) => [p.source, p] as const),
);

export function providerFor(source: string): TagProvider | null {
  return PROVIDERS.get(source) ?? null;
}

/** Clean tags for one item. A source without a provider keeps no tags. */
export function sourceTags(source: string, raw: readonly RawTag[]): readonly SourceTag[] {
  return providerFor(source)?.normalize(raw) ?? [];
}
