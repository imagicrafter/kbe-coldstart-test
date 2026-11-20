"""Read an existing Markdown wiki (OKF / Obsidian vault) into Engine pages.

No I/O but reading the folder and the entity templates. `plan(folder, ...)`
returns one `Planned` page per file it can file, and the reasons it skipped
the rest; `pages.py` prints the report and, after a yes, saves each page with
`page_import` (supabase/migrations/0056_backup_import.sql).

Mapping, per file:
  drawer      the frontmatter `type` (person -> people, meeting -> meetings,
              ...), else the folder name; a file that maps to no drawer in
              any template is skipped and listed
  key         by the drawer's key rule in engine/templates/entities:
                email      `email` in the frontmatter, else person:<slug>
                domain     `domain` / `website` / `url`, else org:<slug>
                source_id  meeting:<fireflies_id / meeting_id / id>, else
                           meeting:<date>-<slug>
                slug       the rule's own prefix + a slug of the title
              (a fallback key is reported, so it can be fixed later)
  header      title, aliases, description, status, tags, related (titles
              from [[links]]), sources, and the drawer's own fields
  body        everything after the frontmatter, unchanged ([[links]] are
              resolved to keys by the database when each page is saved)
Other frontmatter keys are dropped and counted in the report. Topics are only
those given with --topic: nothing is shared by an import unless asked.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Mapping

from .errors import KbeError

TEMPLATES_DIR = Path(__file__).resolve().parents[2] / "engine" / "templates" / "entities"
SKIP_DIRS = frozenset({"templates", "sources", "excalidraw", "diagrams", "attachments", "assets"})
SKIP_FILES = frozenset({"index.md", "log.md", "readme.md", "claude.md", "agents.md"})
MAX_BODY = 200_000
MAX_DESCRIPTION = 500
MAX_TITLE = 300
STATUSES = ("draft", "unreviewed", "current")

# Frontmatter `type` (or folder name) -> drawer id.
TYPE_TO_DRAWER = {
    "person": "people", "people": "people", "contact": "people",
    "organisation": "organisations", "organization": "organisations",
    "organisations": "organisations", "organizations": "organisations",
    "company": "organisations", "companies": "organisations", "org": "organisations",
    "project": "projects", "projects": "projects",
    "meeting": "meetings", "meetings": "meetings",
    "decision": "decisions", "decisions": "decisions", "adr": "decisions",
    "concept": "concepts", "concepts": "concepts", "reference": "concepts", "note": "concepts",
    "research": "research",
    "playbook": "playbooks", "playbooks": "playbooks", "runbook": "playbooks",
    "retrospective": "playbooks", "incident": "playbooks", "guide": "playbooks",
    "deal": "deals", "deals": "deals", "offer": "offers", "offers": "offers",
    "property": "properties", "properties": "properties", "site": "sites", "sites": "sites",
    "vendor": "vendors", "vendors": "vendors", "program": "programs", "programs": "programs",
}
FALLBACK_PREFIX = {"email": "person", "domain": "org", "source_id": "meeting"}
_EMAIL = re.compile(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}")
_DOMAIN = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}")
_PREFIX = re.compile(r'^"?([a-z][a-z-]*):')
_FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?(.*)\Z", re.S)
_LINK = re.compile(r"^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$")


@dataclass(frozen=True)
class Drawer:
    id: str
    key_kind: str
    prefix: str | None
    fields: tuple[str, ...]


@dataclass(frozen=True)
class Planned:
    path: str
    page: dict[str, Any]
    notes: tuple[str, ...] = ()


@dataclass
class Plan:
    pages: list[Planned] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    dropped_keys: dict[str, int] = field(default_factory=dict)

    def by_drawer(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for p in self.pages:
            counts[p.page["drawer"]] = counts.get(p.page["drawer"], 0) + 1
        return dict(sorted(counts.items()))


def load_drawers(directory: Path = TEMPLATES_DIR) -> dict[str, Drawer]:
    """Every drawer in every template; the first template naming a drawer wins (base first)."""
    import yaml

    files = sorted(directory.glob("*.yaml"), key=lambda p: (p.stem != "base", p.stem))
    if not files:
        raise KbeError(f"No entity templates found in {directory}.")
    drawers: dict[str, Drawer] = {}
    for path in files:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for d in loaded.get("drawers") or []:
            rule = d.get("key_rule") or {}
            prefix = _PREFIX.match(str(rule.get("text") or ""))
            drawers.setdefault(d["id"], Drawer(
                id=d["id"], key_kind=str(rule.get("kind") or "slug"),
                prefix=prefix.group(1) if prefix else None,
                fields=tuple(str(f["name"]) for f in d.get("fields") or []),
            ))
    return drawers


def slug(text: str) -> str:
    out = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return out[:150].strip("-") or "untitled"


def _text(value: Any) -> str:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return "" if value is None else str(value).strip()


def _list(value: Any) -> list[str]:
    if value is None:
        return []
    items = value if isinstance(value, list) else re.split(r"[,\s]+", str(value))
    return [t for t in (_text(v) for v in items) if t]


def _link_target(text: str) -> str:
    match = _LINK.match(text.strip())
    return (match.group(1) if match else text).strip()


def split_frontmatter(text: str) -> tuple[dict[str, Any], str, str | None]:
    """(frontmatter, body, problem). A file with no frontmatter has an empty one."""
    import yaml

    match = _FRONTMATTER.match(text)
    if not match:
        return {}, text, None
    try:
        loaded = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        return {}, text, "the frontmatter is not valid YAML"
    if loaded is None:
        loaded = {}
    if not isinstance(loaded, dict):
        return {}, text, "the frontmatter is not a mapping"
    return {str(k): v for k, v in loaded.items()}, match.group(2), None


def _drawer_for(fm: Mapping[str, Any], rel: Path, drawers: Mapping[str, Drawer]) -> str | None:
    for raw in (_text(fm.get("type")).lower(), rel.parts[0].lower() if len(rel.parts) > 1 else ""):
        drawer = TYPE_TO_DRAWER.get(raw, raw if raw in drawers else None)
        if drawer in drawers:
            return drawer
    return None


def _first_email(fm: Mapping[str, Any]) -> str | None:
    for name in ("email", "emails", "email_address"):
        for value in _list(fm.get(name)):
            if _EMAIL.fullmatch(value.lower()):
                return value.lower()
    return None


def _first_domain(fm: Mapping[str, Any]) -> str | None:
    for name in ("domain", "website", "url", "web"):
        for value in _list(fm.get(name)):
            host = re.sub(r"^[a-z]+://", "", value.lower()).split("/")[0].removeprefix("www.")
            if _DOMAIN.fullmatch(host):
                return host
    return None


def derive_key(drawer: Drawer, fm: Mapping[str, Any], title: str) -> tuple[str, str | None]:
    """(key, note). The note says when the template's rule could not be met."""
    if drawer.key_kind == "email":
        found = _first_email(fm)
        if found:
            return found, None
        return f"person:{slug(title)}", "no email in the frontmatter: key person:<name> used"
    if drawer.key_kind == "domain":
        found = _first_domain(fm)
        if found:
            return found, None
        return f"org:{slug(title)}", "no domain in the frontmatter: key org:<name> used"
    if drawer.key_kind == "source_id":
        for name in ("fireflies_id", "meeting_id", "source_id", "id"):
            value = _text(fm.get(name))
            if value:
                return f"{drawer.prefix or 'meeting'}:{slug(value)}", None
        when = _text(fm.get("date"))[:10]
        stem = f"{when}-{slug(title)}" if when else slug(title)
        return f"{drawer.prefix or 'meeting'}:{stem}", "no meeting id: key from date and title"
    return f"{drawer.prefix or drawer.id.rstrip('s')}:{slug(title)}", None


HEADER_KEYS = frozenset({
    "title", "aliases", "description", "type", "status", "tags", "related", "sources", "verified",
    "email", "emails", "email_address", "domain", "website", "url", "web",
})


def _fields(drawer: Drawer, fm: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name in drawer.fields:
        value = fm.get(name)
        if value is None or value == "" or value == []:
            continue
        out[name] = _text(value) if not isinstance(value, (int, float, bool)) else value
    return out


def _page(rel: Path, fm: Mapping[str, Any], body: str, drawer: Drawer, topics: list[str]) -> Planned:
    notes: list[str] = []
    title = (_text(fm.get("title")) or rel.stem).strip()[:MAX_TITLE]
    key, note = derive_key(drawer, fm, title)
    if note:
        notes.append(note)
    description = re.sub(r"\s+", " ", _text(fm.get("description")))
    if len(description) > MAX_DESCRIPTION:
        description = description[: MAX_DESCRIPTION - 1].rstrip() + "…"
        notes.append("description shortened to 500 characters")
    status = _text(fm.get("status")).lower()
    page = {
        "key": key[:200],
        "drawer": drawer.id,
        "title": title,
        "aliases": [a for a in _list(fm.get("aliases")) if a != title],
        "description": description or None,
        "status": status if status in STATUSES else "unreviewed",
        "tags": [t.lstrip("#") for t in _list(fm.get("tags"))],
        "related": [_link_target(r) for r in _list(fm.get("related"))],
        "sources": [{"source": "import", "source_id": rel.as_posix()}]
        + [{"source": "import", "source_id": s} for s in _list(fm.get("sources"))],
        "generated": {"by": "kbe pages import", "at": date.today().isoformat()},
        "verified": [v for v in fm.get("verified") or [] if isinstance(v, (str, dict))]
        if isinstance(fm.get("verified"), list) else [],
        "fields": _fields(drawer, fm),
        "topics": list(topics),
        "body": body.lstrip("\n"),
    }
    return Planned(rel.as_posix(), page, tuple(notes))


def markdown_files(folder: Path, skip: Iterable[str] = ()) -> list[Path]:
    skipped = SKIP_DIRS | {s.lower() for s in skip}
    found = []
    for path in sorted(folder.rglob("*.md")):
        rel = path.relative_to(folder)
        if any(part.startswith(".") or part.lower() in skipped for part in rel.parts[:-1]):
            continue
        if len(rel.parts) == 1 and rel.name.lower() in SKIP_FILES:
            continue
        found.append(path)
    return found


def plan(folder: Path, *, topics: Iterable[str] = (), skip: Iterable[str] = (),
         drawers: Mapping[str, Drawer] | None = None) -> Plan:
    """What an import of `folder` would do. Reads files only."""
    if not folder.is_dir():
        raise KbeError(f"{folder} is not a folder.")
    known = dict(drawers or load_drawers())
    chosen_topics = sorted({t.strip().lower() for t in topics if t.strip()})
    result = Plan()
    keys: dict[str, str] = {}
    for path in markdown_files(folder, skip):
        rel = path.relative_to(folder)
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            result.skipped.append((rel.as_posix(), "could not be read as UTF-8 text"))
            continue
        fm, body, problem = split_frontmatter(text)
        if problem:
            result.skipped.append((rel.as_posix(), problem))
            continue
        drawer_id = _drawer_for(fm, rel, known)
        if drawer_id is None:
            what = _text(fm.get("type")) or rel.parts[0]
            result.skipped.append((rel.as_posix(), f'no drawer for type "{what}"'))
            continue
        if len(body) > MAX_BODY:
            result.skipped.append((rel.as_posix(), "longer than 200,000 characters"))
            continue
        planned = _page(rel, fm, body, known[drawer_id], chosen_topics)
        key = planned.page["key"]
        if key in keys:
            result.skipped.append((rel.as_posix(), f"same key {key} as {keys[key]}"))
            continue
        keys[key] = rel.as_posix()
        for name in fm:
            if name not in HEADER_KEYS and name not in known[drawer_id].fields:
                result.dropped_keys[name] = result.dropped_keys.get(name, 0) + 1
        result.pages.append(planned)
    return result
