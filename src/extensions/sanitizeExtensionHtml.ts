import DOMPurify from "dompurify";

const ACTIVE_CSS = /(?:@import|expression\s*\(|url\s*\(|behavior\s*:|-moz-binding)/i;

function isSameOriginUrl(value: string) {
  try {
    return new URL(value, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Sanitizes extension-authored markup before it enters pi-web's privileged
 * document. Forms, data/ARIA attributes, simple CSS, and static SVG remain
 * available, but browser-executable content is removed at the host boundary.
 */
export function sanitizeExtensionHtml(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  const styles = [...template.content.querySelectorAll("style")]
    .map((style) => style.textContent || "")
    .filter((css) => !ACTIVE_CSS.test(css));
  template.content.querySelectorAll("style").forEach((style) => style.remove());

  const fragment = DOMPurify.sanitize(template.innerHTML, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_ATTR: ["autofocus", "target"],
    FORBID_TAGS: ["iframe", "frame", "object", "embed", "portal"],
    FORBID_ATTR: ["srcdoc"],
  });

  for (const element of fragment.querySelectorAll<HTMLElement>("*")) {
    if (element.hasAttribute("style") && ACTIVE_CSS.test(element.getAttribute("style") || "")) {
      element.removeAttribute("style");
    }
    if (element instanceof HTMLFormElement) {
      if (element.hasAttribute("action") && !isSameOriginUrl(element.getAttribute("action") || "")) {
        element.removeAttribute("action");
      }
      element.removeAttribute("target");
    }
    if ((element instanceof HTMLButtonElement || element instanceof HTMLInputElement)
      && element.hasAttribute("formaction")
      && !isSameOriginUrl(element.getAttribute("formaction") || "")) {
      element.removeAttribute("formaction");
    }
    if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
      element.removeAttribute("formtarget");
    }
    if (element instanceof HTMLAnchorElement && element.target === "_blank") {
      element.rel = "noopener noreferrer";
    }
    if (element instanceof SVGUseElement) {
      for (const name of ["href", "xlink:href"]) {
        const value = element.getAttribute(name);
        if (value && !value.startsWith("#")) element.removeAttribute(name);
      }
    }
  }

  fragment.prepend(...styles.map((css) => {
    const style = document.createElement("style");
    style.textContent = css;
    return style;
  }));
  return fragment;
}
