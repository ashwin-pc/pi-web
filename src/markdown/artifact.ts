import { renderStandaloneMarkdown } from "./render.js";

/** Keep artifact blocks in one responsive column, independent of block margins. */
export function renderArtifactMarkdown(body: HTMLElement, text: string, options: { sessionId?: string } = {}) {
  const content = document.createElement("div");
  content.className = "artifactMarkdownContent";
  body.replaceChildren(content);
  renderStandaloneMarkdown(content, text, options);
}
