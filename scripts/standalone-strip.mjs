// The standalone terminal (dist/standalone/bt10x.html) has no landing page
// beside it, so the header's home link must not ship there. The link sits
// between <!-- home-link --> markers in web/terminal.html; losing either the
// markers or the strip fails the build instead of shipping a dead link.
export function stripHomeLink(html) {
  const out = html.replace(/[ \t]*<!-- home-link\b[^>]*-->[\s\S]*?<!-- \/home-link -->\n?/, "");
  if (out === html)
    throw new Error("standalone: <!-- home-link --> markers not found in terminal.html");
  if (out.includes("home-link")) throw new Error("standalone: home link survived the strip");
  return out;
}
