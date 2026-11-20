"""`kbe pages import` -- file an existing Markdown wiki as one person's pages.

    kbe pages import FOLDER --owner EMAIL [--topic T ...] [--skip DIR ...] [--json]
    kbe pages import FOLDER --owner EMAIL --apply [--yes]

One-time, for moving an existing OKF / Obsidian wiki into the Engine. The
mapping is in pages_import.py. Without --apply nothing leaves this machine: the
command reads the folder and prints what it would file, under which drawer and
key, and what it would skip and why. With --apply (after a yes) each page is
saved through `page_import` over the direct database connection
(KBE_DATABASE_URL). A key the person already holds is left alone and reported,
so a second run only adds what is new.

Pages get only the topics named with --topic, and only ones the person
already holds; without --topic they are the owner's alone.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from . import config_store, pg, schema as kb, secrets
from .context import Context
from .errors import KbeError, UsageError
from .pages_import import Plan, plan

_SHOW = 15


def _store(ctx: Context) -> config_store.ConfigStore:
    values = secrets.load(ctx.env_file)
    return config_store.DbStore(pg.connect(values, ctx.runner), kb.chosen(values), role=None)


def report(result: Plan, owner: str, topics: list[str]) -> list[str]:
    """The dry-run report, as lines."""
    lines = [f"Would file {len(result.pages)} pages for {owner}; skip {len(result.skipped)} files."]
    lines.append("Topics: " + (", ".join(topics) if topics else "none (pages stay the owner's alone)"))
    for drawer, count in result.by_drawer().items():
        lines.append(f"  {drawer:<14} {count}")
    noted = [p for p in result.pages if p.notes]
    if noted:
        lines.append(f"Keys or fields to check later ({len(noted)}):")
        lines += [f"  {p.path}: {p.page['key']} ({'; '.join(p.notes)})" for p in noted[:_SHOW]]
        if len(noted) > _SHOW:
            lines.append(f"  ... and {len(noted) - _SHOW} more (--json lists all)")
    if result.skipped:
        lines.append("Skipped:")
        lines += [f"  {path}: {why}" for path, why in result.skipped[:_SHOW]]
        if len(result.skipped) > _SHOW:
            lines.append(f"  ... and {len(result.skipped) - _SHOW} more (--json lists all)")
    if result.dropped_keys:
        dropped = sorted(result.dropped_keys.items(), key=lambda kv: (-kv[1], kv[0]))
        lines.append("Frontmatter keys not carried over: "
                     + ", ".join(f"{k} ({n})" for k, n in dropped[:20]))
    lines.append("Page dates restart at the import; the old created/updated dates are not kept.")
    return lines


def _as_json(result: Plan) -> str:
    return json.dumps({
        "pages": [{"path": p.path, "drawer": p.page["drawer"], "key": p.page["key"],
                   "title": p.page["title"], "notes": list(p.notes)} for p in result.pages],
        "skipped": [{"path": path, "reason": why} for path, why in result.skipped],
        "dropped_frontmatter_keys": result.dropped_keys,
    }, indent=2, ensure_ascii=False)


def apply(store: config_store.ConfigStore, result: Plan, owner: str, ctx: Context) -> dict[str, int]:
    """Save every planned page. A page the database refuses is reported and skipped."""
    counts = {"created": 0, "exists": 0, "refused": 0}
    for planned in result.pages:
        try:
            answer: Any = store.call("page_import", {"p_owner_email": owner, "p_page": planned.page})
        except KbeError as error:
            counts["refused"] += 1
            reason = str(error).strip().splitlines()[-1][:200]
            ctx.out(f"  refused {planned.path}: {reason}")
            continue
        status = answer.get("status") if isinstance(answer, dict) else None
        counts["created" if status == "created" else "exists"] += 1
    return counts


def _cmd_import(args: argparse.Namespace, ctx: Context) -> int:
    owner = (args.owner or "").strip().lower()
    if "@" not in owner:
        raise UsageError("--owner must be the email of the person the pages are for.")
    topics = sorted({t.strip().lower() for t in args.topic or [] if t.strip()})
    result = plan(Path(args.folder).expanduser(), topics=topics, skip=args.skip or [])
    if args.json:
        ctx.out(_as_json(result))
    else:
        for line in report(result, owner, topics):
            ctx.out(line)
    if not args.apply:
        ctx.out("Dry run: nothing was saved. Add --apply to file these pages.")
        return 0
    if not result.pages:
        ctx.out("Nothing to file.")
        return 0
    if not args.yes and not ctx.confirm(f"File {len(result.pages)} pages for {owner}?"):
        raise KbeError("Not imported. Re-run with --yes to import without being asked.")
    counts = apply(_store(ctx), result, owner, ctx)
    ctx.out(f"Done: {counts['created']} created, {counts['exists']} already there "
            f"(left alone), {counts['refused']} refused.")
    return 1 if counts["refused"] else 0


def register(groups: argparse._SubParsersAction) -> None:
    parser = groups.add_parser(
        "pages", help="import an existing Markdown wiki as pages",
        description="Pages live in the database. `import` files an existing OKF or Obsidian "
        "wiki folder as one person's pages: a dry-run report first, then --apply.",
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="<command>")
    imp = commands.add_parser(
        "import", help="file a Markdown wiki folder as one person's pages",
        description="Reads FOLDER (frontmatter -> header, type -> drawer, related and "
        "[[links]] -> links, keys from the entity templates' rules). Without --apply it "
        "only prints what it would do. A key the person already holds is never changed.",
    )
    imp.add_argument("folder", help="the wiki folder (a vault or a knowledge repo checkout)")
    imp.add_argument("--owner", required=True, metavar="EMAIL",
                     help="the active person the pages are for")
    imp.add_argument("--topic", action="append", metavar="TOPIC",
                     help="file every page under this topic (repeat for more; the person "
                     "must hold it). Without it the pages are the owner's alone.")
    imp.add_argument("--skip", action="append", metavar="DIR",
                     help="also skip folders with this name (templates, sources and "
                     "dot-folders are always skipped)")
    imp.add_argument("--json", action="store_true", help="print the plan as JSON")
    imp.add_argument("--apply", action="store_true", help="save the pages (asks first)")
    imp.add_argument("--yes", action="store_true", help="with --apply: do not ask")
    imp.set_defaults(func=_cmd_import)
