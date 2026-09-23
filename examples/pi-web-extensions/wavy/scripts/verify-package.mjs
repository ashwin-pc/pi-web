#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const prefix = "package/";
const required = [
  "README.md", "package.json", "browser.js", "index.ts", "player.ts", "player-model.ts", "preview.ts",
"styles.css", "store.ts", "types.ts", "settings.ts", "engines.ts",
  "engine/README.md", "engine/sheetsage.py", "engine/yue.py", "skill/SKILL.md",
  "vendor/LICENSE.md", "vendor/abcjs-basic-min.js", "vendor/manifest.json",
];

function tar(archive, args, encoding = "utf8") {
  const result = spawnSync("tar", [...args, archive], { encoding, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Unable to inspect ${basename(archive)}: ${String(result.stderr || result.stdout)}`);
  return result.stdout;
}
function memberData(archive, member) {
  const result = spawnSync("tar", ["-xOzf", archive, member], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Unable to read packaged member ${member}: ${String(result.stderr || result.stdout)}`);
  return Buffer.from(result.stdout);
}
function canonicalMember(path) {
  return (path === "package" || path.startsWith("package/")) && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some(part => part === "." || part === ".." || part === "");
}

export async function verifyWavyPackage(archivePath, options = {}) {
  const archive = resolve(archivePath);
  const members = String(tar(archive, ["-tzf"])).split(/\r?\n/).filter(Boolean).map(path => path.replace(/\/$/, ""));
  if (members.some(path => !canonicalMember(path))) throw new Error("Package contains a non-canonical archive member path.");
  const unique = new Set(members);
  if (unique.size !== members.length) throw new Error("Package contains duplicate archive member paths.");

  const verbose = String(tar(archive, ["-tvzf"])).split(/\r?\n/).filter(Boolean);
  if (verbose.length !== members.length) throw new Error("Package archive metadata is inconsistent.");
  const memberTypes = new Map(members.map((path, index) => [path, verbose[index]?.[0]]));
  if ([...memberTypes.values()].some(type => type !== "-" && type !== "d")) throw new Error("Package contains a link or special archive member.");
  const forbidden = members.filter(path => /^package\/(?:tests|scripts)(?:\/|$)|^package\/engine\/test_/.test(path) || /(?:^|\/)(__pycache__|test-results|playwright-report)(?:\/|$)|\.py[co]$|\/\.pi\/web\/artifacts(?:\/|$)|\/browser\.js\.tmp-/i.test(path));
  if (forbidden.length) throw new Error(`Package contains generated cache/test artifacts: ${forbidden.join(", ")}`);

  for (const path of required) {
    const member = prefix + path;
    if (!unique.has(member)) throw new Error(`Packaged Wavy runtime is missing ${path}.`);
    if (memberTypes.get(member) !== "-") throw new Error(`Packaged Wavy runtime member must be a regular file: ${path}.`);
  }
  const manifest = JSON.parse(memberData(archive, prefix + "vendor/manifest.json").toString("utf8"));
  const shipped = manifest.upstreams.flatMap(upstream => upstream.shippedFiles.map(file => file.path));
  for (const upstream of manifest.upstreams) {
    if (!unique.has(prefix + "vendor/" + upstream.notice)) throw new Error(`Packaged vendor notice is missing: ${upstream.notice}`);
    for (const file of upstream.shippedFiles) {
      const member = prefix + "vendor/" + file.path;
      if (!unique.has(member)) throw new Error(`Packaged vendored file is missing: ${file.path}`);
      const data = memberData(archive, member);
      const hash = createHash("sha256").update(data).digest("hex");
      if (data.byteLength !== file.bytes || hash !== file.sha256) throw new Error(`Vendored file does not match manifest: ${file.path}`);
    }
  }
  const allowedVendor = new Set(["LICENSE.md", "manifest.json", ...shipped]);
  const unexpectedVendor = members.filter(path => path.startsWith(prefix + "vendor/") && !allowedVendor.has(path.slice((prefix + "vendor/").length)));
  if (unexpectedVendor.length) throw new Error(`Undeclared vendored files in package: ${unexpectedVendor.join(", ")}`);

  const localBrowserPath = options.localBrowserPath ?? resolve(import.meta.dirname, "../browser.js");
  const [localBrowser, packagedBrowser] = await Promise.all([readFile(localBrowserPath), Promise.resolve(memberData(archive, prefix + "browser.js"))]);
  if (!localBrowser.equals(packagedBrowser)) throw new Error("Packaged Wavy browser bundle differs from the canonical locally generated bundle.");

  console.log(`Verified packaged Wavy runtime and ${shipped.length} vendored files in ${basename(archive)}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archive = process.argv[2];
  if (!archive) throw new Error("Usage: node scripts/verify-package.mjs <package.tgz>");
  await verifyWavyPackage(archive);
}
