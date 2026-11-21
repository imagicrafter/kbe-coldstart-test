# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

An entry says so when updating needs more than the steps in
[`docs/operations.md`](docs/operations.md#updates).

## Unreleased

### Fixed

- **Consensus no longer drops a deal over its name.** Runs compare deals and
  projects by their organisation (`key_rule.anchor` in the template), not by
  the free slug, and an open deal for that organisation is updated instead of
  a second one made. Field values are normalised before the vote ($12,000 =
  12000, dates by day, enums by case); free text votes only on being set.
  Indexing shows each uncertain decision's three proposals side by side.

### Changed

- **Product name: Quantabase.** The app, the status page, the plugin and the
  docs say Quantabase (was "Knowledge Base Engine"). Internal identifiers,
  package names, environment variables, the database schema and the
  repository name are unchanged.
- **Topics come from source tags (migration 0060).** The ingest run passes
  each item's Gmail labels, Drive folders/description tags and Fireflies
  channels (`record_source_item`, `tags`); `topics` is refused. New tags show
  on Topics and people under "Found in your sources", off by default; the
  owner switches one on (with a preview) to make or reuse a topic. Items are
  filed only under switched-on tags' topics. The free-text "New topic" box
  and `app_topic_add` for the service are gone; config-declared topics stay
  for the pullers and migration. See `docs/source-tags.md`.
- **Entity rules are template config.** The deal rule, links between
  drawers, drawer icons and meeting-key sources moved from code into the
  template YAML (`icon`, `curator.links_to`, `curator.notes`,
  `curator.required_when`, `key_rule.sources`); see `docs/templates.md`.
- **Required drawers are checked.** When an item matches a drawer's
  `required_when` pattern (consulting/membership deals: money, price, quote,
  proposal, SOW) and the reply makes no page there, the curator asks once
  more, then records a failed check.
- **Repeated facts are skipped.** A line near-identical to one already on
  the page (ignoring dates) is not added again, e.g. from a re-sent email.
- **Page viewer** shows "Last change" (when, by whom, from which item) with a
  link to that change's diff.

- **Page history keeps the newest 10 versions** of every page whatever their
  age, on top of the time thinning (migration 0061).

- **Consensus curation (migration 0062).** Each item is curated twice with
  the primary model in parallel; only structured decisions are compared
  (target pages and create/patch, field values), never wording. Agreement
  applies run 1. A difference brings one tiebreak run (default
  deepseek-v4.1-flash) and each decision goes to the majority, with patch
  text from a run on the winning side. A decision with no majority is
  dropped (not queued) and listed under "Uncertain decisions" on Indexing.
  The required-drawer check runs on the merged result. Settings:
  `curator_settings.consensus` (default on), `model` (primary),
  `tiebreak_model`. Run stats count agreed / tiebreak / uncertain and tokens.

### Follow-up

- Rename the repository, the npm package, the plugin id and internal
  identifiers from `kb-engine` to Quantabase.

- **The curator applies by default.** New deal, offer, program and property
  pages and stage/value changes apply on their own (undoable from page
  history). A change waits for a yes only when the item was flagged as
  possible AI steering, when it would remove 40% or more of a page or a
  whole section, or when it would overwrite a field a person set by hand in
  the app's edit form. Shipped templates list every field as `auto`.
- **Curator prompt:** files a deal page when an item names money or asks for
  a proposal or SOW (drawer signals are now in the prompt), and writes from
  the owner's point of view, naming who did what.
- **Addresses show on signed-in pages.** `/app`, `/setup` and `/status`
  never send a raw `x@y.z`, so the edge's email obfuscation has nothing to
  rewrite into "[email protected]"; the visible text is still the address.
- **One sidebar everywhere:** Home, Knowledge, Review, and Engine (Indexing;
  Settings opens to the setup screens).
- **Database screens** link to Supabase's access-token page and to the
  project's dashboard.

### Added

- **Database update screen** (`/setup/database` after sign-in; migration
  0059). Administrators see migrations applied vs shipped, the pending files
  by name, and apply only those with a one-time Supabase access token (never
  stored, logged or shown); the schema is re-exposed and the Data API told to
  reload. Per-step results and timings. In the setup menu and nav. At boot the
  app logs `database update needed` with the pending names. Health and
  Indexing show "Database update needed: N pending", and any screen whose
  database function is missing (PGRST202) shows that instead of a raw error.
  **Updating to this release:** apply its migration with the new screen once
  (or `kbe db migrate`).
- **Connector approval length follows the sign-in length.** Cloudflare's
  managed OAuth grant for Claude's connector now uses the sign-in length
  chosen at setup (default 1 year) instead of a fixed 7 days; the Sign-in and
  Health screens show both. Run the sign-in setup again to apply it to an
  existing Engine.

- **Deploy to DigitalOcean button** (Step F; `.do/deploy.template.yaml`,
  root `Dockerfile`). One service built from the repository root, so the
  running app carries `supabase/migrations` and the embed function for the
  Database screen. Asks for `SUPABASE_URL`, the anon key and the JWT secret
  only (both SECRET); no `SETUP_CODE` (the app logs a one-time code). Builds
  `stable`. **Updates need a click:** Force Rebuild and Deploy in the
  dashboard (`docs/operations.md#updates`).
- **Nightly GitHub backup** (Step F; migration 0056, `engine/src/backup/`,
  `/setup/backup`). The Engine owner names one private repository and saves
  a fine-grained token (Supabase Vault, `kbe_backup_token`). On the curator
  timer, at most once per 20 hours, every page is written as an Obsidian
  vault (title file names, drawer folders, frontmatter, `[[Title]]` links,
  `index.md`, `log.md`) in one commit. One way: the database wins; an
  unchanged night makes no commit; a public repository is refused.
- **`kbe pages import`** (Step F; `page_import` in 0056). One-time import of
  an OKF/Obsidian wiki as one person's pages: dry-run report first, then
  `--apply`. Never overwrites a key the person holds.

- **Claude plugin** (Step E; `plugin/kb-engine/`, `.claude-plugin/marketplace.json`,
  [`docs/plugin.md`](docs/plugin.md)). This repository is now a plugin
  marketplace. Skills: `kb-ingest` (mechanical copy of one source into the
  Engine) and `kb-schedule-setup` (tool permissions, first run, one scheduled
  task per source on the smallest model). New read-only tool
  `get_ingest_plan` (migration 0055, `source_cursor_get`). Pullers are now
  the optional server mode.
- **App screens** (Step D; migration 0054, `engine/src/app/`). Plain
  server-rendered pages in the setup page's style, no script.
  - *First run:* a new Engine with no `SETUP_CODE` logs a one-time code;
    `/setup?code=` claims it (single use). The **Database** screen takes the
    Supabase project ref and one access token (used once, never kept) and
    sets the project up through the Management API: migrations, schema
    exposed, embed function, embed token in Vault, owner stored. Then the
    existing Cloudflare sign-in screen, which takes its code from the claim.
  - *After sign-in, administrators only:* **Topics and people**, **Template**
    (stored in the new `engine_templates`; `get_entity_schema` defaults to it
    and `save_page` accepts only its drawers), **Model key** (into Vault as
    `kbe_model_key`), **Timer** (Supabase cron job, secret made in the
    database, a test poke), **Health** (checks and the connector address).
  - *Owner screens* under `/app`: changes waiting for your yes (with a diff),
    flagged items (release or discard), your pages with a plain edit box
    (same write path and hash check as `save_page`), history with restore.
  - Sign-in setup adds a bypass application for `/internal/curator/tick`
    only, so Supabase cron reaches the timer path.

- **The curator, inside the service** (migration 0053, `engine/src/curator/`).
  Turns raw items into small page patches with a DigitalOcean model
  (`openai-gpt-oss-120b` by default, `deepseek-v4.1-flash` allowed; a
  database setting). Matches by key, then keyword, within the item owner's
  pages and the item's topics only. Strict reply check; large changes
  (stage, value, new deal, large text) wait for the owner's yes in
  `curator_reviews`; items that look like steering attempts wait for their
  owner. Writes page summaries and embeddings and clears "summary needed".
  Started by a Supabase cron poke on `POST /internal/curator/tick` with a
  vault-held secret; each run also thins page history and reports failed
  pokes. Off until turned on; no cron job is created. **Updating needs more
  than the usual steps** to turn it on: see
  [operations.md](docs/operations.md#the-curator-timer).

- **`kbe access setup`.** Sets up Cloudflare sign-in with one command. What
  is left for the owner: open one link, click Create in Cloudflare and copy
  the token, and say yes. The command reads the hostname and the owner from
  the applied config; makes the setup code in memory, stores its hash, sets
  it as `SETUP_CODE` on the app and follows the deployment; prints a link
  that opens Cloudflare's token screen with the three permissions filled
  in; reads the token from the clipboard (`--token-file PATH` elsewhere);
  shows the app's own list of every change and applies it after a yes (or
  with `--yes`); then blanks `SETUP_CODE`, clears the clipboard and checks
  the result. Neither the code nor the token is ever shown or stored. A
  second run finishes an interrupted one. `--dry-run` changes nothing. It is
  for an Engine with no sign-in yet; changing sign-in later still goes
  through `kbe access reopen` and the page. **Updating:** the app must run
  this version first (`kbe deploy redeploy --yes`); an older app is named
  as such and nothing is changed in Cloudflare.
- **Setup says what still needs a click.** After every step has succeeded
  the app reads the two applications back (one read, no write) and reports
  three settings: Managed OAuth, Claude's redirect addresses, the second
  factor on the admin pages. `kbe access setup` and the result page give one
  line for each that is not in place, with where to click.
- **`kbe access setup` waits for the new hostname.** A new hostname answers
  "not found" (404) for a minute or two after setup. The command asks again
  every ten seconds, for up to four minutes, and prints its progress.
- **An account that never opened Zero Trust is named plainly.** The step
  fails before anything is created; the command says where to go and what
  to pick, then to run it again. The setup skill asks about it in its
  accounts list.
- **The setup routes answer as data when asked.** `POST /setup/preview` and
  `POST /setup/apply` return JSON to a request with
  `Accept: application/json`. Same routes, same setup code check, lockout,
  signature and validation; only the shape of the answer differs.
- **A link that fills in the Cloudflare token's permissions**, on the setup
  page and in `kbe access setup`, in the form Cloudflare documents
  ([API token template URLs](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/)).
  The link cannot limit the token to one account or one zone, or set an end
  date; both places say what to set by hand.
- The setup page fills in the hostname from the applied config, and, when
  setup was reopened, the hostname and level in force.
- **`kbe deploy secrets push`.** Sets the DigitalOcean app's secrets from the
  local env file, so nobody types them into the dashboard or pastes one into
  a chat. It reads the live spec, previews one line per secret by name
  (`will set`, `no local value, left as it is`) and never shows a value or a
  length. `--yes` applies. DigitalOcean does not reveal whether a secret
  already holds a value, so every secret with a local value is set, each
  time; it is safe to run again. Nothing but secret values changes. `EMBED_TOKEN` on the service takes `KNOWLEDGE_EMBED_TOKEN`.
  `--setup-code-from-clipboard` takes `SETUP_CODE` from the clipboard
  (macOS). Applying starts a new deployment.
- **`kbe env check`.** Says what each line of the local env file holds, by
  name only: `set`, `empty`, `still the example placeholder`,
  `wrapped in <...> (remove the brackets)` or `not in the file`, grouped by
  needed now, filled in by a later step, and optional. It also notes a
  `SUPABASE_ACCESS_TOKEN`, a `*_URL` or a `KBE_DATABASE_URL` that does not
  start the way it should.

### Changed

- **Pullers are server mode, off by default.** `kbe deploy render` adds the
  puller jobs only with `--server-mode` (remembered). **An Engine that runs
  the pullers today must render with `--server-mode` once**, or the next
  `deploy apply` proposes removing its jobs (it asks first).
- `app_secret_set` also takes `kbe_backup_token` (the owner only).

- Approving a curator change and releasing a flagged item are possible only
  on the app screens. The OAuth-subject functions `curator_review_decide`,
  `source_item_release` and `curator_review_list` are dropped (0054).
- `curator_settings.templates` is moved to `engine_templates` and dropped.
- `EMBED_TOKEN` is optional: without it the service reads `kbe_embed_token`
  from Vault.
- The "missing in your local env file" error now adds, when a name still
  holds a `<...>` value: "A value wrapped in <...> counts as not filled in;
  remove the brackets."
- The setup skill uses `kbe env check` after the env file is filled in and
  `kbe deploy secrets push` to set the app's secrets. The dashboard is the
  fallback.
- The setup skill's step 10 is `kbe access setup`; the setup page is the
  fallback. Step 9 no longer makes a setup code: nobody handles it.
  `kbe deploy secrets push --setup-code-from-clipboard` stays for the page.

### Fixed

- **Cold-start setup on DigitalOcean.** A failed Cloudflare apply or
  Database run answered 502, which DigitalOcean's edge replaces with its own
  "failed to forward" page; both now answer 422 and show the report. The
  token now also needs **Zone - Zone - Read** (Cloudflare lists zones only to
  a token with it); the link asks for it. A failed token check names the
  sub-check that failed with Cloudflare's status and codes, on the page and
  in the log (never the token). The apply step repeats the token link and
  instructions, written for Cloudflare's new Policies-card screen ("Write",
  pencil to narrow, Custom expiry). `GET /setup/preview` and `/setup/apply`
  go back to `/setup`. The Database screen shows a done state with the
  results and a "run again" link, and logs each step's time. A claimed
  session sees the stored owner on the sign-in form.
- `kbe access init` and `kbe access reopen` failed over the REST API with
  "engine_setup_reopen returned something unreadable" after the database had
  already stored the new setup code, so the code was lost. A call that
  answers with an empty body is now a success.
- `kbe deploy secrets push` said every secret was "already set" on a new app
  and set nothing. The live spec carries an encrypted text for every
  declared secret, also for one never given a value. The push no longer
  tries to tell them apart, and `--overwrite` is gone. For the same reason
  `kbe deploy apply` no longer marks secrets `[set]` or `[NOT SET]`: it
  lists their names.

- `kbe deploy apply` showed "doctl could not create the app: exit 1" and hid
  the reason. `doctl` writes its error to standard output; that text is now
  shown, with every known credential masked.

## 1.0.0-rc.1 - 2026-11-16

First release candidate. One repository for every Engine: nothing
owner-specific is in the code.

### Added

- **Config in the owner's knowledge repo.** One file,
  `.kb-engine/engine.yaml`, names the owner, the topics, the sources, the tag
  prefix and the summary model. It is validated by two validators that must
  agree, applied to the database, and read from there by the service and the
  jobs. An invalid file is rejected whole and the last good config stays in
  force. Reference: `docs/configuration.md`.
- **The `kbe` command line** (`python -m kbe`): `doctor`, `db` (migrate,
  adopt, deploy-functions, expose-schema, render), `config` (validate,
  apply), `repo` (init, status), `deploy` (render, apply, redeploy, status),
  `access` (init, reopen, status, adopt), `sources` (list, and a credential
  check for the wiki, Fireflies and Drive; the Drive sign-in), `people`
  (list, add, grant, revoke, deactivate), `support` (enable, disable,
  status), `tags` (audit, suggest, apply, authorize) and `verify`.
- **A configurable schema.** `KB_SCHEMA` chooses the schema that holds the
  Engine (default `workspace`). Migrations are rewritten for the chosen name
  as they are applied.
- **Tagging at the source.** A document's topics come only from tags a
  person can see and change: page frontmatter, a Drive description, a
  Fireflies channel, then the source's default topic, then `unclassified`.
  An unknown tag never widens access. Reference: `docs/tagging.md`.
- **Untagged material is indexed and owner-only.** `unclassified` is a
  sensitive topic held by the owner alone.
- **The setup page.** A new Engine starts in setup mode, where only
  `/health` and `/setup` answer. `/setup` creates the Cloudflare DNS record,
  the two Access applications and their rules from a one-time code and a
  single-use Cloudflare API token that is never stored. Reference:
  `docs/security.md`.
- **No ingestion before sign-in is set up.** The jobs exit without reading
  anything until sign-in settings exist.
- **The issue log.** Failed runs, rejected configs and problems reported by
  people from Claude (`report_issue`) are recorded without document text,
  titles or names.
- **Administrator tools on the connector.** List people, add a person,
  grant and revoke a topic, deactivate a person. Each change is a preview
  followed by a confirmation.
- **Support access.** An optional database login that can read the issue
  inbox and mark issues, and nothing else. Reference: `docs/care-plan.md`.
- **The status page** at `/status`, behind its own Access application with
  a second factor.
- **The setup manifest** (`setup/manifest.yaml`): eighteen phases, each with
  runnable checks, run by `kbe verify`.
- **Guided setup and administration** for Claude Code: `CLAUDE.md` and the
  skills `kb-engine-setup`, `kb-engine-admin` and `kb-engine-tagging`.
- **Documentation** in `docs/`: manual, build manual, architecture,
  configuration, operations, roles, security, tagging, support access.
- **A starter knowledge repo** in `templates/knowledge-repo/`.
- MIT licence, `SECURITY.md`, this changelog.

### Changed

- Sign-in settings (team domain, application AUD tags, hostname, level) are
  read from the database once setup completes. The four sign-in environment
  variables still work for a deployment that sets them.
- The app spec is rendered per Engine from a template: the service plus one
  scheduled job per enabled source, with every secret declared and no value.
- The setup manifest moved to `setup/manifest.yaml`, with its phases in the
  order a new setup reaches them.

### Removed

- Keyword and folder-name rules for deciding a document's topics.
- Owner-specific topics, addresses and hostnames from the code and from the
  seed rows of earlier migrations.

### Known limits

- Sign-in is by one-time code sent to email. No other sign-in method.
- Most of the setup page's Cloudflare calls were checked against a live
  account on 2026-11-17. A few were not, among them switching on the
  account-wide second factor (`docs/security.md`, section 7).
- For the first minute or two after setup the hostname may answer 404.
- The Gmail source reads one mailbox only.
