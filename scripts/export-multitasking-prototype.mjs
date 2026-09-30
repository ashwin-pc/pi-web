import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../docs/prototypes/multitasking-shell/", import.meta.url);
const output = process.argv[2] || "/tmp/pi-web-multitasking.html";
const [template, styles, script] = await Promise.all([
  readFile(new URL("index.html", root), "utf8"),
  readFile(new URL("style.css", root), "utf8"),
  readFile(new URL("shell.js", root), "utf8"),
]);
const html = template
  .replace('<link rel="stylesheet" href="style.css">', () => `<style>${styles.replace(/<\/style/gi, "<\\/style")}</style>`)
  .replace('<script defer src="shell.js"></script>', () => "")
  .replace("</body>", () => `<script>${script.replace(/<\/script/gi, "<\\/script")}</script>\n</body>`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html);
console.log(`Exported ${fileURLToPath(root)} to ${output}`);
