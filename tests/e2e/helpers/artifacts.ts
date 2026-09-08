import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const previewHtml = `<!doctype html><html><body>
<h1>HTML artifact</h1>
<p id="static">Rendered in a sandboxed iframe.</p>
<p id="script-status">script did not run</p>
<script>
  const statuses = [];
  document.getElementById("script-status").textContent = "script ran";
  try {
    parent.document.body.dataset.artifactAccess = "unexpected";
    statuses.push("parent accessible");
  } catch (error) {
    statuses.push("parent blocked");
  }
  try {
    localStorage.getItem("pi-web-token");
    statuses.push("localStorage accessible");
  } catch (error) {
    statuses.push("localStorage blocked");
  }
  try {
    statuses.push(document.cookie ? "cookies visible" : "cookies empty");
  } catch (error) {
    statuses.push("cookies blocked");
  }
  const list = document.createElement("ul");
  list.id = "sandbox-status";
  for (const status of statuses) {
    const item = document.createElement("li");
    item.textContent = status;
    list.append(item);
  }
  document.body.append(list);
</script>
</body></html>`;

/** Each consuming spec owns setup; atomic identical writes are safe across shards. */
export async function ensurePreviewArtifact() {
  const dir = join(process.cwd(), ".pi", "web", "artifacts");
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.preview-${randomUUID()}.tmp`);
  await writeFile(temp, previewHtml);
  await rename(temp, join(dir, "preview.html"));
}
