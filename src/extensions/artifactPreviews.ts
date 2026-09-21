import type { ComposerContextAttachment } from "../app/types.js";
import { sameComposerReviewSnapshot, type ComposerReviewEffects, type ComposerReviewSnapshot } from "../composer/composer.js";
import { readArtifactPreviewTheme, type ArtifactPreviewTheme } from "./artifactPreviewTheme.js";

export type ArtifactPreviewKind = "image" | "markdown" | "html" | "video" | "audio" | "pdf" | "file";
type ArtifactPreviewDescriptor = { key?: unknown; title?: unknown; label?: unknown; match?: { kinds?: unknown; extensions?: unknown }; kinds?: unknown; extensions?: unknown; interaction?: { registrationId?: unknown; actions?: unknown } };
export type ArtifactContext = { name: string; path: string; kind: ArtifactPreviewKind };
export type ArtifactPreviewMountOptions = { title: string; className?: string; isCurrent?: () => boolean };
export type ArtifactPreviewAsset = { id: string; path: string; mediaType: string; bytes: number; sha256?: string };

type AssetJob = { requestId: string; asset: ArtifactPreviewAsset; controller: AbortController };
type ReviewProposal = { title: string; summary?: string; effects: [{ type: "insert-composer-text"; text: string; placement: "end" }, { type: "add-composer-context"; context: ComposerContextAttachment }] };
type ReviewOutcome = { status: "added" | "cancelled" | "stale" | "unsupported"; message?: string };
export type ArtifactPreviewViewport = { width: number; height: number; visible: { left: number; top: number; right: number; bottom: number } };
type Mount = { frame: HTMLIFrameElement; descriptor: ArtifactPreviewDescriptor; artifact: ArtifactContext; sessionId: string; channel: string; assets: Map<string, ArtifactPreviewAsset>; controllers: Map<string, AbortController>; reviewControllers: Map<string, AbortController>; queue: AssetJob[]; activeLoads: number; activeBytes: number; disposed: boolean; viewportObserver?: IntersectionObserver; viewportResizeObserver?: ResizeObserver; viewportCleanup: Array<() => void>; viewportRefreshFrame?: number; lastViewport?: ArtifactPreviewViewport };
let descriptors: ArtifactPreviewDescriptor[] = [];
let requestHeaders: () => HeadersInit = () => ({ "content-type": "application/json" });
let sessionId = () => "";
let snapshotDraft = (): ComposerReviewSnapshot => ({ sessionId: "", revision: -1, selectionStart: 0, selectionEnd: 0, contextRevision: -1 });
let applyReviewedEffects = (_snapshot: ComposerReviewSnapshot, _effects: ComposerReviewEffects) => false;
let previewOcclusions = (_frame: HTMLIFrameElement): Element[] => [];
const mounts = new Set<Mount>();
const ASSET_REQUEST_TIMEOUT_MS = 30_000;
const REVIEW_REQUEST_TIMEOUT_MS = 3 * 60_000;
const MAX_GLOBAL_REVIEWS = 4;
let appearanceObserver: MutationObserver | undefined;
let runtimeActive = false;

function startPreviewRuntime() {
  if (runtimeActive || typeof window === "undefined") return;
  runtimeActive = true;
  window.addEventListener("message", onMessage);
  if (typeof MutationObserver !== "undefined") {
    appearanceObserver = new MutationObserver((records) => {
      for (const mount of Array.from(mounts)) if (!mount.frame.isConnected || mount.sessionId !== sessionId()) disposeMount(mount);
      if (records.some((record) => record.type === "attributes" && (record.target === document.documentElement || record.target === document.body))) broadcastArtifactPreviewTheme();
    });
    appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-density"], childList: true, subtree: true });
  }
}
function stopPreviewRuntime() {
  if (!runtimeActive) return;
  runtimeActive = false;
  window.removeEventListener("message", onMessage);
  appearanceObserver?.disconnect();
  appearanceObserver = undefined;
}
function syncPreviewRuntime() {
  if (mounts.size) startPreviewRuntime();
  else stopPreviewRuntime();
}

export function configureArtifactPreviews(options: { headers: () => HeadersInit; getSessionId: () => string; snapshotDraft?: () => ComposerReviewSnapshot; applyReviewedEffects?: (snapshot: ComposerReviewSnapshot, effects: ComposerReviewEffects) => boolean; getOcclusions?: (frame: HTMLIFrameElement) => Element[] }) {
  requestHeaders = options.headers;
  sessionId = options.getSessionId;
  snapshotDraft = options.snapshotDraft || snapshotDraft;
  applyReviewedEffects = options.applyReviewedEffects || applyReviewedEffects;
  previewOcclusions = options.getOcclusions || previewOcclusions;
  // Configuration is inert until a preview is actually mounted. If dependencies
  // are replaced while mounted, rebuild only the shared observer.
  if (runtimeActive) {
    stopPreviewRuntime();
    startPreviewRuntime();
  }
}

export function setArtifactPreviews(value: unknown) {
  descriptors = Array.isArray(value) ? value : [];
  for (const mount of mounts) if (!descriptorIsCurrent(mount.descriptor)) disposeMount(mount);
}
export function broadcastArtifactPreviewTheme() {
  const theme = readArtifactPreviewTheme();
  for (const mount of mounts) post(mount, { type: "theme", theme });
}
export function disposeArtifactPreviews() {
  for (const mount of Array.from(mounts)) disposeMount(mount);
}
function descriptorIsCurrent(descriptor: ArtifactPreviewDescriptor) {
  if (typeof descriptor.key !== "string") return false;
  return descriptors.some((candidate) => candidate?.key === descriptor.key
    && (descriptor.interaction?.registrationId === undefined || candidate.interaction?.registrationId === descriptor.interaction.registrationId));
}
function mountIsCurrent(mount: Mount) {
  return !mount.disposed && mount.frame.isConnected && sessionId() === mount.sessionId && descriptorIsCurrent(mount.descriptor);
}
function stringList(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
export function matchingArtifactPreview(name: string, kind: ArtifactPreviewKind) {
  const lowerName = name.toLowerCase();
  return descriptors.find((raw) => {
    if (typeof raw?.key !== "string" || !raw.key) return false;
    const kinds = stringList(raw.match?.kinds ?? raw.kinds);
    if (kinds.length && !kinds.includes(kind)) return false;
    const extensions = stringList(raw.match?.extensions ?? raw.extensions);
    return !extensions.length || extensions.some((extension) => lowerName.endsWith(extension.toLowerCase()));
  });
}

function validAsset(raw: unknown): raw is ArtifactPreviewAsset {
  if (!raw || typeof raw !== "object") return false;
  const a = raw as Record<string, unknown>;
  return typeof a.id === "string" && a.id.length > 0 && a.id.length <= 128 && typeof a.path === "string" && /^\/api\/session-artifacts\/[^/?#]+\/[^?#]+$/.test(a.path) && a.path.length <= 4096 && !a.path.includes("\0") && typeof a.mediaType === "string" && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(a.mediaType) && !/(?:html|javascript)/i.test(a.mediaType) && Number.isSafeInteger(a.bytes) && (a.bytes as number) >= 0 && (a.bytes as number) <= 128 * 1024 * 1024 && (a.sha256 === undefined || typeof a.sha256 === "string" && /^[a-f\d]{64}$/i.test(a.sha256));
}
function parseAssets(value: unknown) {
  if (!Array.isArray(value) || value.length > 128 || JSON.stringify(value).length > 64 * 1024) return [];
  const result: ArtifactPreviewAsset[] = []; const ids = new Set<string>();
  for (const item of value) { if (!validAsset(item) || ids.has(item.id)) return []; ids.add(item.id); result.push(item); }
  return result;
}
export async function renderArtifactPreview(descriptor: ArtifactPreviewDescriptor, artifact: ArtifactContext) {
  if (typeof descriptor.key !== "string" || !descriptor.key) throw new Error("Invalid artifact preview contribution");
  const response = await fetch("/api/web-contributions/invoke", { method: "POST", headers: requestHeaders(), body: JSON.stringify({ sessionId: sessionId(), slot: "artifact-preview", key: descriptor.key, event: { context: artifact } }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok || typeof data.html !== "string") throw new Error(data.error || response.statusText || "Artifact preview failed");
  return { html: data.html as string, assets: parseAssets(data.assets), label: typeof data.label === "string" ? data.label : undefined };
}
function randomChannel() { const bytes = crypto.getRandomValues(new Uint8Array(18)); return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""); }
function safeJson(value: unknown) { return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"); }
function bootstrap(channel: string, assets: ArtifactPreviewAsset[], theme: ArtifactPreviewTheme) {
  const publicAssets = assets.map(({ id, mediaType, bytes }) => ({ id, mediaType, bytes }));
  return `<script>(()=>{const C=${safeJson(channel)},A=${safeJson(publicAssets)},Z=Object.freeze({width:0,height:0,visible:Object.freeze({left:0,top:0,right:0,bottom:0})});let T=${safeJson(theme)},V=Z,n=0,dead=false,reviewPending=false;const p=new Map(),subs=new Set(),vsubs=new Set(),dsubs=new Set();function apply(t){T=t;for(const[k,v]of Object.entries(t.tokens||{}))document.documentElement.style.setProperty(k,String(v));document.documentElement.style.colorScheme=t.colorScheme||"dark";document.documentElement.dataset.piWebDensity=t.density||"comfortable";for(const f of subs)try{f(T)}catch{}}function viewport(v){V=Object.freeze({...v,visible:Object.freeze({...v.visible})});for(const f of vsubs)try{f(V)}catch{}}addEventListener("message",e=>{const m=e.data;if(e.source!==parent||!m||m.piWebPreview!==C||dead)return;if(m.type==="asset-result"){const q=p.get(m.requestId);if(!q)return;p.delete(m.requestId);q.cleanup();m.ok?q.resolve(new Blob([m.buffer],{type:m.mediaType})):q.reject(new Error(m.error||"Asset load failed"))}else if(m.type==="review-result"){const q=p.get("r:"+m.requestId);if(!q)return;p.delete("r:"+m.requestId);reviewPending=false;q.resolve(m.outcome)}else if(m.type==="theme")apply(m.theme);else if(m.type==="viewport")viewport(m.viewport);else if(m.type==="disposed"){dead=true;reviewPending=false;for(const f of dsubs)try{f()}catch{}dsubs.clear();for(const q of p.values()){q.cleanup?.();q.reject(new Error("Preview is no longer available"))}p.clear();subs.clear();vsubs.clear()}});apply(T);Object.defineProperty(window,"piWebPreview",{value:Object.freeze({version:1,hosted:true,assets:Object.freeze(A),loadAsset(id,o={}){return new Promise((resolve,reject)=>{if(dead)return reject(new Error("Preview is no longer available"));if(typeof id!=="string"||!A.some(a=>a.id===id))return reject(new Error("Unknown asset"));if(p.size>=32)return reject(new Error("Too many asset requests"));const requestId=String(++n);const abort=()=>{p.delete(requestId);parent.postMessage({piWebPreview:C,type:"cancel",requestId},"*");reject(new DOMException("Aborted","AbortError"))};if(o.signal?.aborted)return abort();o.signal?.addEventListener("abort",abort,{once:true});p.set(requestId,{resolve,reject,cleanup:()=>o.signal?.removeEventListener("abort",abort)});parent.postMessage({piWebPreview:C,type:"load",requestId,id},"*")})},requestReview(request){return new Promise((resolve,reject)=>{if(dead)return reject(new Error("Preview is no longer available"));if(reviewPending)return resolve({status:"unsupported",message:"A review is already open."});if(!request||typeof request.action!=="string")return resolve({status:"unsupported",message:"Invalid review request."});let encoded;try{encoded=JSON.stringify(request.payload)}catch{return resolve({status:"unsupported",message:"Review payload must be JSON."})}if(encoded!==undefined&&new TextEncoder().encode(encoded).byteLength>32768)return resolve({status:"unsupported",message:"Review payload is too large."});reviewPending=true;const requestId=String(++n);p.set("r:"+requestId,{resolve,reject});parent.postMessage({piWebPreview:C,type:"review",requestId,action:request.action,payload:request.payload},"*")})},get theme(){return T},onThemeChange(fn){if(typeof fn!=="function")throw new TypeError("callback required");subs.add(fn);return()=>subs.delete(fn)},get viewport(){return V},onViewportChange(fn){if(typeof fn!=="function")throw new TypeError("callback required");vsubs.add(fn);return()=>vsubs.delete(fn)},onDispose(fn){if(typeof fn!=="function")throw new TypeError("callback required");if(dead){try{fn()}catch{}return()=>{}}dsubs.add(fn);return()=>dsubs.delete(fn)}}),writable:false,configurable:false});parent.postMessage({piWebPreview:C,type:"ready"},"*")})();</script>`;
}
function injectBootstrap(html: string, script: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.head.insertAdjacentHTML("afterbegin", script);
  const doctype = parsed.doctype;
  const declaration = doctype ? `<!DOCTYPE ${doctype.name}${doctype.publicId ? ` PUBLIC "${doctype.publicId}"` : ""}${doctype.systemId ? `${doctype.publicId ? "" : " SYSTEM"} "${doctype.systemId}"` : ""}>` : "";
  return declaration + parsed.documentElement.outerHTML;
}
function post(mount: Mount, message: Record<string, unknown>, transfer: Transferable[] = []) { if (!mount.disposed) mount.frame.contentWindow?.postMessage({ piWebPreview: mount.channel, ...message }, "*", transfer); }

const zeroVisible = () => ({ left: 0, top: 0, right: 0, bottom: 0 });
const finiteDimension = (value: number) => Number.isFinite(value) ? Math.min(100_000, Math.max(0, value)) : 0;
const rounded = (value: number) => Math.round(value * 1_000) / 1_000;
export function artifactPreviewViewportGeometry(input: {
  frameRect: Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">;
  intersectionRect?: Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom">;
  occlusionRects?: Array<Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom" | "width" | "height">>;
  clientWidth: number; clientHeight: number; clientLeft: number; clientTop: number; offsetWidth: number; offsetHeight: number;
}): ArtifactPreviewViewport {
  const width = finiteDimension(input.clientWidth); const height = finiteDimension(input.clientHeight);
  const scaleX = input.offsetWidth > 0 && Number.isFinite(input.frameRect.width) ? input.frameRect.width / input.offsetWidth : 0;
  const scaleY = input.offsetHeight > 0 && Number.isFinite(input.frameRect.height) ? input.frameRect.height / input.offsetHeight : 0;
  const intersection = input.intersectionRect;
  if (!width || !height || !scaleX || !scaleY || !Number.isFinite(scaleX) || !Number.isFinite(scaleY) || !intersection) return { width, height, visible: zeroVisible() };
  const contentLeft = input.frameRect.left + input.clientLeft * scaleX;
  const contentTop = input.frameRect.top + input.clientTop * scaleY;
  const contentRight = contentLeft + width * scaleX;
  const contentBottom = contentTop + height * scaleY;
  const left = Math.max(contentLeft, intersection.left); const top = Math.max(contentTop, intersection.top);
  const right = Math.min(contentRight, intersection.right); let bottom = Math.min(contentBottom, intersection.bottom);
  for (const occlusion of input.occlusionRects || []) {
    if (!Number.isFinite(occlusion.width) || !Number.isFinite(occlusion.height) || occlusion.width <= 0 || occlusion.height <= 0) continue;
    const overlapsX = occlusion.right > left && occlusion.left < right;
    const overlapsVisibleY = occlusion.bottom > top && occlusion.top < bottom;
    if (overlapsX && overlapsVisibleY) bottom = Math.min(bottom, Math.max(top, occlusion.top));
  }
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return { width, height, visible: zeroVisible() };
  return {
    width, height,
    visible: {
      left: rounded(Math.min(width, Math.max(0, (left - contentLeft) / scaleX))),
      top: rounded(Math.min(height, Math.max(0, (top - contentTop) / scaleY))),
      right: rounded(Math.min(width, Math.max(0, (right - contentLeft) / scaleX))),
      bottom: rounded(Math.min(height, Math.max(0, (bottom - contentTop) / scaleY))),
    },
  };
}
function viewportKey(value: ArtifactPreviewViewport) { return JSON.stringify(value); }
function publishViewport(mount: Mount, intersectionRect?: Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom">) {
  if (!mountIsCurrent(mount)) { disposeMount(mount); return; }
  const frame = mount.frame;
  const viewport = artifactPreviewViewportGeometry({
    frameRect: frame.getBoundingClientRect(), intersectionRect,
    occlusionRects: previewOcclusions(frame).filter((element) => element.isConnected).map((element) => element.getBoundingClientRect()),
    clientWidth: frame.clientWidth, clientHeight: frame.clientHeight, clientLeft: frame.clientLeft, clientTop: frame.clientTop,
    offsetWidth: frame.offsetWidth, offsetHeight: frame.offsetHeight,
  });
  if (mount.lastViewport && viewportKey(mount.lastViewport) === viewportKey(viewport)) return;
  mount.lastViewport = viewport;
  post(mount, { type: "viewport", viewport });
}
function scheduleFreshViewportObservation(mount: Mount) {
  if (mount.disposed || mount.viewportRefreshFrame !== undefined) return;
  mount.viewportRefreshFrame = requestAnimationFrame(() => {
    mount.viewportRefreshFrame = undefined;
    if (!mountIsCurrent(mount)) { disposeMount(mount); return; }
    // Never rescale a cached intersection rectangle against changed geometry.
    // Re-observing requests a fresh native IntersectionObserver entry.
    mount.viewportObserver?.unobserve(mount.frame);
    mount.viewportObserver?.observe(mount.frame);
  });
}
function attachViewportObservation(mount: Mount) {
  const resendAfterFrameLoad = () => {
    if (!mountIsCurrent(mount)) { disposeMount(mount); return; }
    if (mount.lastViewport) post(mount, { type: "viewport", viewport: mount.lastViewport });
    else scheduleFreshViewportObservation(mount);
  };
  mount.frame.addEventListener("load", resendAfterFrameLoad);
  mount.viewportCleanup.push(() => mount.frame.removeEventListener("load", resendAfterFrameLoad));
  if (typeof IntersectionObserver === "undefined") return;
  mount.viewportObserver = new IntersectionObserver((entries) => {
    const entry = entries.find((candidate) => candidate.target === mount.frame);
    if (entry) publishViewport(mount, entry.intersectionRect);
  }, { threshold: Array.from({ length: 1_001 }, (_, index) => index / 1_000) });
  mount.viewportObserver.observe(mount.frame);
  if (typeof ResizeObserver !== "undefined") {
    mount.viewportResizeObserver = new ResizeObserver(() => scheduleFreshViewportObservation(mount));
    for (let node: Element | null = mount.frame; node; node = node.parentElement) mount.viewportResizeObserver.observe(node);
    for (const element of previewOcclusions(mount.frame)) if (element.isConnected) mount.viewportResizeObserver.observe(element);
  }
  const refresh = () => scheduleFreshViewportObservation(mount);
  window.addEventListener("resize", refresh, { passive: true });
  document.addEventListener("scroll", refresh, { passive: true, capture: true });
  window.visualViewport?.addEventListener("resize", refresh, { passive: true });
  window.visualViewport?.addEventListener("scroll", refresh, { passive: true });
  mount.viewportCleanup.push(
    () => window.removeEventListener("resize", refresh),
    () => document.removeEventListener("scroll", refresh, true),
    () => window.visualViewport?.removeEventListener("resize", refresh),
    () => window.visualViewport?.removeEventListener("scroll", refresh),
  );
}
function disposeMount(mount: Mount) {
  if (mount.disposed) return;
  mount.frame.contentWindow?.postMessage({ piWebPreview: mount.channel, type: "disposed" }, "*");
  mount.disposed = true;
  mounts.delete(mount);
  mount.viewportObserver?.disconnect();
  mount.viewportResizeObserver?.disconnect();
  if (mount.viewportRefreshFrame !== undefined) cancelAnimationFrame(mount.viewportRefreshFrame);
  for (const cleanup of mount.viewportCleanup) cleanup();
  mount.viewportCleanup = [];
  for (const controller of mount.controllers.values()) controller.abort();
  for (const controller of mount.reviewControllers.values()) controller.abort();
  mount.controllers.clear();
  mount.reviewControllers.clear();
  mount.queue = [];
  syncPreviewRuntime();
}
function assetUrl(sid: string, path: string) {
  const prefix = `/api/session-artifacts/${encodeURIComponent(sid)}/`;
  if (!path.startsWith(prefix)) throw new Error("Asset does not belong to this session");
  return path;
}
async function fetchAsset(mount: Mount, requestId: string, asset: ArtifactPreviewAsset, controller: AbortController) {
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, ASSET_REQUEST_TIMEOUT_MS);
  try {
    if (!mountIsCurrent(mount)) { disposeMount(mount); return; }
    controller.signal.throwIfAborted();
    const response = await fetch(assetUrl(mount.sessionId, asset.path), { headers: requestHeaders(), signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error("Asset unavailable");
    const actualType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (actualType !== asset.mediaType.toLowerCase()) throw new Error("Asset media type mismatch");
    const reader = response.body?.getReader(); if (!reader) throw new Error("Asset body unavailable");
    const chunks: Uint8Array[] = []; let total = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > asset.bytes || total > 128 * 1024 * 1024) { await reader.cancel(); throw new Error("Asset exceeds declared size"); } chunks.push(value); }
    if (total !== asset.bytes) throw new Error("Asset size mismatch");
    const buffer = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    if (asset.sha256 && !crypto.subtle) throw new Error("Audio integrity verification requires HTTPS or localhost.");
    if (asset.sha256) { const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))).map((b) => b.toString(16).padStart(2, "0")).join(""); if (digest !== asset.sha256.toLowerCase()) throw new Error("Asset integrity check failed"); }
    if (!mountIsCurrent(mount)) { disposeMount(mount); return; }
    controller.signal.throwIfAborted();
    if (mount.controllers.get(requestId) !== controller) return;
    post(mount, { type: "asset-result", requestId, ok: true, mediaType: asset.mediaType, buffer: buffer.buffer }, [buffer.buffer]);
  } catch (error) {
    if (!mountIsCurrent(mount)) disposeMount(mount);
    else if (mount.controllers.get(requestId) === controller) post(mount, { type: "asset-result", requestId, ok: false, error: timedOut ? "Asset request timed out" : error instanceof Error ? error.message : "Asset load failed" });
  } finally {
    clearTimeout(timeout);
    if (mount.controllers.get(requestId) === controller) mount.controllers.delete(requestId);
    mount.activeLoads--; mount.activeBytes -= asset.bytes; pumpAssetQueue(mount);
  }
}
function pumpAssetQueue(mount: Mount) {
  if (!mountIsCurrent(mount)) { disposeMount(mount); return; }
  while (!mount.disposed && mount.activeLoads < 6 && mount.queue.length) {
    const job = mount.queue[0];
    if (job.controller.signal.aborted) { mount.queue.shift(); continue; }
    if (mount.activeBytes + job.asset.bytes > 128 * 1024 * 1024) break;
    mount.queue.shift(); mount.activeLoads++; mount.activeBytes += job.asset.bytes;
    void fetchAsset(mount, job.requestId, job.asset, job.controller);
  }
}
function currentDraftMatches(snapshot: ComposerReviewSnapshot) {
  return sameComposerReviewSnapshot(snapshotDraft(), snapshot);
}
function validInteractionAction(mount: Mount, action: unknown) {
  const actions = Array.isArray(mount.descriptor.interaction?.actions) ? mount.descriptor.interaction.actions : [];
  return typeof action === "string" && /^[a-zA-Z0-9_.:-]{1,80}$/.test(action) && actions.includes(action);
}
export function validArtifactReviewPayload(payload: unknown) {
  if (payload === undefined) return true;
  const seen = new WeakSet<object>(); let nodes = 0; let stringBytes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 8 || ++nodes > 4_096) return false;
    if (typeof item === "string") { stringBytes += new TextEncoder().encode(item).byteLength; return stringBytes <= 32 * 1024; }
    if (!item || typeof item !== "object") return true;
    if (seen.has(item as object)) return false;
    seen.add(item as object);
    return Object.values(item).every((child) => visit(child, depth + 1));
  };
  if (!visit(payload, 0)) return false;
  let encoded: string;
  try { encoded = JSON.stringify(payload); } catch { return false; }
  return encoded !== undefined && new TextEncoder().encode(encoded).byteLength <= 32 * 1024;
}
function hasOnlyKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}
function validReviewContext(value: unknown): value is ComposerContextAttachment {
  if (!hasOnlyKeys(value, ["type", "id", "label", "title", "reference"]) || value.type !== "reference") return false;
  if (!hasOnlyKeys(value.reference, value.reference && (value.reference as any).provider === "artifact"
    ? ["provider", "path", "sha256", "snapshot", "ranges"]
    : ["provider", "repository", "resource", "number", "url"])) return false;
  const reference = value.reference;
  if (reference.provider === "github") return true;
  if (reference.provider !== "artifact") return false;
  if (reference.snapshot !== undefined && !hasOnlyKeys(reference.snapshot, ["label", "revision"])) return false;
  if (reference.ranges !== undefined && (!Array.isArray(reference.ranges) || !reference.ranges.every((range) => hasOnlyKeys(range, ["start", "end", "unit", "label"])))) return false;
  return true;
}
function parseReview(value: unknown): ReviewProposal | undefined {
  if (!hasOnlyKeys(value, ["title", "summary", "effects"])) return undefined;
  const review = value;
  const effects = Array.isArray(review.effects) ? review.effects : [];
  const text = effects[0] as Record<string, unknown> | undefined;
  const context = effects[1] as Record<string, unknown> | undefined;
  if (typeof review.title !== "string" || !review.title || review.title.length > 200 || (review.summary !== undefined && typeof review.summary !== "string") || effects.length !== 2) return undefined;
  if (!hasOnlyKeys(text, ["type", "text", "placement"]) || !hasOnlyKeys(context, ["type", "context"])) return undefined;
  if (text.type !== "insert-composer-text" || typeof text.text !== "string" || !text.text || text.text.length > 100_000) return undefined;
  const placement = text.placement === "end" ? "end" : undefined;
  if (!placement || context.type !== "add-composer-context" || !validReviewContext(context.context)) return undefined;
  return {
    title: review.title,
    ...(typeof review.summary === "string" && review.summary ? { summary: review.summary } : {}),
    effects: [
      { type: "insert-composer-text", text: text.text, placement },
      { type: "add-composer-context", context: context.context as ComposerContextAttachment },
    ],
  };
}
async function invokeReview(mount: Mount, action: string, payload: unknown, signal: AbortSignal): Promise<{ status: "review"; review: ReviewProposal } | ReviewOutcome> {
  const response = await fetch("/api/web-contributions/invoke", {
    method: "POST", headers: requestHeaders(), signal,
    body: JSON.stringify({
      sessionId: mount.sessionId, slot: "artifact-preview", key: mount.descriptor.key,
      event: { context: mount.artifact, registrationId: mount.descriptor.interaction?.registrationId, action, payload },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || response.statusText || "Preview review failed");
  if (data.status === "stale" || data.status === "unsupported") return { status: data.status, ...(typeof data.message === "string" ? { message: data.message } : {}) };
  const review = data.status === "review" ? parseReview(data.review) : undefined;
  if (!review) return { status: "unsupported", message: "The preview returned an unsupported review." };
  return { status: "review", review };
}
function proposalsEqual(left: ReviewProposal, right: ReviewProposal) { return JSON.stringify(left) === JSON.stringify(right); }
function reviewEffects(proposal: ReviewProposal): ComposerReviewEffects {
  return { text: proposal.effects[0], context: proposal.effects[1].context };
}
function confirmReview(mount: Mount, proposal: ReviewProposal, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "artifactReviewDialog";
    dialog.setAttribute("aria-labelledby", "artifactReviewTitle");
    const title = document.createElement("h2"); title.id = "artifactReviewTitle"; title.textContent = proposal.title;
    const summary = document.createElement("p"); summary.className = "artifactReviewSummary"; summary.textContent = proposal.summary || "Review this request before adding it to your chat draft.";
    const preview = document.createElement("pre"); preview.className = "artifactReviewText"; preview.textContent = proposal.effects[0].text;
    const note = document.createElement("p"); note.className = "artifactReviewNote"; note.textContent = "This adds text and a removable source reference. It will not send the message or edit the artifact.";
    const actions = document.createElement("div"); actions.className = "artifactReviewActions";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel";
    const add = document.createElement("button"); add.type = "button"; add.className = "primary"; add.textContent = "Add to chat";
    actions.append(cancel, add); dialog.append(title, summary, preview, note, actions);
    // Keep the host-owned top-layer dialog inside its owning preview subtree so
    // the preview interaction guard does not misclassify Review clicks as an
    // outside click and reactivate the shield after Cancel/Add.
    (mount.frame.parentElement || document.body).append(dialog);
    let accepted = false;
    const abort = () => dialog.open ? dialog.close() : undefined;
    signal.addEventListener("abort", abort, { once: true });
    cancel.addEventListener("click", () => dialog.close());
    add.addEventListener("click", () => { accepted = true; dialog.close(); });
    dialog.addEventListener("close", () => { signal.removeEventListener("abort", abort); dialog.remove(); resolve(accepted && !signal.aborted); }, { once: true });
    dialog.showModal(); add.focus();
  });
}
function postReviewOutcome(mount: Mount, requestId: string, outcome: ReviewOutcome) {
  post(mount, { type: "review-result", requestId, outcome });
}
async function handleReview(mount: Mount, requestId: string, action: string, payload: unknown) {
  if (!validInteractionAction(mount, action) || !validArtifactReviewPayload(payload)) return postReviewOutcome(mount, requestId, { status: "unsupported", message: "This review request is unavailable." });
  const globalPending = Array.from(mounts).reduce((count, item) => count + item.reviewControllers.size, 0);
  if (mount.reviewControllers.size || globalPending >= MAX_GLOBAL_REVIEWS) return postReviewOutcome(mount, requestId, { status: "unsupported", message: "Another review is already open." });
  const controller = new AbortController(); mount.reviewControllers.set(requestId, controller);
  const timeout = window.setTimeout(() => controller.abort(), REVIEW_REQUEST_TIMEOUT_MS);
  const draft = snapshotDraft();
  try {
    const first = await invokeReview(mount, action, payload, controller.signal);
    if (first.status !== "review") return postReviewOutcome(mount, requestId, first);
    if (!mountIsCurrent(mount) || !currentDraftMatches(draft)) return postReviewOutcome(mount, requestId, { status: "stale", message: "The preview or chat draft changed." });
    const accepted = await confirmReview(mount, first.review, controller.signal);
    if (!accepted) return postReviewOutcome(mount, requestId, { status: controller.signal.aborted ? "stale" : "cancelled" });
    if (!mountIsCurrent(mount) || !currentDraftMatches(draft)) return postReviewOutcome(mount, requestId, { status: "stale", message: "The preview or chat draft changed." });
    const second = await invokeReview(mount, action, payload, controller.signal);
    if (second.status !== "review" || !proposalsEqual(first.review, second.review)) return postReviewOutcome(mount, requestId, { status: "stale", message: "The source changed while it was being reviewed." });
    if (!mountIsCurrent(mount) || !currentDraftMatches(draft) || !applyReviewedEffects(draft, reviewEffects(second.review))) return postReviewOutcome(mount, requestId, { status: "stale", message: "The preview or chat draft changed." });
    postReviewOutcome(mount, requestId, { status: "added" });
  } catch {
    if (controller.signal.aborted || !mountIsCurrent(mount)) postReviewOutcome(mount, requestId, { status: "stale" });
    else postReviewOutcome(mount, requestId, { status: "unsupported", message: "Review unavailable." });
  } finally {
    clearTimeout(timeout); mount.reviewControllers.delete(requestId);
  }
}
function onMessage(event: MessageEvent) {
  const message = event.data as Record<string, unknown> | null; if (!message || typeof message !== "object") return;
  const mount = Array.from(mounts).find((m) => event.source === m.frame.contentWindow && message.piWebPreview === m.channel); if (!mount || mount.disposed) return;
  if (!mountIsCurrent(mount)) return disposeMount(mount);
  if (message.type === "ready") {
    post(mount, { type: "theme", theme: readArtifactPreviewTheme() });
    if (mount.lastViewport) post(mount, { type: "viewport", viewport: mount.lastViewport });
    else scheduleFreshViewportObservation(mount);
    return;
  }
  if (typeof message.requestId !== "string" || !/^\d{1,12}$/.test(message.requestId)) return;
  if (message.type === "review" && typeof message.action === "string") {
    void handleReview(mount, message.requestId, message.action, message.payload);
    return;
  }
  if (message.type === "cancel") {
    const controller = mount.controllers.get(message.requestId); if (!controller) return;
    const queued = mount.queue.some((job) => job.requestId === message.requestId);
    controller.abort(); mount.queue = mount.queue.filter((job) => job.requestId !== message.requestId);
    if (queued && mount.controllers.get(message.requestId) === controller) mount.controllers.delete(message.requestId);
    return;
  }
  if (message.type !== "load" || typeof message.id !== "string" || mount.controllers.size >= 32 || mount.controllers.has(message.requestId)) return;
  const asset = mount.assets.get(message.id); if (!asset) return post(mount, { type: "asset-result", requestId: message.requestId, ok: false, error: "Unknown asset" });
  const controller = new AbortController(); mount.controllers.set(message.requestId, controller); mount.queue.push({ requestId: message.requestId, asset, controller }); pumpAssetQueue(mount);
}

export async function mountArtifactPreview(host: HTMLElement, artifact: ArtifactContext, options: ArtifactPreviewMountOptions) {
  const descriptor = matchingArtifactPreview(artifact.name, artifact.kind); if (!descriptor) return false;
  const capturedSession = sessionId(); const { html, assets } = await renderArtifactPreview(descriptor, artifact);
  if (sessionId() !== capturedSession || !descriptorIsCurrent(descriptor) || (options.isCurrent && !options.isCurrent())) return true;
  const frame = document.createElement("iframe"); if (options.className) frame.className = options.className;
  const channel = randomChannel(); const mount: Mount = { frame, descriptor, artifact, sessionId: capturedSession, channel, assets: new Map(assets.map((a) => [a.id, a])), controllers: new Map(), reviewControllers: new Map(), queue: [], activeLoads: 0, activeBytes: 0, disposed: false, viewportCleanup: [] };
  frame.srcdoc = injectBootstrap(html, bootstrap(channel, assets, readArtifactPreviewTheme())); frame.title = options.title; frame.setAttribute("sandbox", "allow-scripts");
  for (const old of mounts) if (old.frame.parentElement === host) disposeMount(old);
  mounts.add(mount); syncPreviewRuntime(); host.replaceChildren(frame);
  attachViewportObservation(mount);
  queueMicrotask(() => { if (!frame.isConnected) disposeMount(mount); });
  return true;
}
