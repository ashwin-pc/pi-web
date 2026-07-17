import "./style.css";
import "highlight.js/styles/github-dark.css";
import { renderStandaloneMarkdown } from "./markdown/render.js";

function allowedArtifactPath(value: string | null) {
  if (!value) return "";
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return "";
    if (!url.pathname.startsWith("/api/artifacts/")) return "";
    const lower = url.pathname.toLowerCase();
    if (!lower.endsWith(".md") && !lower.endsWith(".markdown")) return "";
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

function artifactName(pathname: string) {
  try { return decodeURIComponent(pathname.split("/").pop() || "artifact"); } catch { return pathname.split("/").pop() || "artifact"; }
}

const params = new URLSearchParams(window.location.search);
const src = allowedArtifactPath(params.get("src"));
const title = document.querySelector<HTMLHeadingElement>("#artifactPreviewTitle");
const raw = document.querySelector<HTMLAnchorElement>("#artifactPreviewRaw");
const body = document.querySelector<HTMLElement>("#artifactPreviewBody");
const back = document.querySelector<HTMLButtonElement>("#artifactPreviewBack");

back?.addEventListener("click", () => {
  if (window.history.length > 1) window.history.back();
  else window.location.href = "/";
});

async function loadPreview() {
  if (!body || !title || !raw) return;
  if (!src) {
    body.textContent = "Invalid markdown artifact preview URL.";
    return;
  }

  const name = params.get("name") || artifactName(src);
  document.title = name;
  title.textContent = name;
  raw.href = src;

  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Preview failed (${res.status})`);
    renderStandaloneMarkdown(body, await res.text());
  } catch (error) {
    body.textContent = error instanceof Error ? error.message : String(error);
  }
}

void loadPreview();
