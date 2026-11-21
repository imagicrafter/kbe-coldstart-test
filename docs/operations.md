# Operations

Running an Engine after it is set up: checking health, reading the issue
log, updating, backing up, restoring, and removing a deployment.

In Claude Code, the `kb-engine-admin` skill walks through the day-to-day
tasks on this page. Commands run from the repo root with
`PYTHONPATH=scripts:.`.

## Health

```
python -m kbe deploy status
python -m kbe sources list
python -m kbe access status
python -m kbe tags audit
```

| Command | Healthy looks like |
|---|---|
| `kbe deploy status` | Active deployment `ACTIVE`; each job's last run listed without a failure |
| `kbe sources list` | Every enabled source `ok`. `failing` shows how many runs in a row failed. `never run` is normal before the first schedule |
| `kbe access status` | `setup: complete`, `sign-in settings: present`, `admin pages app: present` |
| `kbe tags audit` | No unknown tags; the untagged count is what the owner expects |

Other places to look:

- **`/health`** on the app's own address (`<name>.ondigitalocean.app`)
  returns `{"ok": true, ...}` with the deployed commit. On the Engine's
  hostname, Cloudflare asks for a sign-in first.
- **The status page**, `https://<host>/status`. Owner only, with a second
  factor. It shows the sources, the topics, the review state, the people and
  the security layers.
- **Logs.** In the DigitalOcean dashboard: the app, the component, Runtime
  Logs. The service and the jobs never log a secret or document text.
- **Alerts.** The app spec asks DigitalOcean to alert on a failed
  deployment, a failed domain, repeated restarts and high memory use.
  DigitalOcean sends them to the account's contacts.

The full check is `python -m kbe verify`. It runs every check in
`setup/manifest.yaml` against the live deployment. A skipped check counts as
a failure. `python -m kbe verify --phases <a,b>` runs some of them.

### The schedule

Each enabled source has its own job, so one failing source does not stop the
others. The jobs run once a day, 20 minutes apart, starting at 11:00 UTC, in
this order: wiki, Drive, Fireflies, Gmail. A job that finds sign-in not set
up exits without reading anything.

To run a source from the owner's machine:

```
python -m pullers.runner --source wiki --dry-run
python -m pullers.runner --source wiki
```

The second form does the real work, including model calls.

### The curator timer

When the curator runs (migration 0057, decided 2026-11-20): there is no interval to choose. New source items wake it at once (a trigger on `source_items`), at most once every 2 minutes; a minute job (`kbe-curator-wake`, plain SQL) wakes it again only when items arrived since the last wake are still waiting; and a fixed hourly tick (`kbe-curator-tick`, minute 0) always runs as the safety net for retries, missed items, summaries, history pruning and the nightly backup. An hour with nothing waiting spends no model tokens.

On an Engine set up from the app, use the **Timer** setup screen (`/setup/timer`): it shows the full tick address, has one switch (curator on or off), makes the timer secret inside the database, schedules both cron jobs, and has a **Test the timer now** button that shows what the poke got back. The model key goes in on the **Model key** screen, and the templates on the **Template** screen (they are no longer a column of `curator_settings`; migration 0054 moved them to `engine_templates`). The SQL below is the same thing by hand.

The curator and the service's own chores run when Supabase cron pokes
`POST /internal/curator/tick`. Nothing in this repository creates the cron
job; an operator does, once, in the SQL editor:

```sql
-- 1. Two secrets in the vault (never in a table or the cron command):
select vault.create_secret('<64 random characters>', 'kbe_tick_secret');
select vault.create_secret('<DigitalOcean model access key>', 'kbe_model_key');
-- 2. Where to poke, the model, the templates, and on:
update workspace.curator_settings
   set engine_url = 'https://<engine host>/internal/curator/tick',
       model = 'openai-gpt-oss-120b',      -- or 'deepseek-v4.1-flash'
       enabled = true;
-- 3. The timer (needs pg_cron and pg_net):
select cron.schedule('kbe-curator-tick', '0 * * * *', 'select workspace.curator_tick_poke()');
select cron.schedule('kbe-curator-wake', '* * * * *', 'select workspace.curator_wake(true)');
```

(With another schema name, use it in place of `workspace`.)

Each poke sends the vault secret in the `X-Kbe-Tick` header. The service
does not hold the secret: the database compares what arrived with the vault
copy. A wrong or missing secret gets 401. The service answers at once (202)
and runs in the background; a poke during a run answers `{"busy": true}`,
and only one run goes at a time across instances.

Every run, whether or not the curator is on:

- reads failed pokes since the last run from `net._http_response` (cron
  reports success even when the HTTP call failed) and logs them;
- thins page history (`page_history_prune`).

When the curator is on and `kbe_model_key` is in the vault it also applies
approved reviews, curates up to `batch_size` items (default 10) and writes
up to 20 page summaries. `curator_runs` keeps one row per run with its
counts.

**First load.** For a large backlog, poke once with batch mode; it keeps
claiming items until none are left or about 12 minutes have passed:
`select workspace.curator_tick_poke('batch');`

**Sign-in in front of the service.** The tick path carries no Cloudflare
Access sign-in. The sign-in setup (the `/setup` page or `kbe access setup`)
now adds a bypass application for `/internal/curator/tick` only. An Engine
whose sign-in was set up earlier needs the sign-in setup run once more, or
the pokes are stopped at the edge (the Timer screen's test shows 302 or 403).

**Stopping it.** `update workspace.curator_settings set enabled = false;`
stops curation at the next run and stops the wakes; the chores go on. `select
cron.unschedule('kbe-curator-tick'); select cron.unschedule('kbe-curator-wake');`
stops the timer.

## The Engine's hostname on DigitalOcean

DigitalOcean's edge only answers for hostnames listed on the app; any other
Host gets "not found". The sign-in setup points DNS at the app in Cloudflare
but does not add the hostname to the app (seen live 2026-11-20). Add it once:

1. DigitalOcean: your app, **Settings**, **Domains**, **Add domain**.
2. Type the hostname. Choose **You manage your domain** (Cloudflare holds the
   DNS; do not let DigitalOcean change it). Save; the app redeploys.
3. Or: `doctl apps spec get APP_ID > spec.yaml`, add
   `domains: [{domain: <host>, type: PRIMARY}]` at the top level, then
   `doctl apps update APP_ID --spec spec.yaml`.

The Health screen (`/setup/health`) checks it: "Hostname reaches the app"
posts to the timer path without a secret and expects this app's own 401.
Setup does not do this itself: it would need a DigitalOcean token with
rights over every app on the account, one more secret to ask for and keep.

## The issue log

The Engine keeps one table of its own problems.

| Category | Logged by | Meaning |
|---|---|---|
| `source_failure` | A job | A run failed. Repeats update the same issue and count up |
| `config_invalid` | The wiki job | `engine.yaml` in the knowledge repo is not valid. The last good config stays in force |
| `data_quality_issue`, `feature_gap`, `friction_point` | A signed-in person, through the `report_issue` tool in Claude | Something wrong, missing or awkward. At most 10 reports per person per hour |
| `unknown_tag` | A job | One issue per source while any of its documents carries a tag that names no topic. Holds a count and the tag texts, never a title. Closes on the first run with none left |

An issue holds a category, a source name, an error class and a short message
with content removed. It never holds document text, a document title or a
participant's name.

A `source_failure` issue closes by itself on that source's next clean run.

### Reading it

- `python -m kbe issues list` lists the open issues, newest first. `--all`
  adds closed ones (the newest 200). `python -m kbe issues show <id>` shows
  one issue with its detail. Both are read-only and answer administrators
  only (`--as EMAIL` names one; the default is the owner).
- The status page lists the open issues under its **Support** menu, with
  the number fixed in the last 30 days, the Care Plan line and whether the
  newest config is in force.
- An administrator can ask Claude: the connector tool `admin_list_issues`
  returns the open issues. Other people do not have the tool.
- `python -m kbe sources list` shows which source is failing.
- The job's Runtime Logs in the DigitalOcean dashboard show the error.
- With support access on, a support person reads the same view. See
  [care-plan.md](care-plan.md).

### Acting on it

| Issue | Usual cause | Action |
|---|---|---|
| A source keeps failing | An expired or revoked credential | `python -m kbe sources <wiki\|fireflies\|drive\|gmail> check`, then rotate the secret |
| `unknown_tag` | A mistyped tag, or a topic removed from the config | `python -m kbe tags audit --source <name>` lists the items; fix the tag at the source, or add the topic |
| `config_invalid` | A bad edit | `python -m kbe config validate <path>`, fix, commit, push, `python -m kbe config apply <path>` |
| A job logs "setup not complete" | No sign-in settings | `python -m kbe access status`; finish setup |
| Search results are thin | Sources have not run, or documents are untagged | `python -m kbe sources list`, `python -m kbe tags audit` |

## Updates

Every Engine builds from the same public repository, branch `stable`. A fix
reaches an Engine when its app is deployed again.

**An Engine made with the "Deploy to DigitalOcean" button** (README) does
not update itself: a new release on `stable` changes nothing until the
owner redeploys. In the DigitalOcean dashboard open the app, then
**Actions -> Force Rebuild and Deploy**. The app's Database screen applies
any new migrations the release brings (open `/setup/database` again after
the rebuild, or run `python -m kbe db migrate`). Read `CHANGELOG.md` first.

**An Engine deployed with `kbe deploy`**:

```
git pull
python -m kbe db migrate --dry-run
python -m kbe db migrate
python -m kbe deploy render
python -m kbe deploy apply --dry-run
python -m kbe deploy apply
python -m kbe deploy redeploy
python -m kbe deploy status
```

- Read `CHANGELOG.md` first. It says when a release needs more than this.
- Database first, then the app. New code expects the new database.
- `deploy apply` reads the live spec, keeps every stored secret value, and
  shows a diff of the rest. It lists the app's secrets by name only: DigitalOcean
  does not reveal which ones hold a value. For a new secret a release adds,
  put it in the local env file and run `python -m kbe deploy secrets push`
  (a preview; `--yes` sets it), or enter it in the dashboard.
- `migrate` refuses to run if an applied file has changed. Do not edit
  migration files. If this happens after a `git pull`, stop and read the
  release notes.

There is no automatic update. `deploy_on_push` is off: an Engine changes
only when its owner deploys.

### Rolling back

- **The app:** in the DigitalOcean dashboard, the app's Activity tab can
  roll back to an earlier deployment.
- **The database:** migrations are not reversed automatically. Each file
  ends with the statements that undo it, as comments, for a person with
  database access to run by hand. Restore from a backup if in doubt.

## Backups

What holds what, and how it is protected:

| Data | Where the original is | Backup |
|---|---|---|
| Pages (in the database) | The database | Supabase backups, and the nightly GitHub backup below |
| Wiki pages and the config (repo mode) | The knowledge repo on GitHub | Git history; every clone is a copy |
| Drive files, meeting recordings | Google Drive, Fireflies | Those services |
| The index (raw captures, documents, summaries, vectors) | The database | Can be rebuilt by running the jobs again |
| People, topic grants | The database only | Supabase backups |
| Review decisions (what is approved) | The database only | Supabase backups |
| The issue log, run events | The database only | Supabase backups |
| Sign-in settings | The database; the originals are in Cloudflare | Can be stored again with `kbe access adopt` |
| Secrets | The owner's password manager, the DigitalOcean dashboard | The owner's password manager |

Supabase backs up a project's database on a schedule that depends on the
plan. Check the project's backup settings and current plan terms. The
people, grants and review decisions exist nowhere else, so they are what a
database backup is for.

To keep an extra copy of the people and grants as text:

```
python -m kbe people list --json
```

The output has names and emails but no secret. Store it somewhere private.

### The nightly GitHub backup

The Engine owner can have every page written to one **private** GitHub
repository each night (`/setup/backup`). The files open as an Obsidian
vault: one Markdown file per page named by its title, a folder per drawer,
the header as frontmatter (`title`, `aliases`, `description`, `type`, `key`,
`owner`, `topics`, `status`, `tags`, `related`, `sources`, the drawer's
fields), links written as `[[Title]]`, and a generated `index.md` (pages by
drawer) and `log.md` (recent changes). A rename is a file move in the same
commit.

- **One way.** The database always wins. The whole branch is rewritten from
  the database each run; anything edited in the repository is overwritten,
  and nothing is read back. A night with no change makes no commit.
- **Owner only.** The repository holds every person's pages with no sharing
  rules, so only the Engine owner (the config's `engine.owner.email`, else
  the first administrator) can see or change this screen. The run refuses a
  public repository.
- **The token.** A fine-grained GitHub token for that one repository, with
  *Contents: read and write*. It is typed into the screen and kept in
  Supabase Vault (`kbe_backup_token`); it is never shown again, logged or
  stored elsewhere.
- **When.** On the curator timer (Timer screen), at most once every 20
  hours. "Back up on the next timer run" on the screen skips the wait.
  The last run's result (done, unchanged or failed, with the reason) is on
  the screen.
- **Restoring from it** is a one-time import: `python -m kbe pages import
  <checkout> --owner <email>` (below) files the pages for one person. It does
  not bring back history, owners or links between owners.

## Importing an existing wiki

A one-time move of an OKF or Obsidian wiki (a folder of Markdown files with
frontmatter) into pages, for one person:

```
python -m kbe pages import ~/path/to/wiki --owner person@example.com
python -m kbe pages import ~/path/to/wiki --owner person@example.com --topic consulting --apply
```

The first command only reads the folder and reports: how many pages per
drawer, the key each gets, which keys fell back (a person page with no
`email`, an organisation with no `domain` or `website`, a meeting with no id),
which files are skipped and why, and which frontmatter keys are not carried
over. `--json` lists everything. `--apply` (after a yes; `--yes` to skip the
question) saves them over the direct database connection (`KBE_DATABASE_URL`).

- `type` picks the drawer (`person` -> people, `meeting` -> meetings,
  `company` -> organisations, `retrospective` -> playbooks, ...), else the
  folder name. Files that map to no drawer are skipped and listed.
- `related` and `[[links]]` become links: the database resolves each title
  or alias to a page key as the pages are saved.
- A key the person already holds is left alone, so a second run adds only
  what is new. Nothing is overwritten.
- Pages get only the topics named with `--topic`, and only topics the person
  holds. Without `--topic` they are the person's alone.
- `index.md`, `log.md`, `README.md`, dot-folders, `templates/` and `sources/`
  are skipped. Old `created`/`updated` dates are not kept.
- After the import, archive the old repository: the Engine is now the home
  of these pages.

## Server mode (the Python pullers)

The default Engine is one service: sources come in through each person's
Claude (the plugin, `docs/plugin.md`) and the curator runs inside the
service. The Python pullers in `pullers/` (wiki repo, Drive, Fireflies,
Gmail on a schedule) are **server mode**, off by default:

- the "Deploy to DigitalOcean" button never creates puller jobs;
- `python -m kbe deploy render` adds them only with `--server-mode` (one
  scheduled job per source enabled in the config). The choice is remembered
  for the next render; `--no-server-mode` turns it off again.

To turn server mode on for an Engine deployed with `kbe deploy`:

```
python -m kbe deploy render --server-mode
python -m kbe deploy apply --dry-run
python -m kbe deploy apply
python -m kbe deploy secrets push
```

The jobs need their own secrets (the model key and each source's
credentials; `deploy render` lists them). Turning it off and applying
removes the jobs (`deploy apply` asks before it deletes a live component).

## Restoring

### The database is lost, everything else is intact

1. Restore the Supabase backup if there is one. Then run
   `python -m kbe db migrate --dry-run` to confirm nothing is pending, and
   `python -m kbe verify`.
2. With no backup, build a new database:

   ```
   python -m kbe db migrate
   python -m kbe db expose-schema
   python -m kbe db deploy-functions
   python -m kbe config apply <knowledge repo>/.kb-engine/engine.yaml
   ```

   Mint the embed token again and enter it in the dashboard
   (`python -m kbe tokens mint --embed --write-env --clipboard`: the token
   goes into the local env file and onto the clipboard, and is not printed).
   Store the sign-in settings again. Their values are in the Cloudflare
   dashboard: the team domain, and the AUD tag of each of the two
   applications.

   ```
   python -m kbe access adopt --team-domain https://<team>.cloudflareaccess.com --aud <AUD> --status-aud <AUD> --host engine.example.com --level people --dry-run
   ```

   Add the people and grants again (`kbe people add`, `kbe people grant`).
   The jobs rebuild the index on their next runs. Review decisions are not
   rebuilt: everything is unreviewed again.

   If the project itself is new, the three Supabase secrets on every
   component change too.

### The app is lost

```
python -m kbe deploy render
python -m kbe deploy apply
```

With no app id in local state this creates a new app. Enter every secret
again. The new app has a new address of its own, so the DNS record must
point at it: reopen setup (`kbe access reopen`) and run the setup page, or
change the CNAME in Cloudflare by hand. (`kbe access setup` is for an Engine
that has no sign-in yet; here sign-in exists, so the page is the way.)

### The owner's machine is lost

Clone this repository and the knowledge repo again. Make a new `.env` from
`.env.example`. The local state file is gone; pass `--app-id`, `--path` and
`--as` where a command asks, or run `kbe deploy status --app-id <id>` and
`kbe config apply` once to record them again. Rotate any secret that was
only on that machine.

## Removing a deployment

There is no single command. In this order:

1. **Support access**, if on: `python -m kbe support disable`.
2. **The app:** `doctl apps delete <app id>` (the id is shown by
   `python -m kbe deploy status`). Billing for the app stops.
3. **Cloudflare**, in the dashboard: the applications `KB Engine: <host>`
   and `KB Engine admin pages: <host>`, the rules
   `KB Engine sign-in: <host>` and `KB Engine administrators: <host>`, and
   the CNAME record for the hostname.
4. **The database:** delete the Supabase project. If the project is shared
   with something else, a person with database access drops the Engine's
   schema and the roles `kb_engine`, `kb_ingest` and `kb_support` instead,
   and deletes the `embed` function.
5. **Credentials:** delete the GitHub token, the Fireflies API key if it was
   made for this, the DigitalOcean inference key, and the app's access in
   the Google account (myaccount.google.com/permissions).
6. **The owner's machine:** delete `.env` and `.kb-engine-local/`.

The knowledge repo is the owner's and stays. Nothing in the sources is
touched by removing an Engine.
