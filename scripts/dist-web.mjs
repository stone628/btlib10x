import { cpSync, mkdirSync, rmSync } from "node:fs";

const dest = "dist/web";
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync("web/index.html", `${dest}/index.html`);
cpSync("web/app.js", `${dest}/app.js`);
cpSync("web/favicon.ico", `${dest}/favicon.ico`);
console.log(`dist/web: ${["index.html", "app.js", "favicon.ico"].join(", ")}`);
