import { avatarLines, mulUnitUrl } from "./avatar.gallery";
import { ApiError } from "./gallery.client";

/**
 * Moderation page (web/gallery-admin.html, served at /avatar/admin behind
 * Cloudflare Access). Talks to /api/ag/admin/*, which re-checks the Access
 * token on every call. English only: it is for the site owner.
 */

interface AdminEntry {
  id: number;
  q: string;
  /** null when the submitter named no 'Mech. */
  unit: { slug: string; name: string; image: string | null } | null;
  votes: number;
  created: number;
  by: string | null;
  reports: number;
  hidden: boolean;
  reviewed: boolean;
  ownerBanned: boolean;
}

const viewEl = document.getElementById("view") as HTMLElement;
const whoEl = document.getElementById("admin-who") as HTMLElement;

async function admin<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/ag/admin/${path}`, init);
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? "http_error", data.message ?? "");
  return data as T;
}

function button(text: string, onClick: () => Promise<void>, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `link-button ${cls}`.trim();
  b.textContent = text;
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await onClick();
    } catch (e) {
      alert(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

function row(e: AdminEntry, refresh: () => Promise<void>): HTMLElement {
  const c = document.createElement("article");
  c.className = "card";
  const pre = document.createElement("pre");
  pre.className = "art";
  pre.textContent = avatarLines(e.q).join("\n");
  const u = e.unit;
  const unit = document.createElement(u === null ? "span" : "a");
  unit.className = u === null ? "card-unit no-mech" : "card-unit";
  unit.textContent = u === null ? "no 'Mech" : u.name;
  if (u !== null && unit instanceof HTMLAnchorElement) {
    unit.href = mulUnitUrl(u.slug);
    unit.target = "_blank";
    unit.rel = "noopener noreferrer";
  }
  const meta = document.createElement("div");
  meta.className = "card-count";
  const flags = [
    `#${e.id}`,
    e.by === null ? "" : `by ${e.by}`,
    `${e.votes}▲`,
    `${e.reports} reports`,
    e.hidden ? "HIDDEN" : "",
    e.reviewed ? "reviewed" : "",
    e.ownerBanned ? "owner banned" : "",
  ].filter((f) => f !== "");
  meta.textContent = flags.join(" · ");
  const actions = document.createElement("div");
  actions.className = "entry-actions";
  actions.append(
    e.hidden
      ? button("unhide", async () => {
          await admin(`entries/${e.id}/unhide`, "POST");
          await refresh();
        })
      : button("hide", async () => {
          await admin(`entries/${e.id}/hide`, "POST");
          await refresh();
        }),
    button(
      "delete",
      async () => {
        if (!confirm(`Delete entry #${e.id} with its votes and reports? This cannot be undone.`))
          return;
        await admin(`entries/${e.id}`, "DELETE");
        await refresh();
      },
      "danger",
    ),
    button(
      "ban owner",
      async () => {
        if (!confirm("Ban this submitter's key? Their entries are hidden and votes removed."))
          return;
        await admin(`entries/${e.id}/ban-owner`, "POST");
        await refresh();
      },
      "danger",
    ),
  );
  if (u !== null) {
    actions.append(
      button("fix 'Mech", async () => {
        const name = prompt("'Mech name", u.name);
        if (name === null) return;
        const image = prompt(
          "Image URL (https on masterunitlist.battletech.com, empty for none)",
          u.image ?? "",
        );
        if (image === null) return;
        await admin(`units/${encodeURIComponent(u.slug)}`, "PUT", { name, image });
        await refresh();
      }),
    );
  }
  c.append(pre, unit, meta, actions);
  return c;
}

async function render(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const filter = ["reported", "hidden", "all"].includes(params.get("filter") ?? "")
    ? (params.get("filter") as string)
    : "reported";
  document.querySelectorAll<HTMLAnchorElement>("#tabs a").forEach((a) => {
    if (a.dataset.tab === filter) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  viewEl.replaceChildren();
  const grid = document.createElement("div");
  grid.className = "grid";
  viewEl.append(grid);
  let cursor: string | null = null;
  const more = button("load more", async () => load());
  more.classList.add("more");
  const load = async () => {
    const page = await admin<{ entries: AdminEntry[]; next: string | null }>(
      `entries?filter=${filter}${cursor === null ? "" : `&cursor=${cursor}`}`,
    );
    for (const e of page.entries) grid.append(row(e, render));
    cursor = page.next;
    if (grid.childElementCount === 0)
      grid.replaceWith(
        Object.assign(document.createElement("p"), {
          className: "empty",
          textContent: "nothing here",
        }),
      );
    if (cursor === null) more.remove();
    else viewEl.append(more);
  };
  await load();
}

async function main(): Promise<void> {
  try {
    const me = await admin<{ email: string; settings: Record<string, unknown> }>("me");
    whoEl.textContent = `signed in as ${me.email} · settings: ${Object.entries(me.settings)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(", ")}`;
  } catch (e) {
    whoEl.textContent =
      e instanceof ApiError
        ? `not signed in (${e.code}); open this page through Cloudflare Access`
        : "could not reach the admin API";
    return;
  }
  await render();
}

void main();
