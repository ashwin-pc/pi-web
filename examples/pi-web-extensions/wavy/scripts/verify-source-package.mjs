#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
await access(resolve(root, "browser.js"));
const manifest = JSON.parse(await readFile(resolve(root, "vendor/manifest.json"), "utf8"));
for (const upstream of manifest.upstreams) {
  await access(resolve(root, "vendor", upstream.notice));
  for (const file of upstream.shippedFiles) {
    const data = await readFile(resolve(root, "vendor", file.path));
    const hash = createHash("sha256").update(data).digest("hex");
    if (data.byteLength !== file.bytes || hash !== file.sha256) {
      throw new Error(`Vendored file does not match manifest: ${file.path}`);
    }
  }
}
console.log("Wavy source package contents verified.");
