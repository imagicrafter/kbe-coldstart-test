import type { Context } from "hono";
import { esc } from "../status/page.js";
import { setupAssetVersion } from "../setup/assets.js";
import { SETUP_CSP } from "../setup/page.js";

/**
 * Plain server-rendered pages for the app screens, in the setup page's style:
 * one same-origin stylesheet, no script, no inline style. Every value from a
 * person, the database or a source goes through esc(). No secret is ever
 * written into a page.
 */

export { esc };

export type Area = "setup" | "app";

export type NavItem = { readonly href: string; readonly label: string };

export const SETUP_NAV: readonly NavItem[] = [
  { href: "/setup", label: "Sign-in" },
  { href: "/setup/people", label: "Topics and people" },
  { href: "/setup/template", label: "Template" },
  { href: "/setup/model", label: "Model key" },
  { href: "/setup/timer", label: "Timer" },
  { href: "/setup/backup", label: "Backup" },
  { href: "/setup/health", label: "Health" },
];

export const APP_NAV: readonly NavItem[] = [
  { href: "/app", label: "Home" },
  { href: "/app/reviews", label: "Waiting for your yes" },
  { href: "/app/flagged", label: "Flagged items" },
  { href: "/app/pages", label: "Pages" },
];

function nav(items: readonly NavItem[], here: string): string {
  const links = items
    .map((i) => (i.href === here ? `<strong>${esc(i.label)}</strong>` : `<a href="${esc(i.href)}">${esc(i.label)}</a>`))
    .join(" · ");
  return `<p class="hint">${links}</p>`;
}

export function appLayout(area: Area, here: string, title: string, body: string): string {
  const css = area === "setup" ? "/setup/assets/setup.css" : "/app/assets/setup.css";
  const eyebrow = area === "setup" ? "AI Engine setup" : "AI Engine";
  const items = area === "setup" ? SETUP_NAV : APP_NAV;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${css}?v=${encodeURIComponent(setupAssetVersion())}">
</head>
<body>
<main>
<p class="eyebrow">${esc(eyebrow)}</p>
${nav(items, here)}
<h1>${esc(title)}</h1>
${body}
</main>
</body>
</html>
`;
}

export function card(inner: string, extra = ""): string {
  return `<div class="card${extra ? ` ${extra}` : ""}">${inner}</div>`;
}

export function notice(kind: "ok" | "error", text: string): string {
  return kind === "error"
    ? `<div class="card errors" role="alert"><p>${esc(text)}</p></div>`
    : `<div class="card"><p><strong>${esc(text)}</strong></p></div>`;
}

export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

export function postForm(action: string, csrf: string, inner: string, button: string): string {
  return `<form method="post" action="${esc(action)}">${hidden("csrf", csrf)}${inner}<p><button type="submit">${esc(button)}</button></p></form>`;
}

export type PageStatus = 200 | 201 | 400 | 401 | 403 | 404 | 409 | 415 | 422 | 429 | 502 | 503;

export function sendPage(c: Context, status: PageStatus, html: string): Response {
  c.header("Content-Security-Policy", SETUP_CSP);
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  c.header("Referrer-Policy", "same-origin");
  return c.html(html, status);
}

export function sendMessage(c: Context, area: Area, status: PageStatus, title: string, text: string): Response {
  return sendPage(c, status, appLayout(area, "", title, notice(status >= 400 ? "error" : "ok", text)));
}

export function when(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
