import { esc } from "../status/page.js";
import { setupAssetVersion } from "../setup/assets.js";
import { icon, type IconName } from "./icons.js";
import { MARK_ADMIN, MARK_TREE, MARK_TREE_END, MARK_USER } from "./chrome.js";

/**
 * The one page shell for /app and /setup: a sidebar with icon links and a
 * main column. Server-rendered, no script, no inline style; one same-origin
 * stylesheet. The whole body sits inside Cloudflare's email_off markers so
 * its edge never rewrites an address into "[email protected]" (the decode
 * script it would add is blocked by our CSP).
 */

export const PRODUCT_NAME = "Knowledge Base Engine";

export type Area = "setup" | "app";

export type NavItem = {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  readonly group?: string;
};

export const SETUP_NAV: readonly NavItem[] = [
  { href: "/setup", label: "Sign-in", icon: "lock", group: "Setup" },
  { href: "/setup/people", label: "Topics and people", icon: "users", group: "Setup" },
  { href: "/setup/template", label: "Template", icon: "template", group: "Setup" },
  { href: "/setup/model", label: "Model key", icon: "key", group: "Setup" },
  { href: "/setup/timer", label: "Timer", icon: "clock", group: "Setup" },
  { href: "/setup/backup", label: "Backup", icon: "archive", group: "Setup" },
  { href: "/setup/database", label: "Database", icon: "database", group: "Setup" },
  { href: "/setup/health", label: "Health", icon: "heart", group: "Setup" },
  { href: "/setup/indexing", label: "Indexing", icon: "database", group: "Engine" },
];

export const APP_NAV: readonly NavItem[] = [
  { href: "/app", label: "Home", icon: "home" },
  { href: "/app/knowledge", label: "Knowledge", icon: "folder", group: "Knowledge" },
  { href: "/app/pages", label: "Find a page", icon: "search", group: "Knowledge" },
  { href: "/app/reviews", label: "Waiting for your yes", icon: "check", group: "Review" },
  { href: "/app/flagged", label: "Flagged items", icon: "flag", group: "Review" },
];

/** True when `here` is this item or a screen under it ("/app" only matches itself). */
function isHere(item: NavItem, here: string): boolean {
  if (item.href === here) return true;
  if (item.href === "/app" || item.href === "/setup") return false;
  return here.startsWith(`${item.href}/`);
}

export function navHtml(items: readonly NavItem[], here: string): string {
  let group: string | undefined;
  const parts: string[] = [];
  for (const item of items) {
    if (item.group && item.group !== group) parts.push(`<div class="menu-header">${esc(item.group)}</div>`);
    group = item.group;
    const current = isHere(item, here);
    const link = `<a class="nav-item${current ? " active" : ""}" href="${esc(item.href)}"${current ? ' aria-current="page"' : ""}>${icon(item.icon)}<span>${esc(item.label)}</span></a>`;
    // On /app the Knowledge link is replaced by the drawer tree when the route knows it.
    parts.push(item.href === "/app/knowledge" ? `${MARK_TREE}${link}${MARK_TREE_END}` : link);
  }
  return `<nav class="nav-menu" aria-label="Menu">${parts.join("")}</nav>`;
}

/** The setup screens as a card of links: what /setup shows once sign-in is done. */
export function setupMenu(): string {
  const links = SETUP_NAV.filter((i) => i.href !== "/setup")
    .map((i) => `<li><a class="tile" href="${esc(i.href)}">${icon(i.icon)}<span>${esc(i.label)}</span></a></li>`)
    .join("");
  return `<div class="card"><h2>Setup screens</h2><ul class="tiles">${links}</ul><p class="hint"><a href="/app">Open the app</a></p></div>`;
}

export function shell(area: Area, here: string, title: string, body: string, withNav = true, version: string = setupAssetVersion()): string {
  const css = area === "setup" ? "/setup/assets/setup.css" : "/app/assets/setup.css";
  const items = area === "setup" ? SETUP_NAV : APP_NAV;
  const sub = area === "setup" ? "Setup" : "Your knowledge";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex">
<title>${esc(title)} · ${PRODUCT_NAME}</title>
<link rel="stylesheet" href="${css}?v=${encodeURIComponent(version)}">
</head>
<body>
<!--email_off-->
<div class="app-shell">
<aside class="sidebar">
<a class="brand" href="${area === "setup" ? "/setup" : "/app"}"><span class="logo">${icon("book", 22)}</span><span class="brand-text"><span class="eyebrow">${PRODUCT_NAME}</span><strong>${sub}</strong></span></a>
${withNav ? navHtml(items, here) : ""}
${withNav && area === "app" ? MARK_ADMIN : ""}
${MARK_USER}
</aside>
<main class="content">
<header class="top-bar"><h1>${esc(title)}</h1></header>
<div class="page">
${body}
</div>
</main>
</div>
<!--/email_off-->
</body>
</html>
`;
}
