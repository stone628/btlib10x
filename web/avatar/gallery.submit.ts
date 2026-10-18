import { avatarLines, canonicalAvatar, parseMulUrl } from "./avatar.gallery";
import { ApiError, api, KEY_EVENT, myPublicId, turnstileToken, withKey } from "./gallery.client";
import { errorText, gmsg } from "./gallery.i18n";

/**
 * The gallery's Submit panel (docs/GALLERY.md §7). The creator's "submit to
 * gallery" link opens `gallery.html?submit&head=…`: the avatar travels in the
 * same params as the creator's own URL, so the creator stays a static page.
 * The 'Mech (its MUL page URL) is optional; empty submits the avatar alone.
 */

/** What the server answered a submission with (functions/api/ag/avatars/index.ts). */
export interface SubmitResult {
  id: number | null;
  existing: boolean;
  pending?: boolean;
}

/** The gallery.i18n.ts string shown above the gallery after a submission. */
export type SubmitNotice = "submitted" | "submittedPending" | "alreadyThere" | "alreadyThereNoMech";

/** Where the gallery goes once a submission went through. */
export interface AfterSubmit {
  /** Gallery query string of the view to show. */
  view: string;
  notice: SubmitNotice;
  /** Entry to mark in that view's grid. */
  highlight: number | null;
}

/**
 * Any successful submission closes the panel, so it never reads as "submit
 * again". A new, published avatar is the first card under "new"; a duplicate
 * or one awaiting approval opens its own page, which says "under review"
 * while it is hidden.
 */
export function afterSubmit(res: SubmitResult, mul: string): AfterSubmit {
  const page = res.id === null ? "sort=new" : `id=${res.id}`;
  if (res.existing) {
    return {
      view: page,
      notice: mul === "" ? "alreadyThereNoMech" : "alreadyThere",
      highlight: null,
    };
  }
  if (res.pending === true) return { view: page, notice: "submittedPending", highlight: null };
  return { view: "sort=new", notice: "submitted", highlight: res.id };
}

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

export function initSubmit(onSubmitted: (next: AfterSubmit) => void): void {
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

  const setStatus = (text: string, error = false) => {
    status.replaceChildren(text);
    status.classList.toggle("error", error);
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
    setStatus(gmsg().verifying);
    let res: SubmitResult;
    try {
      res = await withKey(host, async () =>
        api<SubmitResult>("/avatars", {
          method: "POST",
          body: { q, mul, turnstile: await turnstileToken(host) },
        }),
      );
    } catch (e) {
      setStatus(errorText(e instanceof ApiError ? e.code : "network"), true);
      send.disabled = false;
      return;
    }
    // Closing drops the panel's params; the gallery then shows the avatar.
    panel.close();
    onSubmitted(afterSubmit(res, mul));
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
