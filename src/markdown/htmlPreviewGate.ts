import type { Role } from "../app/types.js";
import { alwaysAllowHost, decideContent, type ContentResource } from "../security/contentPolicy.js";

export type HtmlPreviewGateOptions = {
  source: string;
  sourceElement?: HTMLPreElement;
  frameClassName?: string;
  frameTitle?: string;
  from?: { sessionId: string; role: Role };
  inertFrame?: boolean;
  artifactBaseUrl?: string;
  onMount?: (frame: HTMLIFrameElement) => void;
};

const baseDirectives = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "frame-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
];

export function previewContentSecurityPolicy(
  allowedOrigins: Iterable<string> = [],
  trustedBaseUrl?: string,
) {
  const allowed = new Set(allowedOrigins);
  const trustedBaseSource = trustedBaseUrl?.replace(/[;,]/g, (character) =>
    character === ";" ? "%3B" : "%2C");
  if (trustedBaseSource) allowed.add(trustedBaseSource);
  const origins = [...allowed].sort().join(" ");
  return baseDirectives.map((directive) => {
    const name = directive.split(" ", 1)[0];
    if (name === "base-uri") return trustedBaseSource ? `base-uri ${trustedBaseSource}` : directive;
    if (!origins) return directive;
    if (name === "connect-src" || name === "frame-src") return `${name} ${origins}`;
    return ["img-src", "script-src", "style-src", "font-src", "media-src"].includes(name)
      ? `${directive} ${origins}` : directive;
  }).join("; ");
}

function reporter() {
  return `(()=>{const send=value=>parent.postMessage(value,'*');const report=()=>{const b=document.body,e=document.documentElement;if(!b)return;const cs=getComputedStyle(b);let right=0,bottom=0,measured=false;for(const n of b.childNodes){let r;if(n.nodeType===1)r=n.getBoundingClientRect();else if(n.nodeType===3&&n.textContent.trim()){const range=document.createRange();range.selectNodeContents(n);r=range.getBoundingClientRect()}if(!r)continue;measured=true;right=Math.max(right,r.right);bottom=Math.max(bottom,r.bottom)}send({type:'pi-web-html-preview-size',height:Math.ceil(bottom+parseFloat(cs.marginBottom||'0')+parseFloat(cs.paddingBottom||'0')),width:measured?Math.ceil(right+parseFloat(cs.marginRight||'0')+parseFloat(cs.paddingRight||'0')):e.clientWidth})};addEventListener('securitypolicyviolation',e=>{document.documentElement.dataset.piWebBlockedUri=e.blockedURI;send({type:'pi-web-preview-policy',blockedURI:e.blockedURI})});addEventListener('click',e=>{const a=e.target&&e.target.closest&&e.target.closest('a[href]');if(a){e.preventDefault();send({type:'pi-web-preview-navigation',url:a.href})}},true);addEventListener('load',report);new ResizeObserver(report).observe(document.documentElement);new MutationObserver(report).observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});report()})()`;
}

export function artifactPreviewBaseUrl(value: string, appOrigin = window.location.origin) {
  try {
    const url = new URL(value, appOrigin);
    if (url.origin !== appOrigin || !/^\/api\/(?:artifacts|session-artifacts)\//.test(url.pathname)) return;
    url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return;
  }
}

function validatedArtifactBaseUrl(value: string | undefined) {
  if (!value) return;
  const base = artifactPreviewBaseUrl(value);
  return base === value ? new URL(base) : undefined;
}

export function containedPreviewDocument(
  source: string,
  allowedOrigins: Iterable<string> = [],
  artifactBaseUrl?: string,
) {
  const documentNode = new DOMParser().parseFromString(source, "text/html");
  const trustedBase = validatedArtifactBaseUrl(artifactBaseUrl);
  for (const existing of documentNode.head.querySelectorAll("base")) existing.remove();
  const policy = documentNode.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = previewContentSecurityPolicy(allowedOrigins, trustedBase?.href);
  documentNode.head.prepend(policy);
  let insertionPoint: HTMLElement = policy;
  if (trustedBase) {
    const base = documentNode.createElement("base");
    base.href = trustedBase.href;
    policy.after(base);
    insertionPoint = base;
  }
  const reportScript = documentNode.createElement("script");
  reportScript.textContent = reporter();
  insertionPoint.after(reportScript);
  return `<!doctype html>${documentNode.documentElement.outerHTML}`;
}

function safeRemoteOrigin(value: unknown): { origin: string; host: string } | undefined {
  if (typeof value !== "string" || !value || value.length > 8_192 || value === "inline" || value === "eval") return;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    return { origin: url.origin, host: url.host.toLowerCase() };
  } catch { return; }
}

export function createHtmlPreviewGate(options: HtmlPreviewGateOptions) {
  const from = options.from || { sessionId: "", role: "assistant" as const };
  const container = document.createElement("div");
  container.className = "htmlPreview";
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "Contained HTML preview");
  const approvedOrigins = new Set<string>();
  const pendingOrigins = new Map<string, string>();
  let showingSource = false;

  const notices = document.createElement("div");
  notices.className = "htmlPreviewNotices";
  notices.setAttribute("aria-live", "polite");

  let navigationUrl = "";
  let navigationNotice: HTMLDivElement | undefined;
  let navigationText: HTMLSpanElement | undefined;
  let navigationOpen: HTMLButtonElement | undefined;
  let frame: HTMLIFrameElement;

  const createFrame = () => {
    const next = document.createElement("iframe");
    next.className = options.frameClassName || "htmlPreviewFrame";
    next.title = options.frameTitle || "Interactive HTML preview";
    next.setAttribute("sandbox", "allow-scripts");
    next.referrerPolicy = "no-referrer";
    if (options.inertFrame) {
      next.inert = true;
      next.tabIndex = -1;
      next.setAttribute("aria-hidden", "true");
    }
    next.hidden = showingSource;
    let loads = 0;
    next.addEventListener("load", () => {
      loads += 1;
      if (next === frame && loads > 1) showNavigation();
    });
    next.srcdoc = containedPreviewDocument(options.source, approvedOrigins, options.artifactBaseUrl);
    return next;
  };

  const reload = () => {
    const previous = frame;
    frame = createFrame();
    previous.replaceWith(frame);
    options.onMount?.(frame);
  };

  const addApprovalNotice = (origin: string, host: string) => {
    if (pendingOrigins.has(origin)) return;
    pendingOrigins.set(origin, host);
    const notice = document.createElement("div");
    notice.className = "htmlPreviewNotice";
    notice.dataset.origin = origin;
    const text = document.createElement("span");
    text.textContent = `This preview tried to reach ${host}`;
    const allow = document.createElement("button");
    allow.type = "button";
    allow.textContent = "Allow for this preview";
    const persist = document.createElement("button");
    persist.type = "button";
    persist.textContent = "Always allow host";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    const approve = () => {
      approvedOrigins.add(origin);
      pendingOrigins.delete(origin);
      notice.remove();
      reload();
    };
    allow.addEventListener("click", approve);
    persist.addEventListener("click", async () => {
      persist.disabled = true;
      try { await alwaysAllowHost(host); approve(); }
      catch (error) { persist.disabled = false; persist.title = error instanceof Error ? error.message : String(error); }
    });
    dismiss.addEventListener("click", () => { pendingOrigins.delete(origin); notice.remove(); });
    notice.append(text, allow, persist, dismiss);
    notices.append(notice);
  };

  const showNavigation = () => {
    const parsed = safeRemoteOrigin(navigationUrl);
    if (navigationNotice?.isConnected) {
      navigationText!.textContent = `This preview tried to open ${parsed?.host || "another page"}`;
      navigationOpen!.disabled = !parsed;
      return;
    }
    if (!frame.isConnected) return;
    const notice = document.createElement("div");
    notice.className = "htmlPreviewNavigation";
    const text = document.createElement("span");
    text.textContent = `This preview tried to open ${parsed?.host || "another page"}`;
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open in new tab";
    open.disabled = !parsed;
    open.addEventListener("click", async () => {
      const destination = safeRemoteOrigin(navigationUrl);
      if (!destination) return;
      const verdict = await decideContent({ kind: "preview-navigation", url: navigationUrl, from });
      if (verdict.action !== "block") window.open(navigationUrl, "_blank", "noopener,noreferrer");
    });
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = "Reload preview";
    restore.addEventListener("click", () => {
      navigationUrl = "";
      navigationNotice = undefined;
      navigationText = undefined;
      navigationOpen = undefined;
      frame = createFrame();
      notice.replaceWith(frame);
      options.onMount?.(frame);
    });
    notice.append(text, open, restore);
    navigationNotice = notice;
    navigationText = text;
    navigationOpen = open;
    frame.replaceWith(notice);
  };

  const onPolicyChanged = () => {
    void Promise.all([...pendingOrigins.keys()].map(async (origin) => ({
      origin,
      verdict: await decideContent({ kind: "preview-request", url: origin, from }),
    }))).then((results) => {
      let changed = false;
      for (const { origin, verdict } of results) {
        if (verdict.action !== "allow" || !pendingOrigins.has(origin)) continue;
        approvedOrigins.add(origin);
        pendingOrigins.delete(origin);
        notices.querySelector<HTMLElement>(`[data-origin="${CSS.escape(origin)}"]`)?.remove();
        changed = true;
      }
      if (changed && frame.isConnected) reload();
    });
  };

  const onMessage = (event: MessageEvent) => {
    if (!container.isConnected) {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("pi-web-content-policy-changed", onPolicyChanged);
      return;
    }
    if (event.source !== frame.contentWindow || !event.data || typeof event.data !== "object") return;
    const data = event.data as { type?: unknown; blockedURI?: unknown; url?: unknown };
    if (data.type === "pi-web-preview-navigation" && typeof data.url === "string" && data.url.length <= 8_192) {
      navigationUrl = data.url;
      showNavigation();
      return;
    }
    if (data.type !== "pi-web-preview-policy") return;
    const parsed = safeRemoteOrigin(data.blockedURI);
    if (!parsed || approvedOrigins.has(parsed.origin)) return;
    const resource: ContentResource = { kind: "preview-request", url: parsed.origin, from };
    void decideContent(resource).then((verdict) => {
      if (!frame.isConnected) return;
      if (verdict.action === "allow") {
        approvedOrigins.add(parsed.origin);
        reload();
      } else if (verdict.action !== "block") {
        addApprovalNotice(parsed.origin, parsed.host);
      }
    });
  };
  window.addEventListener("message", onMessage);
  document.addEventListener("pi-web-content-policy-changed", onPolicyChanged);

  frame = createFrame();
  if (options.sourceElement) {
    const sourceElement = options.sourceElement;
    sourceElement.hidden = true;
    const controls = document.createElement("div");
    controls.className = "htmlPreviewControls";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.textContent = "Source";
    toggle.title = "Show HTML source";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-pressed", "false");
    toggle.addEventListener("click", () => {
      showingSource = !showingSource;
      frame.hidden = showingSource;
      notices.hidden = showingSource;
      sourceElement.hidden = !showingSource;
      container.classList.toggle("htmlPreview--source", showingSource);
      toggle.textContent = showingSource ? "Preview" : "Source";
      toggle.title = showingSource ? "Show interactive preview" : "Show HTML source";
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-pressed", String(showingSource));
    });
    controls.append(toggle);
    container.append(controls, frame, notices, sourceElement);
  } else {
    container.append(frame, notices);
  }
  options.onMount?.(frame);
  return container;
}
