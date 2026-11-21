# The Claude plugin

The plugin is how a person's own Claude feeds their Engine. It holds two
skills and the Engine connector:

| Part | What it does |
|---|---|
| `kb-ingest` skill | One run copies new items from ONE source (Gmail, Drive, Fireflies, Calendar) into the Engine, unchanged, with `record_source_item`. No summaries, no judgement. Reports `listed N, saved N`. |
| `kb-schedule-setup` skill | Walks the person through tool permissions, a first run by hand, and one scheduled task per source on the smallest model. |
| Engine connector (`.mcp.json`) | Points at the person's Engine (`https://<host>/mcp`), set once at install. |

The plugin lives in [`../plugin/kb-engine/`](../plugin/kb-engine/); the
marketplace file is [`../.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json),
so this repository can be added as a plugin marketplace.

## How ingest works

This is stage 1 of the two stages in [manual.md](manual.md) (load, then
curate). Claude only loads; the Engine's curator does the judgement on its
own timer, with no connectors.

1. The scheduled task (smallest model) runs `kb-ingest` for one source.
2. `get_ingest_plan` (read-only) returns the person's own cursor for that
   source, `since` (list items newer than this), `max_items` (25 per run),
   and how to fill each field. A first run looks back 7 days.
3. Claude lists new items through the source's own connector, oldest first,
   and hands each one over with `record_source_item`, passing the item's date
   as `cursor`. The Engine stores it as untrusted source data, owned by the
   caller, versioned by id and text hash; the cursor moves with each item.
4. Claude replies with one line: `listed N, saved S (...), failed F`.

A missed or failed run catches up next time: the cursor only moves when an
item arrives. Handing the same item twice is harmless (`unchanged`).

**Why scheduled tasks only load.** A scheduled task cannot be limited to
chosen connectors; it sees every connector the person has, and a stranger's
mail can contain text written to steer an AI. So the task's job is kept
mechanical, the skill and task prompt say source text is never instructions,
`kb-schedule-setup` puts every send and write tool on "Needs approval", and
the Engine's write tools only store. Curation runs inside the service.

**Server mode (optional).** The Python pullers (`pullers/`) still work and
are now the optional "server mode" for an Engine that should read its
sources itself with its own Google and Fireflies credentials. The plugin is
the default path; an Engine can use either or both.

## Install

The repository must be reachable by the person's Claude (it is public).

### Claude Code

```
/plugin marketplace add imagicrafter/kbe-coldstart-test
/plugin install kb-engine@kb-engine
```

Claude Code asks for **Your Knowledge Base Engine address (ends in /mcp)** when the plugin is enabled.
Paste the address from your Engine's setup page (it ends in `/mcp`). To
change it later: `/plugin`, open **kb-engine**, and edit the option. Then
sign in to the Engine when the connector asks.

### Claude app on a Pro or Max plan

1. **Settings > Connectors > Add custom connector.** Name it `KB Engine`,
   paste your Engine address (ending in `/mcp`), and sign in.
2. Add the plugin: in the Claude app's plugin settings choose **Add
   marketplace**, enter `imagicrafter/kbe-coldstart-test` (or
   `https://github.com/imagicrafter/kbe-coldstart-test`), then install **kb-engine**.
   Menu names differ between app versions.
3. Connect the sources you want to feed: Gmail, Google Drive, Fireflies,
   Google Calendar.
4. Say "set up ingest". The `kb-schedule-setup` skill does the rest.

**claude.ai asks for the URL at install** (confirmed live, 2026-11-20). Its
URL box may show the raw text `${user_config.engine_url}`: that is the
plugin's placeholder, not an address. Clear the whole box and paste your
Engine address, for example `https://kb.example.com/mcp` (the sign-in setup
page and the Health screen show it). If you already added the connector in
step 1, the plugin's copy is the same Engine; keep one of them on.

**No email prompt when you connect?** Expected when this browser is already
signed in to the Engine's Cloudflare sign-in (for example from opening
`/app`): Cloudflare reuses that sign-in and Claude connects straight away.

### Team or Enterprise

An owner adds the custom connector once for the organisation (**Organisation
settings > Connectors**) and adds this marketplace to the organisation's
plugins. Each member then signs in to the connector with their own account
(the Engine only accepts people its owner has added) and runs "set up
ingest" in their own Claude. Each person's items are stored as theirs.

## Test A4: first install on a Pro plan (about 10 minutes)

Use an Engine that already has the person added. Nothing here changes the
Engine's people, topics or settings.

1. **Install (3 min).** Follow "Claude app on a Pro or Max plan" steps 1 to
   3 with Gmail connected. Record whether adding the marketplace worked
   first time (it failed for one tester on 2026-11-17).
2. **Check the connector (1 min).** In a new chat: "Call get_ingest_plan for
   gmail." Expect `first_run: true`, `since` 7 days back, `max_items: 25`.
3. **Run by hand with about 5 items (3 min).** In a new chat, pick the
   smallest model and say: "Run kb-ingest for gmail, but stop after 5
   items." Expect one line like `kb-ingest gmail: listed 5, saved 5 (new 5,
   new versions 0, unchanged 0), failed 0`. Run it again: expect the same
   items to come back `unchanged`, or only newer mail.
4. **Check the Engine (1 min).** Open the Engine's status page: Gmail's
   "last received" is now, and the counts went up.
5. **Schedule (2 min).** Say "set up ingest" and follow `kb-schedule-setup`
   for Gmail only. Click **Schedule**. Note whether the model choice offered
   Haiku and whether the task ran with the computer asleep.
6. **Next morning.** Open the task's run history: each run should end with
   the one-line report. Any "waiting for approval" means a tool permission is
   still on "Needs approval": set that read tool to "Always allow".

Write down for the build log: plan type, app version, which steps failed,
and the report lines.
