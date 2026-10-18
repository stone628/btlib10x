import { keyPublicId } from "./avatar.gallery";
import {
  ApiError,
  checkKey,
  DEVICE_KEY_RE,
  deviceKey,
  KEY_EVENT,
  storeKey,
} from "./gallery.client";
import { errorText, gmsg } from "./gallery.i18n";

/**
 * The gallery's key panel (docs/GALLERY.md §4): move the device key to
 * another browser. The old browser shows its key (copy it, or copy a
 * `gallery.html#key=…` link); the new one pastes either, the server confirms
 * it knows the key (`GET /api/ag/keys`), and the page stores it. The key
 * travels in the fragment, which browsers never send to a server, and the
 * page drops it from the URL as soon as it reads it.
 */

const LINK_PARAM = "key";

/** The key in a pasted key or `…#key=…` link, or null. */
export function keyFromText(text: string): string | null {
  const t = text.trim();
  if (DEVICE_KEY_RE.test(t)) return t;
  const hash = t.indexOf("#");
  if (hash < 0) return null;
  const key = new URLSearchParams(t.slice(hash + 1)).get(LINK_PARAM);
  return key !== null && DEVICE_KEY_RE.test(key) ? key : null;
}

function keyLink(key: string): string {
  return `${location.origin}${location.pathname}#${LINK_PARAM}=${key}`;
}

/** Read and remove a `#key=…` fragment, so the key stays out of history. */
function takeLinkKey(): string | null {
  if (location.hash === "") return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const key = params.get(LINK_PARAM);
  if (key === null) return null;
  try {
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  } catch {
    // Some embedded contexts refuse replaceState; the fragment just stays.
  }
  return key;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wire the panel. Returns `open()`, for the "move key" link by your ID;
 * `onChange` runs after a moved key is stored, so views can redraw their
 * liked and mine marks.
 */
export function initKeyPanel(onChange: () => void): () => void {
  const panel = document.getElementById("key-panel") as HTMLDialogElement | null;
  if (panel === null) return () => {};
  const out = document.getElementById("key-out") as HTMLElement;
  const none = document.getElementById("key-none") as HTMLElement;
  const value = document.getElementById("key-value") as HTMLInputElement;
  const input = document.getElementById("key-input") as HTMLInputElement;
  const replace = document.getElementById("key-replace") as HTMLElement;
  const use = document.getElementById("key-use") as HTMLButtonElement;
  const status = document.getElementById("key-status") as HTMLElement;

  const setStatus = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle("error", error);
  };

  const sync = async () => {
    const key = deviceKey();
    out.hidden = key === null;
    none.hidden = key !== null;
    value.value = key ?? "";
    input.placeholder = gmsg().keyPlaceholder;
    replace.textContent = key === null ? "" : gmsg().keyReplace(await keyPublicId(key));
  };
  window.addEventListener(KEY_EVENT, () => void sync());

  const copy = async (text: string, done: string) => {
    if (await copyText(text)) return setStatus(done);
    value.focus();
    value.select();
    setStatus(gmsg().copyFailed, true);
  };
  document.getElementById("key-copy")?.addEventListener("click", () => {
    const key = deviceKey();
    if (key !== null) void copy(key, gmsg().keyCopied);
  });
  document.getElementById("key-copy-link")?.addEventListener("click", () => {
    const key = deviceKey();
    if (key !== null) void copy(keyLink(key), gmsg().linkCopied);
  });
  value.addEventListener("focus", () => value.select());

  const useKey = async () => {
    if (use.disabled) return;
    const key = keyFromText(input.value);
    if (key === null) {
      input.focus();
      return setStatus(gmsg().keyBadFormat, true);
    }
    if (key === deviceKey()) return setStatus(gmsg().keySame);
    use.disabled = true;
    setStatus(gmsg().keyChecking);
    try {
      const pid = await checkKey(key);
      storeKey(key);
      input.value = "";
      setStatus(gmsg().keyUsed(pid));
      onChange();
    } catch (e) {
      setStatus(errorText(e instanceof ApiError ? e.code : "network"), true);
    } finally {
      use.disabled = false;
    }
  };
  use.addEventListener("click", () => void useKey());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void useKey();
    }
  });
  document.getElementById("key-close")?.addEventListener("click", () => panel.close());
  panel.addEventListener("close", () => setStatus(""));

  const open = () => {
    void sync();
    if (!panel.open) panel.showModal();
  };

  // A copied link: open the panel with the key filled in, for the player to confirm.
  const linked = takeLinkKey();
  if (linked !== null) {
    open();
    input.value = linked;
    use.focus();
  }
  return open;
}
