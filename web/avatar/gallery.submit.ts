import { avatarLines, canonicalAvatar, parseMulUrl } from "./avatar.gallery";
import {
  ApiError,
  api,
  type GalleryEntry,
  KEY_EVENT,
  myPublicId,
  turnstileToken,
  withKey,
} from "./gallery.client";
import { errorText, gmsg } from "./gallery.i18n";

/**
 * The gallery's Submit panel (docs/GALLERY.md §7). The creator's "submit to
 * gallery" link opens `gallery.html?submit&head=…`: the avatar travels in the
 * same params as the creator's own URL, so the creator stays a static page.
 * The 'Mech (its MUL page URL) is optional; empty submits the avatar alone.
 */

/** Params that are not part of the avatar. */
const PANEL_PARAMS = ["submit", "lang"];

/** The avatar query carried by a `?submit` URL, as the creator wrote it. */
function avatarQuery(params: URLSearchParams): string {
  const q = new URLSearchParams(params);
  for (const k of PANEL_PARAMS) q.delete(k);
  return q.toString();
}

/** Drop the panel's params so a reload or a later view shows the plain gallery. */
function clearPanelParams(): void {
  const params = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  const lang = params.get("lang");
  if (lang !== null) keep.set("lang", lang);
  const search = keep.toString();
  try {
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${search === "" ? "" : `?${search}`}${location.hash}`,
    );
  } catch {
    // Some embedded contexts refuse replaceState; the URL just stays put.
  }
}

export function initSubmit(): void {
  const params = new URLSearchParams(location.search);
  if (!params.has("submit")) return;
  const panel = document.getElementById("submit-panel") as HTMLDialogElement | null;
  if (panel === null) return;
  const preview = document.getElementById("submit-preview") as HTMLPreElement;
  const form = document.getElementById("submit-form") as HTMLElement;
  const input = document.getElementById("submit-mul") as HTMLInputElement;
  const host = document.getElementById("submit-turnstile") as HTMLElement;
  const status = document.getElementById("submit-status") as HTMLElement;
  const send = document.getElementById("submit-send") as HTMLButtonElement;
  const edit = document.getElementById("submit-edit") as HTMLAnchorElement;
  const who = document.getElementById("submit-who") as HTMLElement;

  const showWho = async () => {
    const id = await myPublicId();
    who.textContent = id === null ? gmsg().submittingAsNew : gmsg().submittingAs(id);
  };
  void showWho();
  window.addEventListener(KEY_EVENT, () => void showWho());

  const raw = avatarQuery(params);
  const q = canonicalAvatar(raw);
  const back = new URLSearchParams(raw);
  const lang = params.get("lang");
  if (lang !== null) back.set("lang", lang);
  const backSearch = back.toString();
  edit.href = `avatar.html${backSearch === "" ? "" : `?${backSearch}`}`;

  const setStatus = (text: string, error = false, href: string | null = null) => {
    status.replaceChildren(text);
    status.classList.toggle("error", error);
    if (href !== null) {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = gmsg().viewEntry;
      status.append(" · ", a);
    }
  };

  // A bad or missing avatar leaves only "edit in creator" and close.
  form.hidden = q === null;
  send.hidden = q === null;
  if (q === null) setStatus(errorText("bad_avatar"), true);
  else preview.textContent = avatarLines(q, true).join("\n");

  panel.addEventListener("close", () => {
    host.replaceChildren();
    clearPanelParams();
  });
  document.getElementById("submit-close")?.addEventListener("click", () => panel.close());

  const submit = async () => {
    if (q === null || send.disabled) return;
    const mul = input.value.trim();
    if (mul !== "" && parseMulUrl(mul) === null) {
      input.focus();
      return setStatus(errorText("bad_mul_url"), true);
    }
    send.disabled = true;
    let done = false;
    setStatus(gmsg().verifying);
    try {
      const res = await withKey(host, async () =>
        api<{ id: number; existing: boolean; pending?: boolean; entry?: GalleryEntry }>(
          "/avatars",
          { method: "POST", body: { q, mul, turnstile: await turnstileToken(host) } },
        ),
      );
      const m = gmsg();
      const text = res.existing
        ? mul === ""
          ? m.alreadyThereNoMech
          : m.alreadyThere
        : res.pending
          ? m.submittedPending
          : m.submitted;
      setStatus(text, false, res.pending ? null : `gallery.html?id=${res.id}`);
      done = true;
    } catch (e) {
      setStatus(errorText(e instanceof ApiError ? e.code : "network"), true);
    } finally {
      // After a submission the avatar is in; only close stays useful.
      send.disabled = done;
    }
  };
  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  });

  panel.showModal();
  if (q !== null) input.focus();
}
