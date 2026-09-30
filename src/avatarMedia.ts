import type { AvatarBundle } from "../server/shared/appIdentity.js";

/** APNG preserves alpha consistently across Safari, Chromium and Firefox.
 * VP9 alpha remains in the bundle for consumers with verified decoder support,
 * but a codec-supported WebM can still be composited as opaque by a browser. */
export function setAvatarMedia(host: HTMLElement, bundle: AvatarBundle): HTMLImageElement | null {
  const existing = host.querySelector<HTMLImageElement>(".avatarMediaVideo");
  const existingStill = host.querySelector<HTMLImageElement>(".avatarMediaStill");
  const motion = !!bundle.newSession && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (existingStill?.getAttribute("src") === bundle.still &&
      (motion ? (existing?.dataset.canonicalUrl || existing?.getAttribute("src")) === bundle.newSession?.apng : !existing)) return existing;
  host.classList.add("avatarMedia");
  host.classList.remove("avatarMediaPlaying");
  host.replaceChildren();
  const still = document.createElement("img");
  still.className = "avatarMediaStill";
  if (host.id === "identityNewSessionMedia") still.id = "identityNewSessionStill";
  still.src = bundle.still;
  still.alt = "";
  host.append(still);
  if (!motion || !bundle.newSession) return null;
  const viewport = document.createElement("div");
  viewport.className = "avatarMediaViewport";
  const animation = document.createElement("img");
  animation.className = "avatarMediaVideo";
  if (host.id === "identityNewSessionMedia") animation.id = "identityNewSessionAnimation";
  animation.alt = "";
  animation.addEventListener("load", () => host.classList.add("avatarMediaPlaying"));
  animation.addEventListener("error", () => host.classList.remove("avatarMediaPlaying"));
  animation.dataset.canonicalUrl = bundle.newSession.apng;
  animation.src = bundle.newSession.apng;
  viewport.append(animation);
  host.append(viewport);
  return animation;
}
