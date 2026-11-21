import { z } from "zod";
import type { ToolSpec } from "../../mcp/tool-helpers.js";
import { providerFor } from "../../sources/index.js";
import { pageRpc, rowsOf } from "./rpc.js";

/**
 * Read-only plan for one mechanical ingest run (Phase 10.10, stage 1).
 *
 * A scheduled task on the smallest model calls this first. It gets back the
 * caller's own cursor for the source, the time to list from, a cap per run,
 * and plain steps for listing items and filling record_source_item. It never
 * writes and never returns source text. Scope is fixed here for now; a
 * per-person scope setting can be added later without changing the shape.
 */

export const INGEST_SOURCES = ["gmail", "drive", "fireflies", "calendar"] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

const FIRST_RUN_DAYS = 7;
const MAX_ITEMS = 25;

export const getIngestPlanSchema = z.object({ source: z.enum(INGEST_SOURCES) }).strict();

type Scope = Readonly<Record<string, string>>;

function scopeFor(source: IngestSource, since: string): Scope {
  switch (source) {
    case "gmail":
      return {
        list: "Search Gmail threads with `query`. Oldest first. Skip threads labelled Spam, Trash or Draft.",
        query: `after:${Math.floor(Date.parse(since) / 1000)}`,
        source_id: "the Gmail thread id",
        title: "the thread subject",
        body: "every message in the thread, oldest first, each as: From, To, Date, then the message text exactly as read",
        source_created_at: "the date of the newest message in the thread",
      };
    case "drive":
      return {
        list: "List Google Drive files modified after `since`. Oldest first. Docs, Sheets, Slides, PDFs and text files only; skip folders, images and video.",
        source_id: "the Drive file id",
        title: "the file name",
        body: "the file's text exactly as read",
        source_created_at: "the file's modified time",
      };
    case "fireflies":
      return {
        list: "List Fireflies meetings dated after `since`. Oldest first.",
        source_id: "the Fireflies meeting (transcript) id",
        title: "the meeting title",
        body: "the participants line, then the full transcript exactly as read (speaker: text, one line each)",
        source_created_at: "the meeting date and time",
      };
    case "calendar":
      return {
        list: "List Google Calendar events on the primary calendar that start after `since` and before now. Oldest first. Skip declined events.",
        source_id: "the Calendar event id",
        title: "the event title",
        body: "start, end, attendees, location, then the description exactly as read",
        source_created_at: "the event start time",
      };
  }
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export const getIngestPlanTool: ToolSpec = {
  name: "get_ingest_plan",
  description:
    "Read-only. Call first in an ingest run. For one source (gmail, drive, fireflies, calendar) returns YOUR cursor, the time to list from (since), the most items to hand over this run (max_items), and how to fill record_source_item for each item. Writes nothing.",
  shape: getIngestPlanSchema.shape,
  run: async (params, ctx) => {
    const { source } = getIngestPlanSchema.parse(params);
    const row = rowsOf(
      await pageRpc("source_cursor_get", ctx.sub, { p_source: source }, "The ingest plan could not be read"),
    )[0];
    const cursor = row
      ? {
          last_seen: row["last_seen_id"] != null ? String(row["last_seen_id"]) : null,
          last_received_at: row["last_received_at"] != null ? String(row["last_received_at"]) : null,
          items_received: Number(row["items_received"] ?? 0),
          items_saved: Number(row["items_saved"] ?? 0),
        }
      : null;
    const fallback = new Date(Date.now() - FIRST_RUN_DAYS * 86_400_000).toISOString();
    const since = isoOrNull(cursor?.last_seen) ?? isoOrNull(cursor?.last_received_at) ?? fallback;
    return {
      source,
      first_run: cursor === null,
      cursor,
      since,
      max_items: MAX_ITEMS,
      record_with: "record_source_item",
      cursor_rule: "Pass cursor = the item's source_created_at (date and time). Hand items over oldest first.",
      tags_rule:
        "Pass each item's tags exactly as scope.tags says, unchanged. Never pass topics: the Engine files an item under a topic only when its owner switched that tag on.",
      scope: { ...scopeFor(source, since), tags: providerFor(source)?.howToRead ?? "This source has no tags. Do not pass tags." },
    };
  },
};
