import { avatarLines, isUnitSlug, mulUnitUrl } from "./avatar.gallery";
import {
  ApiError,
  api,
  type GalleryEntry,
  type GalleryUnit,
  hasKey,
  KEY_EVENT,
  myPublicId,
  type PublicEntry,
  publicGet,
  type UnitSummary,
  withKey,
  withMarks,
} from "./gallery.client";
import { errorText, gmsg } from "./gallery.i18n";
import { initKeyPanel } from "./gallery.key";
import { type AfterSubmit, initSubmit, type SubmitNotice } from "./gallery.submit";

/**
 * The gallery page (web/gallery.html, docs/GALLERY.md §7). One page, five
 * views picked by the query string:
 *
 *   gallery.html?sort=top|new   all entries
 *   gallery.html?view=mechs     'Mechs that have entries, with their top avatar
 *   gallery.html?unit=<slug>    one 'Mech: its MUL art and link, its entries
 *   gallery.html?unit=none      entries tied to no 'Mech
 *   gallery.html?id=<n>         one entry, plus the others for the same 'Mech
 *   gallery.html?mine=1         this browser's own submissions
 *
 * `?submit&head=…` (the creator's "submit to gallery" link) also opens the
 * Submit panel over whichever view is behind it (gallery.submit.ts); a
 * successful submission swaps in the view that shows the avatar, under a
 * notice. A `#key=…` link opens the key panel (gallery.key.ts).
 */

/** `unit` value for the entries tied to no 'Mech (functions/api/ag/_lib/gallery.ts). */
const NO_UNIT = "none";

const app = document.getElementById("gallery-app") as HTMLElement;
const viewEl = document.getElementById("view") as HTMLElement;
const noticeEl = document.getElementById("notice") as HTMLElement;
const live = document.getElementById("sr-live") as HTMLElement;
const turnstileHost = document.getElementById("ag-turnstile") as HTMLElement;
const whoami = document.getElementById("whoami") as HTMLElement;

type View =
  | { kind: "list"; sort: "top" | "new" }
  | { kind: "mechs"; q: string }
  | { kind: "unit"; slug: string }
  | { kind: "nomech" }
  | { kind: "mine" }
  | { kind: "entry"; id: number };

function currentView(): View {
  const p = new URLSearchParams(location.search);
  const id = p.get("id");
  if (id !== null && /^[1-9]\d{0,15}$/.test(id)) return { kind: "entry", id: Number(id) };
  if (p.get("mine") === "1") return { kind: "mine" };
  const unit = p.get("unit");
  if (unit === NO_UNIT) return { kind: "nomech" };
  if (unit !== null && isUnitSlug(unit)) return { kind: "unit", slug: unit };
  if (p.get("view") === "mechs") return { kind: "mechs", q: p.get("q") ?? "" };
  return { kind: "list", sort: p.get("sort") === "new" ? "new" : "top" };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== "") e.className = cls;
  if (text !== "") e.textContent = text;
  return e;
}

function say(text: string): void {
  live.textContent = text;
}

function link(href: string, text: string, cls = ""): HTMLAnchorElement {
  const a = el("a", cls, text);
  a.href = href;
  return a;
}

function entryHref(id: number): string {
  return `gallery.html?id=${id}`;
}

function unitHref(slug: string): string {
  return `gallery.html?unit=${encodeURIComponent(slug)}`;
}

/** Link to the entry's 'Mech, or to the "no 'Mech" group. */
function unitLink(unit: GalleryUnit | null, cls: string): HTMLAnchorElement {
  return unit === null
    ? link(unitHref(NO_UNIT), gmsg().noMech, `${cls} no-mech`)
    : link(unitHref(unit.slug), unit.name, cls);
}

function creatorHref(q: string): string {
  return `avatar.html?${q}`;
}

function art(q: string, selected = false): HTMLPreElement {
  const pre = el("pre", "art", avatarLines(q, selected).join("\n"));
  pre.setAttribute("aria-hidden", "true");
  return pre;
}

/** MUL unit art, hotlinked with no referrer; a plain placeholder when missing or broken. */
function unitImage(unit: GalleryUnit): HTMLElement {
  const box = el("div", "unit-art");
  const placeholder = () => box.replaceChildren(el("span", "no-image", gmsg().noImage));
  if (unit.image === null) {
    placeholder();
    return box;
  }
  const img = el("img");
  img.src = unit.image;
  img.alt = gmsg().imageAlt(unit.name);
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", placeholder, { once: true });
  box.append(img);
  return box;
}

function showError(e: unknown, where: HTMLElement = viewEl): void {
  const code = e instanceof ApiError ? e.code : "network";
  const p = el("p", "error", errorText(code));
  where.append(p);
  say(p.textContent ?? "");
}

/** Vote toggle; updates the button and count in place. */
function voteButton(entry: GalleryEntry): HTMLButtonElement {
  const b = el("button", "link-button vote");
  b.type = "button";
  const paint = () => {
    const m = gmsg();
    b.textContent = `${entry.voted ? `♥ ${m.voted}` : `♡ ${m.vote}`} · ${entry.votes}`;
    b.setAttribute("aria-pressed", String(entry.voted));
    const name = entry.unit?.name;
    const label =
      name === undefined
        ? entry.voted
          ? m.unvoteLabelNoMech
          : m.voteLabelNoMech
        : entry.voted
          ? m.unvoteLabel(name)
          : m.voteLabel(name);
    b.setAttribute("aria-label", `${label}, ${m.votes(entry.votes)}`);
  };
  paint();
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      const r = await withKey(turnstileHost, () =>
        api<{ voted: boolean; votes: number }>(`/avatars/${entry.id}/vote`, { method: "POST" }),
      );
      entry.voted = r.voted;
      entry.votes = r.votes;
      paint();
      say(`${r.voted ? gmsg().voted : gmsg().vote}, ${gmsg().votes(r.votes)}`);
    } catch (e) {
      showError(e, b.parentElement ?? viewEl);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

/** Report and (for the submitter) delete. */
function entryActions(entry: GalleryEntry, onRemoved: () => void): HTMLElement {
  const m = gmsg();
  const row = el("div", "entry-actions");
  row.append(voteButton(entry), link(creatorHref(entry.q), m.openInCreator, "link-button"));
  const report = el("button", "link-button quiet", m.report);
  report.type = "button";
  report.addEventListener("click", async () => {
    if (!confirm(gmsg().reportConfirm)) return;
    report.disabled = true;
    try {
      await withKey(turnstileHost, () => api(`/avatars/${entry.id}/report`, { method: "POST" }));
      report.textContent = gmsg().reported;
      say(gmsg().reported);
    } catch (e) {
      report.disabled = false;
      showError(e, row);
    }
  });
  row.append(report);
  if (entry.mine) {
    const del = el("button", "link-button quiet danger", m.remove);
    del.type = "button";
    del.addEventListener("click", async () => {
      if (!confirm(gmsg().removeConfirm)) return;
      del.disabled = true;
      try {
        await api(`/avatars/${entry.id}`, { method: "DELETE" });
        say(gmsg().removed);
        onRemoved();
      } catch (e) {
        del.disabled = false;
        showError(e, row);
      }
    });
    row.append(del);
  }
  return row;
}

/** "by 7Hq3xKpa", or "by you" on this browser's own entries. */
function byLine(entry: GalleryEntry, cls: string): HTMLElement {
  const m = gmsg();
  if (entry.mine) return el("span", `${cls} mine`, m.byYou);
  return el("span", cls, entry.by === null ? "" : m.by(entry.by));
}

/** A grid card: the avatar linking to its entry page, the 'Mech, the submitter, the like button. */
function card(entry: GalleryEntry, showUnit = true): HTMLElement {
  const c = el("article", "card");
  const a = link(entryHref(entry.id), "");
  a.className = "card-art";
  a.append(art(entry.q));
  a.setAttribute("aria-label", entry.unit?.name ?? gmsg().noMechLabel);
  c.append(a);
  if (showUnit) c.append(unitLink(entry.unit, "card-unit"));
  c.append(byLine(entry, "card-by"));
  const foot = el("div", "card-foot");
  foot.append(voteButton(entry));
  c.append(foot);
  return c;
}

/** Paged entry grid; `query` is the /avatars query string without cursor. */
async function entryGrid(
  host: HTMLElement,
  query: string,
  opts: { showUnit?: boolean; skip?: number; highlight?: number | null } = {},
): Promise<void> {
  const grid = el("div", "grid");
  const more = el("button", "link-button more", gmsg().loadMore);
  more.type = "button";
  host.append(grid);
  let cursor: string | null = null;
  const load = async () => {
    more.disabled = true;
    more.textContent = gmsg().loading;
    try {
      const path = `/avatars?${query}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      // `mine=1` is this key's own list, so it goes with the key and is never
      // cached; every other list is the shared, cached read.
      const page = query.includes("mine=1")
        ? await api<{ entries: PublicEntry[]; next: string | null }>(path)
        : await publicGet<{ entries: PublicEntry[]; next: string | null }>(path);
      // Then this browser's likes and own entries for just this page.
      const entries = await withMarks(page.entries);
      for (const e of entries) {
        if (e.id === opts.skip) continue;
        const c = card(e, opts.showUnit ?? true);
        if (e.id === opts.highlight) {
          c.classList.add("just-added");
          c.tabIndex = -1;
        }
        grid.append(c);
      }
      cursor = page.next;
      if (grid.childElementCount === 0) grid.replaceWith(el("p", "empty", gmsg().empty));
      if (cursor === null) more.remove();
      else host.append(more);
    } catch (e) {
      showError(e, host);
    } finally {
      more.disabled = false;
      more.textContent = gmsg().loadMore;
    }
  };
  more.addEventListener("click", () => void load());
  await load();
}

function unitHeader(unit: GalleryUnit, title: string): HTMLElement {
  const head = el("header", "unit-head");
  const text = el("div", "unit-text");
  text.append(el("h2", "", title));
  const mul = link(mulUnitUrl(unit.slug), gmsg().viewOnMul, "link-button");
  mul.target = "_blank";
  mul.rel = "noopener noreferrer";
  text.append(mul);
  head.append(unitImage(unit), text);
  return head;
}

async function renderList(
  host: HTMLElement,
  sort: "top" | "new",
  highlight: number | null,
): Promise<void> {
  await entryGrid(host, `sort=${sort}`, { highlight });
}

async function renderMechs(host: HTMLElement, q: string): Promise<void> {
  const m = gmsg();
  const form = el("form", "mech-search");
  const input = el("input");
  input.type = "search";
  input.name = "q";
  input.value = q;
  input.placeholder = "Atlas, AS7-D…";
  input.setAttribute("aria-label", "search");
  const hidden = el("input");
  hidden.type = "hidden";
  hidden.name = "view";
  hidden.value = "mechs";
  form.action = "gallery.html";
  form.append(hidden, input);
  host.append(form);
  try {
    const { units, unlinked } = await publicGet<{
      units: UnitSummary[];
      unlinked: { count: number; top: string | null };
    }>(`/units?q=${encodeURIComponent(q.trim())}`);
    // The "no 'Mech" group closes the unfiltered list.
    const showUnlinked = q.trim() === "" && unlinked.count > 0 && unlinked.top !== null;
    if (units.length === 0 && !showUnlinked) {
      host.append(el("p", "empty", m.empty));
      return;
    }
    const grid = el("div", "grid");
    for (const u of units) {
      const c = el("article", "card");
      const a = link(unitHref(u.slug), "");
      a.className = "card-art";
      a.append(art(u.top));
      a.setAttribute("aria-label", u.name);
      c.append(
        a,
        link(unitHref(u.slug), u.name, "card-unit"),
        el("div", "card-count", m.entriesCount(u.count)),
      );
      grid.append(c);
    }
    if (showUnlinked && unlinked.top !== null) {
      const c = el("article", "card");
      const a = link(unitHref(NO_UNIT), "");
      a.className = "card-art";
      a.append(art(unlinked.top));
      a.setAttribute("aria-label", m.noMechTitle);
      c.append(
        a,
        unitLink(null, "card-unit"),
        el("div", "card-count", m.entriesCount(unlinked.count)),
      );
      grid.append(c);
    }
    host.append(grid);
  } catch (e) {
    showError(e, host);
  }
}

async function renderUnit(host: HTMLElement, slug: string): Promise<void> {
  // The unit's name and art come with its entries; take them from the first one.
  try {
    // Same URL as the grid's first page below, so that request is answered
    // by the browser's copy (a 304 at most).
    const first = await publicGet<{ entries: PublicEntry[] }>(
      `/avatars?sort=top&unit=${encodeURIComponent(slug)}`,
    );
    const unit = first.entries[0]?.unit;
    if (unit === undefined || unit === null) {
      host.append(el("p", "empty", gmsg().empty));
      return;
    }
    document.title = `${unit.name} · ${gmsg().title}`;
    host.append(unitHeader(unit, gmsg().allForMech(unit.name)));
    await entryGrid(host, `sort=top&unit=${encodeURIComponent(slug)}`, { showUnit: false });
  } catch (e) {
    showError(e, host);
  }
}

async function renderNoMech(host: HTMLElement): Promise<void> {
  const m = gmsg();
  document.title = `${m.noMech} · ${m.title}`;
  const head = el("header", "unit-head");
  head.append(el("h2", "", m.noMechTitle));
  host.append(head);
  await entryGrid(host, `sort=top&unit=${NO_UNIT}`, { showUnit: false });
}

async function renderMine(host: HTMLElement): Promise<void> {
  const m = gmsg();
  document.title = `${m.myAvatars} · ${m.title}`;
  const head = el("header", "unit-head");
  head.append(el("h2", "", m.mineTitle));
  host.append(head);
  if (!hasKey()) {
    host.append(el("p", "empty", m.mineNoKey));
    return;
  }
  await entryGrid(host, "sort=new&mine=1", { showUnit: true });
}

async function renderEntry(host: HTMLElement, id: number): Promise<void> {
  let entry: GalleryEntry;
  try {
    const pub = (await publicGet<{ entry: PublicEntry }>(`/avatars/${id}`)).entry;
    [entry] = (await withMarks([pub])) as [GalleryEntry];
  } catch (e) {
    if (e instanceof ApiError && (e.code === "not_found" || e.code === "under_review")) {
      // A hidden entry (awaiting approval, reported, banned) is "under review".
      host.append(el("p", "empty", e.code === "not_found" ? gmsg().notFound : errorText(e.code)));
    } else showError(e, host);
    return;
  }
  const m = gmsg();
  const unit = entry.unit;
  document.title = `${unit?.name ?? m.noMech} · ${m.title}`;
  const detail = el("section", "entry");
  const big = el("div", "entry-art");
  big.append(art(entry.q, true));
  const side = el("div", "entry-side");
  side.append(unitLink(unit, "entry-unit"), byLine(entry, "card-by"));
  if (unit !== null) {
    const mul = link(mulUnitUrl(unit.slug), m.viewOnMul, "link-button");
    mul.target = "_blank";
    mul.rel = "noopener noreferrer";
    side.append(unitImage(unit), mul);
  }
  detail.append(big, side);
  const group = unit === null ? NO_UNIT : unit.slug;
  host.append(
    detail,
    entryActions(entry, () => {
      location.href = unitHref(group);
    }),
  );
  const others = el("section", "others");
  others.append(el("h2", "", unit === null ? m.otherNoMech : m.otherForMech(unit.name)));
  host.append(others);
  await entryGrid(others, `sort=top&unit=${encodeURIComponent(group)}`, {
    showUnit: false,
    skip: entry.id,
  });
}

function markTab(view: View): void {
  const active =
    view.kind === "list"
      ? view.sort
      : view.kind === "mechs" || view.kind === "nomech"
        ? view.kind
        : "";
  document.querySelectorAll<HTMLAnchorElement>("#tabs a").forEach((a) => {
    if (a.dataset.tab === active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

/** Set by a successful submission; kept for redraws until the page changes. */
let notice: SubmitNotice | null = null;
let highlight: number | null = null;

async function render(): Promise<void> {
  const view = currentView();
  document.title = gmsg().title;
  markTab(view);
  noticeEl.textContent = notice === null ? "" : gmsg()[notice];
  // A fresh box per render: an earlier render that finishes late fills its
  // own detached box instead of mixing into this one.
  const host = el("div", "view-body");
  viewEl.replaceChildren(host);
  if (view.kind === "entry") await renderEntry(host, view.id);
  else if (view.kind === "unit") await renderUnit(host, view.slug);
  else if (view.kind === "nomech") await renderNoMech(host);
  else if (view.kind === "mine") await renderMine(host);
  else if (view.kind === "mechs") await renderMechs(host, view.q);
  else await renderList(host, view.sort, highlight);
}

/** The Submit panel closed on a success: show the avatar's view under a notice. */
async function showSubmitted(next: AfterSubmit): Promise<void> {
  const params = new URLSearchParams(next.view);
  const lang = new URLSearchParams(location.search).get("lang");
  if (lang !== null) params.set("lang", lang);
  const href = `${location.pathname}?${params}${location.hash}`;
  try {
    history.replaceState(history.state, "", href);
  } catch {
    // Some embedded contexts refuse replaceState; load the view instead.
    location.href = href;
    return;
  }
  notice = next.notice;
  highlight = next.highlight;
  app.scrollTop = 0;
  await render();
  say(gmsg()[next.notice]);
  viewEl.querySelector<HTMLElement>(".just-added")?.focus({ preventScroll: true });
}

/** "you: 7Hq3xKpa · my avatars", or "you: guest" before this browser has a key. */
function keyButton(text: string): HTMLButtonElement {
  const b = el("button", "link-button", text);
  b.type = "button";
  b.addEventListener("click", () => openKeyPanel());
  return b;
}

async function renderIdentity(): Promise<void> {
  const m = gmsg();
  const id = await myPublicId();
  if (id === null) {
    whoami.replaceChildren(`${m.you}: `, el("span", "", m.guest), " · ", keyButton(m.useKey));
    (whoami.firstElementChild as HTMLElement).title = m.guestHint;
    return;
  }
  whoami.replaceChildren(
    `${m.you}: `,
    el("span", "pid", id),
    " · ",
    link("gallery.html?mine=1", m.myAvatars),
    " · ",
    keyButton(m.moveKey),
  );
}

const openKeyPanel = initKeyPanel(() => void render());
void render();
void renderIdentity();
initSubmit((next) => void showSubmitted(next));
window.addEventListener(KEY_EVENT, () => void renderIdentity());

// The language buttons only set `<html lang>`; redraw the script-built text.
new MutationObserver(() => {
  void render();
  void renderIdentity();
}).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["lang"],
});
