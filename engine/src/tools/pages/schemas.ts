import { z } from "zod";
import { patchSchema } from "../../entities/sections.js";

/** Tool argument shapes. None of them has an owner: the owner is the caller. */

const Key = z.string().trim().min(1).max(200).refine((s) => !/\s/.test(s), "no spaces");
const Drawer = z.string().regex(/^[a-z][a-z0-9-]*$/);
const TextList = z.array(z.string().trim().min(1).max(300)).max(100);
const Status = z.enum(["draft", "unreviewed", "current"]);
const FieldValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

export const savePageSchema = z
  .object({
    drawer: Drawer,
    key: Key,
    title: z.string().trim().min(1).max(300),
    body: z.string().max(200000).optional(),
    aliases: TextList.optional(),
    description: z.string().max(500).optional(),
    fields: z.record(FieldValue).optional(),
    topics: z.array(z.string().min(1).max(64)).max(20).optional(),
    status: Status.optional(),
    tags: TextList.optional(),
    related: TextList.optional(),
    sources: z.array(z.unknown()).max(500).optional(),
    generated: z.record(z.unknown()).optional(),
    verified: z.array(z.unknown()).max(100).optional(),
    template: z.string().max(64).optional(),
    expected_hash: z.string().min(1).max(128).optional(),
  })
  .strict();

export const updatePageSchema = z
  .object({
    key: Key,
    patches: z.array(patchSchema).max(50).default([]),
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().max(500).optional(),
    aliases: TextList.optional(),
    fields: z.record(FieldValue).optional(),
    status: Status.optional(),
    tags: TextList.optional(),
    related: TextList.optional(),
    add_sources: z.array(z.unknown()).max(100).optional(),
  })
  .strict();

export const findEntitySchema = z
  .object({
    query: z.string().trim().min(1).max(300),
    drawer: Drawer.optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export const listEntitiesSchema = z
  .object({
    drawer: Drawer,
    filter: z.record(z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
    sort: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional(),
    desc: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

export const relatedSchema = z
  .object({
    key: Key,
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

export const entitySchemaSchema = z
  .object({
    // Leave out for the templates this Engine uses (chosen at setup).
    templates: z.array(z.string().min(1).max(64)).max(10).optional(),
  })
  .strict();

export const recordSourceItemSchema = z
  .object({
    source: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    source_id: z.string().trim().min(1).max(500),
    title: z.string().max(500).optional(),
    body: z.string().max(500000),
    // The item's labels, folders or channels, unchanged from the source. There
    // is no `topics`: an item's topics come only from the tags its owner
    // switched on (Topics and people, "Found in your sources").
    tags: z
      .array(
        z
          .object({
            id: z.string().max(1000).optional(),
            name: z.string().max(5000).optional(),
            kind: z.string().max(64).optional(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    source_created_at: z.string().datetime({ offset: true }).optional(),
    metadata: z.record(z.unknown()).optional(),
    cursor: z.string().max(500).optional(),
  })
  .strict();

export const getSourceItemSchema = z.object({ id: z.string().uuid() }).strict();
