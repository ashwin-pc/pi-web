import type { AvatarBundle } from "./appIdentity.js";

/** APNG preserves alpha consistently across Safari, Chromium and Firefox.
 * VP9 alpha remains in the bundle for consumers with verified decoder support,
 * but a codec-supported WebM can still be composited as opaque by a browser. */
export function setAvatarMedia(host: HTMLElement, bundle: AvatarBundle): HTMLImageElement | null {
  host.classList.add("avatarMedia");
  host.classList.remove("avatarMediaPlaying");
  host.replaceChildren();
  const still = document.createElement("img");
  still.className = "avatarMediaStill";
  if (host.id === "identityNewSessionMedia") still.id = "identityNewSessionStill";
  still.src = bundle.still;
  still.alt = "";
  host.append(still);
  if (!bundle.newSession || matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const viewport = document.createElement("div");
  viewport.className = "avatarMediaViewport";
  const animation = document.createElement("img");
  animation.className = "avatarMediaVideo";
  if (host.id === "identityNewSessionMedia") animation.id = "identityNewSessionAnimation";
  animation.alt = "";
  animation.addEventListener("load", () => host.classList.add("avatarMediaPlaying"));
  animation.addEventListener("error", () => host.classList.remove("avatarMediaPlaying"));
  animation.src = bundle.newSession.apng;
  viewport.append(animation);
  host.append(viewport);
  return animation;
}
