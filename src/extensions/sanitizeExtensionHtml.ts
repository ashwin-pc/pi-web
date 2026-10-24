// Allow-list HTML sanitizer for pi-web extension-supplied HTML.
//
// Extension HTML is rendered into the authenticated SPA origin and must be
// neutralized at the host boundary (see finding 01a160d4994f7abcacdcec1a15c26aca:
// four innerHTML sinks were assigning extension-returned HTML without
// sanitization).  This module parses the provided HTML offline (via <template>)
// and returns a DocumentFragment that callers hand to
// Element.replaceChildren(fragment).  The allow-list is wider than the one
// used for agent markdown because panel/footer/system-info/git-tab
// contributions legitimately rely on form controls, data-* action attributes,
// inline SVG and simple styling, but it still removes script execution
// surfaces: <script>, event-handler attributes, scripting URLs and framing
// attributes that would allow same-origin inclusion.

const BLOCKED_TAGS = new Set([
  "script",
  "object",
  "embed",
  "base",
  "meta",
  "link",
  "iframe",
  "frame",
  "frameset",
  "applet",
  "portal",
]);

const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote",
  "br", "caption", "cite", "code", "col", "colgroup", "data", "dd", "del",
  "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "ins", "kbd",
  "label", "legend", "li", "main", "mark", "nav", "ol", "output", "p", "pre",
  "progress", "q", "s", "samp", "section", "small", "span", "strong", "sub",
  "summary", "sup", "table", "tbody", "td", "template", "tfoot", "th", "thead",
  "time", "tr", "u", "ul", "var", "wbr",
  "img", "audio", "video", "source", "track", "picture",
  "button", "datalist", "fieldset", "form", "input", "meter", "optgroup",
  "option", "select", "textarea",
  "svg", "g", "defs", "use", "symbol", "path", "circle", "ellipse", "line",
  "polygon", "polyline", "rect", "text", "tspan", "title", "desc", "marker",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern",
  "filter", "feGaussianBlur", "feOffset", "feBlend", "feMerge", "feMergeNode",
  "feColorMatrix", "feFlood", "feComposite",
  "style",
]);

const GLOBAL_ATTRS = new Set([
  "accesskey", "autocapitalize", "autofocus", "class", "dir", "draggable",
  "enterkeyhint", "hidden", "id", "inert", "inputmode", "is", "lang",
  "spellcheck", "style", "tabindex", "title", "translate", "role", "slot",
  "part",
]);

const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel", "download", "hreflang", "type", "ping"]),
  img: new Set(["src", "alt", "width", "height", "loading", "decoding", "sizes", "srcset", "crossorigin", "referrerpolicy"]),
  audio: new Set(["src", "controls", "autoplay", "loop", "muted", "preload", "crossorigin"]),
  video: new Set(["src", "controls", "autoplay", "loop", "muted", "preload", "poster", "width", "height", "playsinline", "crossorigin"]),
  source: new Set(["src", "srcset", "type", "media", "sizes"]),
  track: new Set(["src", "kind", "srclang", "label", "default"]),
  picture: new Set([]),
  form: new Set(["action", "method", "name", "autocomplete", "novalidate", "target", "accept-charset", "enctype"]),
  input: new Set([
    "type", "name", "value", "placeholder", "checked", "disabled", "readonly",
    "required", "min", "max", "step", "pattern", "maxlength", "minlength",
    "size", "list", "multiple", "autocomplete", "autofocus", "form",
    "formaction", "formmethod", "formnovalidate", "formtarget", "accept",
    "src", "alt", "width", "height",
  ]),
  textarea: new Set([
    "name", "value", "placeholder", "rows", "cols", "wrap", "disabled",
    "readonly", "required", "maxlength", "minlength", "autocomplete",
    "autofocus", "form",
  ]),
  select: new Set(["name", "disabled", "multiple", "required", "size", "form", "autocomplete", "autofocus"]),
  option: new Set(["value", "label", "selected", "disabled"]),
  optgroup: new Set(["label", "disabled"]),
  button: new Set(["type", "name", "value", "disabled", "autofocus", "form", "formaction", "formmethod", "formnovalidate", "formtarget"]),
  label: new Set(["for", "form"]),
  fieldset: new Set(["disabled", "form", "name"]),
  meter: new Set(["value", "min", "max", "low", "high", "optimum", "form"]),
  progress: new Set(["value", "max"]),
  output: new Set(["for", "form", "name"]),
  details: new Set(["open"]),
  table: new Set(["border", "cellpadding", "cellspacing", "summary"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  td: new Set(["colspan", "rowspan", "headers", "scope"]),
  th: new Set(["colspan", "rowspan", "headers", "scope", "abbr"]),
  time: new Set(["datetime"]),
  data: new Set(["value"]),
  ol: new Set(["start", "reversed", "type"]),
  li: new Set(["value"]),
  blockquote: new Set(["cite"]),
  q: new Set(["cite"]),
  del: new Set(["cite", "datetime"]),
  ins: new Set(["cite", "datetime"]),
};

const SVG_ATTRS = new Set([
  "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "x2", "y1", "y2", "d", "fill",
  "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity",
  "stroke-miterlimit", "opacity", "transform", "viewBox", "preserveAspectRatio",
  "width", "height", "points", "pathLength", "clip-rule", "clip-path",
  "color", "color-interpolation", "color-interpolation-filters", "cursor",
  "display", "dominant-baseline", "font-family", "font-size", "font-stretch",
  "font-style", "font-variant", "font-weight", "letter-spacing", "line-height",
  "marker-end", "marker-mid", "marker-start", "mask", "offset", "overflow",
  "paint-order", "pointer-events", "shape-rendering", "stop-color",
  "stop-opacity", "text-anchor", "text-decoration", "text-rendering",
  "vector-effect", "visibility", "word-spacing", "writing-mode", "xmlns",
  "xmlns:xlink", "gradientUnits", "gradientTransform", "spreadMethod",
  "patternUnits", "patternTransform", "patternContentUnits", "maskUnits",
  "maskContentUnits", "clipPathUnits", "filterUnits", "primitiveUnits", "in",
  "in2", "mode", "result", "stdDeviation", "operator", "flood-color",
  "flood-opacity", "values", "type", "orient", "refX", "refY", "markerWidth",
  "markerHeight", "markerUnits", "fx", "fy", "dx", "dy", "rotate", "textLength",
  "lengthAdjust", "startOffset", "method", "spacing",
]);

const URL_ATTRS = new Set([
  "href", "src", "action", "formaction", "cite", "poster", "data",
  "ping", "background", "xlink:href",
]);

const UNSAFE_SCHEMES = new Set(["javascript", "vbscript", "livescript", "mocha"]);

function isSafeUrl(name: string, raw: string, tagName: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (value.startsWith("#") || value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("?")) return true;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (!schemeMatch) return true;
  const scheme = schemeMatch[1].toLowerCase();
  if (UNSAFE_SCHEMES.has(scheme)) return false;
  if (scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel") return true;
  if (scheme === "data") {
    if ((name === "src" || name === "poster" || name === "srcset") && /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);/i.test(value)) {
      if (/^data:image\/svg\+xml/i.test(value) && tagName !== "img") return false;
      return true;
    }
    return false;
  }
  return false;
}

function isAttrAllowed(tagName: string, attrName: string, isSvg: boolean): boolean {
  if (attrName.startsWith("on")) return false;
  if (attrName.startsWith("data-")) return true;
  if (attrName.startsWith("aria-")) return true;
  if (GLOBAL_ATTRS.has(attrName)) return true;
  const perTag = TAG_ATTRS[tagName];
  if (perTag && perTag.has(attrName)) return true;
  if (isSvg && (SVG_ATTRS.has(attrName) || attrName === "href" || attrName === "xlink:href" || attrName === "id" || attrName === "class" || attrName === "style")) return true;
  return false;
}

function stripNode(node: Element) {
  const parent = node.parentNode;
  if (!parent) {
    node.remove();
    return;
  }
  while (node.firstChild) parent.insertBefore(node.firstChild, node);
  parent.removeChild(node);
}

function sanitizeStyleValue(value: string): string {
  const lowered = value.toLowerCase();
  if (lowered.includes("expression(")) return "";
  for (const scheme of UNSAFE_SCHEMES) {
    if (lowered.includes(scheme + ":")) return "";
  }
  return value.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, _quote, url) => {
    const trimmed = String(url).trim();
    if (/^(https?:|\/|#)/i.test(trimmed)) return match;
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(trimmed)) return match;
    return "none";
  });
}

/**
 * Parse untrusted extension HTML in an inert document and return a sanitized
 * DocumentFragment ready to pass to `Element.replaceChildren(fragment)`.
 *
 * The input is never attached to the live DOM during sanitization: <template>
 * parses into an owner document that does not run scripts, load images, or
 * execute event handlers, so even dangerous markup is defused before we walk
 * the tree.
 */
export function sanitizeExtensionHtml(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = typeof html === "string" ? html : "";

  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const toProcess: Element[] = [];
  let current = walker.nextNode();
  while (current) {
    toProcess.push(current as Element);
    current = walker.nextNode();
  }

  for (const element of toProcess) {
    const tagName = element.tagName.toLowerCase();
    const inSvg = element.namespaceURI === "http://www.w3.org/2000/svg" || tagName === "svg";

    if (BLOCKED_TAGS.has(tagName)) {
      element.remove();
      continue;
    }

    if (!ALLOWED_TAGS.has(tagName) && !inSvg) {
      stripNode(element);
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();

      if (!isAttrAllowed(tagName, name, inSvg)) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (URL_ATTRS.has(name)) {
        if (!isSafeUrl(name, attribute.value, tagName)) {
          element.removeAttribute(attribute.name);
          continue;
        }
      }

      if (name === "style") {
        const safe = sanitizeStyleValue(attribute.value);
        if (safe) element.setAttribute(attribute.name, safe);
        else element.removeAttribute(attribute.name);
        continue;
      }

      if (name === "srcset") {
        const parts = attribute.value.split(",").map((part) => part.trim()).filter(Boolean);
        const safe = parts.filter((part) => {
          const [url] = part.split(/\s+/, 1);
          return isSafeUrl("src", url || "", tagName);
        });
        if (safe.length) element.setAttribute(attribute.name, safe.join(", "));
        else element.removeAttribute(attribute.name);
        continue;
      }

      if (name === "target" && tagName === "a") {
        element.setAttribute("rel", "noopener noreferrer");
      }
    }
  }

  return template.content;
}
