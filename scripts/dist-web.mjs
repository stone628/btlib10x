import { copyFileSync, mkdirSync, rmSync } from "node:fs";

const dest = "dist/web";
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
copyFileSync("web/index.html", `${dest}/index.html`);
copyFileSync("web/bt10x.css", `${dest}/bt10x.css`);
copyFileSync("web/btlib10x.js", `${dest}/btlib10x.js`);
copyFileSync("web/btlib10x.jsonl", `${dest}/btlib10x.jsonl`);
copyFileSync("web/app.js", `${dest}/app.js`);
copyFileSync("web/favicon.ico", `${dest}/favicon.ico`);
console.log(
  `dist/web: ${["index.html", "bt10x.css", "btlib10x.js", "btlib10x.jsonl", "app.js", "favicon.ico"].join(", ")}`,
);
