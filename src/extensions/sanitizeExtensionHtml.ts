import DOMPurify from "dompurify";

function isSameOriginUrl(value: string) {
  try {
    return new URL(value, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Sanitizes extension-authored markup before it enters pi-web's privileged
 * document. Forms, data/ARIA attributes, styles, and static SVG remain
 * available, but browser-executable content is removed at the host boundary.
 */
export function sanitizeExtensionHtml(html: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORCE_BODY: true,
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_ATTR: ["autofocus", "target"],
    FORBID_TAGS: ["iframe", "frame", "object", "embed", "portal"],
    FORBID_ATTR: ["srcdoc"],
  });

  for (const element of fragment.querySelectorAll<HTMLElement>("*")) {
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
    if ((element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement) && element.hasAttribute("target")) {
      element.rel = "noopener noreferrer";
    }
    if (element instanceof SVGUseElement) {
      for (const name of ["href", "xlink:href"]) {
        const value = element.getAttribute(name);
        if (value && !value.startsWith("#")) element.removeAttribute(name);
      }
    }
  }
  return fragment;
}
