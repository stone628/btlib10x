import { cpSync, mkdirSync, rmSync } from "node:fs";

const dest = "dist/web";
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync("web/index.html", `${dest}/index.html`);
cpSync("web/bt10x.css", `${dest}/bt10x.css`);
cpSync("web/btlib10x.js", `${dest}/btlib10x.js`);
cpSync("web/btlib10x.data.js", `${dest}/btlib10x.data.js`);
cpSync("web/app.js", `${dest}/app.js`);
cpSync("web/favicon.ico", `${dest}/favicon.ico`);
console.log(
  `dist/web: ${["index.html", "bt10x.css", "btlib10x.js", "btlib10x.data.js", "app.js", "favicon.ico"].join(", ")}`,
);
