export const avatarPresetIds = ["current-pi", "fox", "bun", "hoodie", "robot", "cat", "deer", "wisp", "dragon"] as const;
export type AvatarPresetId = typeof avatarPresetIds[number];
export type AvatarSelection = { type: "preset"; id: AvatarPresetId } | { type: "custom"; assetId?: string; animated?: true };
export type AppIdentity = { name: string; shortName: string; avatar: AvatarSelection; revision: number };

export type AvatarMotion = { apng: string };
export type AvatarBundle = {
  still: string;
  fab: string;
  icon: string;
  fallback: string;
  newSession?: AvatarMotion;
};

export const defaultAppIdentity: AppIdentity = { name: "Pi Web", shortName: "Pi", avatar: { type: "preset", id: "current-pi" }, revision: 0 };
export const avatarPresetLabels: Record<AvatarPresetId, string> = {
  "current-pi": "Current Pi",
  fox: "Fox",
  bun: "Bun",
  hoodie: "Hoodie",
  robot: "Robot",
  cat: "Cat",
  deer: "Deer",
  wisp: "Wisp",
  dragon: "Dragon",
};

export const avatarPresets: Record<AvatarPresetId, AvatarBundle> = Object.fromEntries(avatarPresetIds.map(id => {
  const still = `/avatars/${id}/still.png`;
  const newSession: AvatarMotion = { apng: `/avatars/${id}/new-session.apng` };
  return [id, { still, fab: still, icon: `/avatars/${id}/icon.png`, fallback: still, newSession }];
})) as Record<AvatarPresetId, AvatarBundle>;

export function isAvatarPresetId(value: unknown): value is AvatarPresetId {
  return typeof value === "string" && avatarPresetIds.includes(value as AvatarPresetId);
}

export function resolveAvatarBundle(identity: AppIdentity): AvatarBundle {
  if (identity.avatar.type === "preset") return avatarPresets[identity.avatar.id];
  const url = `/identity/avatar.png?v=${identity.revision}`;
  return { still: url, fab: `/identity/fab.png?v=${identity.revision}`, icon: `/identity/icon.png?v=${identity.revision}`, fallback: avatarPresets["current-pi"].fallback, ...(identity.avatar.assetId && identity.avatar.animated ? { newSession: { apng: `/identity/new-session.apng?v=${identity.revision}` } } : {}) };
}

export const maxAvatarAnimationBytes = 8 * 1024 * 1024;
export const maxAvatarPackageBytes = 3 * Math.ceil((2 * 1024 * 1024) / 3) * 4 + Math.ceil(maxAvatarAnimationBytes / 3) * 4 + 4096;

export function isAvatarAssetId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export const maxAvatarZipBytes = 6 * 1024 * 1024 + maxAvatarAnimationBytes + 64 * 1024;
