/**
 * Relaxed JSON: standard JSON except object keys that are plain identifiers
 * (`[A-Za-z_$][A-Za-z0-9_$]*`) are written without quotes, e.g.
 * `{a:1,b:"asdf"}`. Other keys stay quoted, so any JSON value round-trips.
 * The decoder accepts quoted and unquoted keys (so plain JSON also parses).
 */

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Encode a JSON-compatible value as minified relaxed JSON. */
export function encodeRelaxed(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(encodeRelaxed).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      parts.push(`${IDENT_RE.test(k) ? k : JSON.stringify(k)}:${encodeRelaxed(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  const s = JSON.stringify(value);
  if (s === undefined) throw new Error("encodeRelaxed: unsupported value");
  return s;
}

/** Decode relaxed (or plain) JSON text. Throws on malformed input. */
export function decodeRelaxed(text: string): unknown {
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`Invalid relaxed JSON: ${msg} at ${i}`);
  };
  const ws = (): void => {
    while (i < text.length && " \t\n\r".includes(text[i] as string)) i++;
  };
  const expect = (ch: string): void => {
    ws();
    if (text[i] !== ch) fail(`expected '${ch}'`);
    i++;
  };
  // Strings and primitives: find the token end, then let JSON.parse validate it.
  const string = (): string => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (i >= text.length) fail("unterminated string");
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): unknown => {
    ws();
    const ch = text[i];
    if (ch === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        let key: string;
        if (text[i] === '"') key = string();
        else {
          const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i));
          if (m === null) return fail("expected key");
          key = m[0];
          i += key.length;
        }
        expect(":");
        obj[key] = value();
        ws();
        if (text[i] === ",") i++;
        else {
          expect("}");
          return obj;
        }
      }
    }
    if (ch === "[") {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i] === ",") i++;
        else {
          expect("]");
          return arr;
        }
      }
    }
    if (ch === '"') return string();
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (m === null) return fail("unexpected token");
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  const result = value();
  ws();
  if (i < text.length) fail("trailing characters");
  return result;
}
