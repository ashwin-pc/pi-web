export const avatarPresetIds = ["current-pi", "fox", "bun", "hoodie", "robot", "cat", "deer", "wisp", "dragon"] as const;
export type AvatarPresetId = typeof avatarPresetIds[number];
export type AvatarSelection = { type: "preset"; id: AvatarPresetId } | { type: "custom" };
export type AppIdentity = { name: string; shortName: string; avatar: AvatarSelection; revision: number };

export type AvatarMotion = {
  sources: Array<{ src: string; type: string }>;
  apng: string;
};
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
  const newSession: AvatarMotion = {
    sources: [{ src: `/avatars/${id}/new-session.webm`, type: 'video/webm; codecs="vp9"' }],
    apng: `/avatars/${id}/new-session.apng`,
  };
  return [id, { still, fab: still, icon: `/avatars/${id}/icon.png`, fallback: still, newSession }];
})) as Record<AvatarPresetId, AvatarBundle>;

export function isAvatarPresetId(value: unknown): value is AvatarPresetId {
  return typeof value === "string" && avatarPresetIds.includes(value as AvatarPresetId);
}

export function resolveAvatarBundle(identity: AppIdentity): AvatarBundle {
  if (identity.avatar.type === "preset") return avatarPresets[identity.avatar.id];
  const url = `/identity/avatar.png?v=${identity.revision}`;
  return { still: url, fab: url, icon: url, fallback: avatarPresets["current-pi"].fallback };
}
