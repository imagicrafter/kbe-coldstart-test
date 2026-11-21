import type { Context } from "hono";
import { logger } from "../log/logger.js";
import { readForm, type Allowed } from "./guard.js";
import { card, esc, hidden, notice, postForm, sendMessage, when } from "./html.js";
import type { Row } from "./store.js";
import type { SettingsDeps } from "./settings-routes.js";

/**
 * "Found in your sources" on Topics and people: the labels, folders and
 * channels the ingest runs have seen in the signed-in person's own sources
 * (0060). A topic is only ever made by switching one of these on; there is no
 * box to type a topic name. Switching on previews first (the topic it makes or
 * reuses, and who already holds it) and needs a yes; switching off does not.
 */

const KIND_LABEL: Readonly<Record<string, string>> = {
  "gmail:label": "Gmail label",
  "drive:folder": "Drive folder",
  "drive:description_tag": "Drive description tag",
  "fireflies:channel": "Fireflies channel",
};

const kindLabel = (t: Row) =>
  KIND_LABEL[`${String(t["source"])}:${String(t["kind"])}`] ?? `${String(t["source"])} ${String(t["kind"])}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function switchForm(t: Row, csrf: string): string {
  const on = t["enabled"] === true;
  return postForm(
    "/setup/people/source-tag",
    csrf,
    `${hidden("tag", String(t["id"]))}${hidden("enabled", on ? "no" : "yes")}`,
    on ? "Turn off" : "Turn into a topic",
  );
}

export function sourceTagsCard(tags: readonly Row[], csrf: string): string {
  const rows = tags
    .map(
      (t) =>
        `<tr><td>${esc(t["name"])}</td><td>${esc(kindLabel(t))}</td><td>${t["enabled"] === true ? `on: ${esc(t["topic"])}` : "off"}</td><td>${esc(t["seen"])} · ${esc(when(t["last_seen_at"]))}</td><td>${switchForm(t, csrf)}</td></tr>`,
    )
    .join("");
  const table = tags.length
    ? `<table><thead><tr><th>Tag</th><th>Where</th><th>Topic</th><th>Items · last seen</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : "<p>No tags yet. They appear here after your first ingest run hands over items with labels, folders or channels.</p>";
  return card(`<h2>Found in your sources</h2>
<p>Topics come only from your sources: a mail label, a Drive folder or a Fireflies channel. Each one starts off, so its items stay yours alone. Turn one into a topic to file its new items under that topic; people who hold the topic then see them. Turning it off stops new items getting the topic; items already filed keep it.</p>
${table}`);
}

export async function setSourceTag(c: Context, me: Allowed, deps: SettingsDeps, page: (body: string, status?: 200 | 400) => Response): Promise<Response> {
  const sent = await readForm(c, deps, "setup", me.email, "people");
  if (!sent.ok) return sent.response;
  const id = sent.form["tag"] ?? "";
  const enabled = sent.form["enabled"] === "yes";
  if (!UUID.test(id) || !["yes", "no"].includes(sent.form["enabled"] ?? "")) {
    return page(notice("error", "Choose a tag from the list."), 400);
  }
  // Off narrows who sees new items: no preview needed. On widens: preview first.
  const confirm = !enabled || sent.form["confirm"] === "yes";
  const result = await deps.store.setSourceTag(me.email, id, enabled, confirm);
  if (confirm) {
    logger.info({ enabled, topic: result["topic"] }, "app: source tag switched");
    return sendMessage(
      c,
      "setup",
      200,
      enabled ? "Topic on" : "Topic off",
      enabled
        ? `New items with this tag are filed under ${String(result["topic"])}. Give the topic to people below.`
        : "New items with this tag are no longer filed under a topic. Items already filed keep it.",
    );
  }
  const who = result["topic_exists"] === true
    ? `The topic ${String(result["topic"])} already exists and ${Number(result["people"] ?? 0)} people hold it: they will see these items.`
    : `A new topic ${String(result["topic"])} is made. Only you hold it until you give it to someone.`;
  const body = card(`<h2>Turn "${esc(result["name"])}" into a topic?</h2><p>${esc(who)}</p>
${postForm("/setup/people/source-tag", deps.csrf.token(me.email, "people"), `${hidden("tag", id)}${hidden("enabled", "yes")}${hidden("confirm", "yes")}`, "Yes, turn it on")}
<p><a href="/setup/people">No, go back</a></p>`);
  return page(body);
}
