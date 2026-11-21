# Entity templates

Every rule about kinds of pages lives in YAML, in
`engine/templates/entities/`. The curator prompt, the app and the page tools
read these files; no drawer id, key rule, signal or link rule is written in
code. `base.yaml` holds the eight drawers every Quantabase has; each other
file is a business template that adds drawers. An Engine uses base plus the
templates chosen on **Settings > Template**; when two define the same drawer,
the first one wins.

## File

```yaml
name: consulting                 # must match the file name
label: Consulting
description: Consultants, agencies and partners. Adds Deals and Offers.
drawers:
  - id: deals                    # lower case, letters, digits, dashes
    label: Deals
    icon: dollar                 # an icon name from engine/src/app/icons.ts; unknown means a folder
    key_rule:
      kind: slug                 # email | domain | slug | source_id
      text: "deal: followed by the organisation domain and a short name."
      # sources: [fireflies]     # source_id only: sources whose items carry this key
    fields:
      - { name: stage, kind: enum, values: [lead, won, lost] }   # text|date|number|enum|key|email|url
      - { name: value, kind: number }
    sections: [Summary, Need, Proposal, Timeline, Notes]
    signals:                     # when the curator should make a page here ("make one when")
      - A request for a price, a proposal or a scope of work
    update_rules:
      auto: [stage, value]       # fields the curator may set on its own
      needs_yes: []              # fields whose change waits for the owner's yes
    default_topic: null          # optional
    curator:                     # optional
      new_page: auto             # auto (default) | needs_yes
      links_to: [organisations, people, projects]   # drawers this page links to ("related")
      required_when:             # case-insensitive regular expressions on the item's text
        - '\$\s?\d'
        - '\b(budget|price|quote|proposal|sow)\b'
      notes:                     # extra one-line rules shown to the curator for this drawer
        - A project page does not replace the deal page; make both when both apply
    list_views:
      - { name: pipeline, filter: stage, sort: value, desc: true }
```

## Keys

| `key_rule.kind` | Key |
|---|---|
| `email` | the person's email, lower case |
| `domain` | the organisation's web domain, without `www.` |
| `slug` | `<prefix>:<short-name>`; the prefix is read from the start of `text` |
| `source_id` | `<prefix>:<the item's id at its source>`, for items from `key_rule.sources` (or with `metadata.<prefix>_id`) |

## What the curator does with it

- Each drawer becomes one line of the prompt: key, sections, fields,
  `link to`, `make one when` (signals) and `also` (notes). Links name only
  drawers the Engine uses.
- **`required_when`** makes a signal binding. When a pattern matches the
  item's text and the reply neither makes nor updates a page in that drawer,
  the curator asks once more with "this item matches the Deals signal; create
  or update the deal page". If the page is still missing, the rest of the
  reply is applied and the item is recorded as a failed check (Engine >
  Indexing, "failed"), so it is tried again later.
- **Consensus.** With `curator_settings.consensus` on (the default), each
  item is curated twice and, when the decisions differ, once more with
  `curator_settings.tiebreak_model`; see `engine/src/curator/consensus.ts`.
  The `required_when` check runs on the merged result.
- **`update_rules.needs_yes`** and **`curator.new_page: needs_yes`** opt a
  drawer in to more caution; the shipped templates use neither.

A template that does not parse stops the service at start with the file
name and the reason. `engine/tests/entities/templates.test.ts` checks every
shipped file: list views name real fields, icons exist, `links_to` names real
drawers.
