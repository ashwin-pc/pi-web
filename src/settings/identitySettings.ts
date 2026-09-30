import { setAvatarMedia } from "../avatarMedia.js";
import type { ApiClient } from "../app/api.js";
import {
  avatarPresetIds,
  avatarPresetLabels,
  avatarPresets,
  defaultAppIdentity,
  isAvatarPresetId,
  resolveAvatarBundle,
  type AppIdentity,
  type AvatarSelection,
} from "../../server/shared/appIdentity.js";

export function normalizeIdentity(value: unknown): AppIdentity {
  if (!value || typeof value !== "object") return structuredClone(defaultAppIdentity);
  const raw = value as Partial<AppIdentity>;
  return {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 64) : defaultAppIdentity.name,
    shortName: typeof raw.shortName === "string" && raw.shortName.trim() ? raw.shortName.trim().slice(0, 24) : defaultAppIdentity.shortName,
    avatar: raw.avatar?.type === "custom"
      ? { type: "custom" }
      : raw.avatar?.type === "preset" && isAvatarPresetId(raw.avatar.id)
        ? { type: "preset", id: raw.avatar.id }
        : defaultAppIdentity.avatar,
    revision: typeof raw.revision === "number" && Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
  };
}

export function applyIdentity(identity: AppIdentity) {
  const bundle = resolveAvatarBundle(identity);
  document.title = identity.name;
  document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]')?.setAttribute("content", identity.shortName);
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]')) {
    link.href = `/identity/icon.png?v=${identity.revision}`;
  }

  const media = document.querySelector<HTMLElement>("#identityNewSessionMedia");
  if (media) setAvatarMedia(media, bundle);

  const fab = document.querySelector<HTMLImageElement>(".actionLauncherToggle img");
  if (fab) fab.src = bundle.fab;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function normalizedAvatar(file: File): Promise<Blob> {
  let source: CanvasImageSource;
  let width: number;
  let height: number;
  let cleanup: () => void = () => {};
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
    cleanup = () => bitmap.close();
  } else {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.src = url;
    await image.decode();
    source = image;
    width = image.naturalWidth;
    height = image.naturalHeight;
    cleanup = () => URL.revokeObjectURL(url);
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 512;
    const side = Math.min(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable");
    context.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, 512, 512);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      value => value ? resolve(value) : reject(new Error("Could not process image")),
      "image/png",
    ));
  } finally {
    cleanup();
  }
}

export function createIdentitySettings(
  panel: HTMLElement,
  api: ApiClient,
  onSettings: (settings: unknown) => void,
  onError: (message: string) => void,
) {
  const root = panel.querySelector<HTMLElement>("#settingsPageIdentity")!;
  const name = root.querySelector<HTMLInputElement>("#identityName")!;
  const shortName = root.querySelector<HTMLInputElement>("#identityShortName")!;
  const gallery = root.querySelector<HTMLElement>("#identityGallery")!;
  const upload = root.querySelector<HTMLInputElement>("#identityUpload")!;
  const preview = root.querySelector<HTMLElement>("#identityPreview")!;
  const save = root.querySelector<HTMLButtonElement>("#identitySave")!;
  const reset = root.querySelector<HTMLButtonElement>("#identityReset")!;
  let saved = structuredClone(defaultAppIdentity);
  let selected: AvatarSelection = saved.avatar;
  let mode: "home" | "new" = "home";
  let busy = false;
  let processingUpload = false;
  let dirtyName = false;
  let dirtyShortName = false;
  let dirtyAvatar = false;
  let pendingAction: "save" | "reset" | "upload" | undefined;

  function previewIdentity(): AppIdentity {
    return {
      ...saved,
      name: name.value.trim() || saved.name,
      shortName: shortName.value.trim() || saved.shortName,
      avatar: selected,
    };
  }

  function renderPreview(identity: AppIdentity) {
    const bundle = resolveAvatarBundle(identity);
    preview.replaceChildren();
    preview.className = `identityPreview identityPreview--${mode}`;

    if (mode === "home") {
      const phone = el("div", "identityPhone");
      const status = el("div", "identityPhoneStatus");
      status.append(el("span", "", "9:41"), el("span", "", "••• ▰"));
      const apps = el("div", "identityPhoneApps");
      const app = el("div", "identityPhoneApp");
      const icon = el("img", "identityPhoneIcon identitySpring");
      icon.src = bundle.icon;
      icon.alt = "";
      app.append(icon, el("span", "", identity.shortName));
      apps.append(app, el("span", "identityPhonePlaceholder"), el("span", "identityPhonePlaceholder"));
      const dock = el("div", "identityPhoneDock");
      dock.append(el("span"), el("span"), el("span"));
      phone.append(status, apps, dock);
      preview.append(phone);
      return;
    }

    const shell = el("div", "identitySessionShell");
    const top = el("div", "identitySessionTop");
    top.append(el("span", "identitySessionDot"), el("span", "", identity.shortName), el("span", "identitySessionTitle", "New session"));
    const empty = el("div", "identitySessionEmpty");
    const avatar = el("div", "identitySessionAvatar");
    setAvatarMedia(avatar, bundle);
    empty.append(avatar, el("span", "identitySessionDirectory", "▰ ~/projects/pi-web⌄"));
    const composer = el("div", "identityComposerPreview");
    composer.append(el("span", "", "Message pi…"));
    const fab = el("img", "identityPreviewFab identitySpring");
    fab.src = bundle.fab;
    fab.alt = "";
    composer.append(fab);
    shell.append(top, empty, composer);
    preview.append(shell);
  }

  function render() {
    const identity = previewIdentity();
    const selectedId = selected.type === "custom" ? "custom" : selected.id;
    for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-avatar]")) {
      button.setAttribute("aria-pressed", String(button.dataset.avatar === selectedId));
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-identity-preview]")) {
      const active = button.dataset.identityPreview === mode;
      button.setAttribute("aria-selected", String(active));
      button.setAttribute("aria-pressed", String(active));
    }
    renderPreview(identity);
  }

  // Hidden Settings never request the full animation gallery. Intersection
  // observation starts media only when each choice actually enters view.
  const galleryObserver = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const image = entry.target.querySelector<HTMLElement>(".identityChoiceImage");
      const id = (entry.target as HTMLElement).dataset.avatar;
      if (image && id && isAvatarPresetId(id)) setAvatarMedia(image, avatarPresets[id]);
      galleryObserver?.unobserve(entry.target);
    }
  });
  for (const id of avatarPresetIds) {
    const button = el("button", "identityChoice");
    button.type = "button";
    button.dataset.avatar = id;
    button.setAttribute("aria-label", avatarPresetLabels[id]);
    const img = el("div", "identityChoiceImage");
    const still = el("img");
    still.src = avatarPresets[id].still;
    still.alt = "";
    still.loading = "lazy";
    img.append(still);
    button.append(img, el("span", "identityChoiceLabel", avatarPresetLabels[id]));
    button.addEventListener("click", () => {
      selected = { type: "preset", id };
      dirtyAvatar = true;
      render();
    });
    gallery.append(button);
    galleryObserver?.observe(button);
  }

  const custom = el("button", "identityChoice identityChoiceCustom");
  custom.type = "button";
  custom.dataset.avatar = "custom";
  custom.setAttribute("aria-label", "Upload custom avatar");
  custom.append(el("span", "identityChoiceCustomIcon", "+"), el("span", "identityChoiceLabel", "Custom"));
  custom.addEventListener("click", () => upload.click());
  gallery.after(custom);

  function update(identity: AppIdentity) {
    saved = identity;
    if (pendingAction === "save" || pendingAction === "reset") {
      dirtyName = dirtyShortName = dirtyAvatar = false;
    }
    if (pendingAction === "upload") {
      selected = { type: "custom" };
      dirtyAvatar = true;
    } else if (!dirtyAvatar) selected = identity.avatar;
    if (!dirtyName) name.value = identity.name;
    if (!dirtyShortName) shortName.value = identity.shortName;
    pendingAction = undefined;
    render();
    applyIdentity(identity);
  }

  root.querySelectorAll<HTMLButtonElement>("[data-identity-preview]").forEach(button => button.addEventListener("click", () => {
    mode = button.dataset.identityPreview as typeof mode;
    render();
  }));
  name.addEventListener("input", () => { dirtyName = true; render(); });
  shortName.addEventListener("input", () => { dirtyShortName = true; render(); });

  async function request(method: "POST" | "PATCH", url: string, body: BodyInit, contentType?: string, action?: "save" | "reset" | "upload") {
    if (busy) { onError("Wait for the current identity update to finish."); return; }
    busy = true;
    save.disabled = reset.disabled = upload.disabled = true;
    try {
      const headers = api.headers();
      if (contentType) headers["content-type"] = contentType;
      const response = await fetch(url, { method, headers, body });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
      pendingAction = action;
      onSettings(data.settings);
    } catch (error) {
      pendingAction = undefined;
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      save.disabled = reset.disabled = upload.disabled = processingUpload;
    }
  }

  save.addEventListener("click", () => {
    if (!name.value.trim() || !shortName.value.trim()) {
      onError("App name and short name are required");
      return;
    }
    void request("PATCH", "/api/settings", JSON.stringify({
      identity: { name: name.value.trim(), shortName: shortName.value.trim(), avatar: selected },
    }), undefined, "save");
  });
  reset.addEventListener("click", () => void request("PATCH", "/api/settings", JSON.stringify({
    identity: { name: defaultAppIdentity.name, shortName: defaultAppIdentity.shortName, avatar: defaultAppIdentity.avatar },
  }), undefined, "reset"));

  upload.addEventListener("change", async () => {
    const file = upload.files?.[0];
    upload.value = "";
    if (!file) return;
    if (busy || processingUpload) { onError("Wait for the current identity update to finish."); return; }
    if (file.size > 5 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      onError("Choose a PNG, JPEG, or WebP image under 5 MB");
      return;
    }
    processingUpload = true;
    save.disabled = reset.disabled = upload.disabled = true;
    try {
      const blob = await normalizedAvatar(file);
      await request("POST", "/api/identity/avatar", blob, "image/png", "upload");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      processingUpload = false;
      save.disabled = reset.disabled = upload.disabled = busy;
    }
  });

  return { update };
}
