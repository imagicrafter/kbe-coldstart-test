import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { McpAppError } from "../mcp/errors.js";

/**
 * Entity templates: one YAML file per business type in engine/templates/entities.
 *
 * `base` holds the eight drawers every Engine has. A business template adds
 * drawers. An Engine uses base plus one or more business templates; when two
 * templates define the same drawer, the first one named wins. Skills read the
 * composed schema with get_entity_schema and never hard-code a business type.
 */

const DIR = fileURLToPath(new URL("../../templates/entities/", import.meta.url));

const Slug = z.string().regex(/^[a-z][a-z0-9_-]*$/);

const Field = z
  .object({
    name: Slug,
    kind: z.enum(["text", "date", "number", "enum", "key", "email", "url"]),
    values: z.array(z.string()).optional(),
    text: z.string().optional(),
  })
  .strict()
  .refine((f) => (f.kind === "enum") === (f.values !== undefined && f.values.length > 0), {
    message: "an enum field needs values, and only an enum field has them",
  });

const ListView = z
  .object({
    name: Slug,
    filter: Slug.optional(),
    sort: Slug.optional(),
    desc: z.boolean().optional(),
  })
  .strict();

const Drawer = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1),
    key_rule: z
      .object({
        kind: z.enum(["email", "domain", "slug", "source_id"]),
        text: z.string().min(1),
        // source_id keys only: the sources whose items carry this key
        // ("<prefix>:<the item's source id>"), e.g. [fireflies, calendar].
        sources: z.array(Slug).optional(),
      })
      .strict(),
    // The app's icon for this drawer (a name from engine/src/app/icons.ts).
    icon: Slug.optional(),
    fields: z.array(Field),
    sections: z.array(z.string().min(1)),
    signals: z.array(z.string().min(1)),
    update_rules: z
      .object({ auto: z.array(Slug), needs_yes: z.array(Slug) })
      .strict(),
    default_topic: z.string().nullable().optional(),
    // How the curator treats a NEW page in this drawer: made on its own
    // ("auto", the default) or held for a person's yes ("needs_yes").
    // links_to: drawers this drawer's pages link to ("related") when one item
    // names both. notes: extra one-line rules for the curator about this drawer.
    curator: z
      .object({
        new_page: z.enum(["auto", "needs_yes"]).optional(),
        links_to: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).optional(),
        notes: z.array(z.string().min(1)).optional(),
        // Case-insensitive regular expressions on the item's text: a match
        // means the reply must make or update a page in this drawer.
        required_when: z
          .array(
            z.string().min(1).max(300).refine((s) => {
              try {
                new RegExp(s, "i");
                return true;
              } catch {
                return false;
              }
            }, "required_when must be a valid regular expression"),
          )
          .optional(),
      })
      .strict()
      .optional(),
    list_views: z.array(ListView),
  })
  .strict();

const Template = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1),
    description: z.string().min(1),
    drawers: z.array(Drawer),
  })
  .strict();

export type DrawerDef = z.infer<typeof Drawer>;
export type TemplateDef = z.infer<typeof Template>;

export type EntitySchema = {
  readonly templates: readonly string[];
  readonly drawers: readonly DrawerDef[];
};

function readAll(): ReadonlyMap<string, TemplateDef> {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".yaml")).sort();
  const entries = files.map((file) => {
    const parsed = Template.safeParse(parse(readFileSync(`${DIR}${file}`, "utf8")));
    if (!parsed.success) {
      throw new Error(`Template ${file} is not valid: ${parsed.error.message}`);
    }
    if (`${parsed.data.name}.yaml` !== file) {
      throw new Error(`Template ${file} names itself ${parsed.data.name}`);
    }
    return [parsed.data.name, parsed.data] as const;
  });
  return new Map(entries);
}

let cache: ReadonlyMap<string, TemplateDef> | null = null;

/** Every template file, parsed and checked once. */
export function loadTemplates(): ReadonlyMap<string, TemplateDef> {
  cache = cache ?? readAll();
  return cache;
}

export const TEMPLATE_NAMES: readonly string[] = [...loadTemplates().keys()];

export const BASE_DRAWERS: readonly string[] = (loadTemplates().get("base")?.drawers ?? []).map(
  (d) => d.id,
);

/** Base plus the named templates, in order; first definition of a drawer wins. */
export function entitySchema(names: readonly string[]): EntitySchema {
  const all = loadTemplates();
  const chosen = ["base", ...names.filter((n) => n !== "base")];
  const unknown = chosen.filter((n) => !all.has(n));
  if (unknown.length > 0) {
    throw new McpAppError(
      "invalid_argument",
      `Unknown template: ${unknown.join(", ")}. Available: ${TEMPLATE_NAMES.join(", ")}`,
    );
  }
  const drawers = chosen
    .flatMap((n) => all.get(n)?.drawers ?? [])
    .filter((d, i, list) => list.findIndex((x) => x.id === d.id) === i);
  return { templates: [...new Set(chosen)], drawers };
}

/** Every drawer id any template defines: what save_page accepts. */
export function allDrawerIds(): ReadonlySet<string> {
  return new Set([...loadTemplates().values()].flatMap((t) => t.drawers.map((d) => d.id)));
}

/**
 * The fixed prefix of a slug or source-id key ("deal" for "deal:..."), taken
 * from the key rule's text; null for email and domain keys.
 */
export function keyPrefix(drawer: DrawerDef): string | null {
  if (drawer.key_rule.kind === "email" || drawer.key_rule.kind === "domain") return null;
  const m = /^"?([a-z][a-z-]*):/.exec(drawer.key_rule.text.trim());
  return m ? (m[1] ?? null) : null;
}
