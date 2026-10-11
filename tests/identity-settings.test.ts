import { describe, expect, it } from "vitest";
import { normalizeIdentity } from "../src/settings/identitySettings.js";
import { resolveAvatarBundle } from "../server/shared/appIdentity.js";

describe("identity settings normalization", () => {
  it("keeps server-owned custom asset references and separate static icon URLs", () => {
    const identity = normalizeIdentity({ name: " Workspace ", shortName: " Work ", avatar: { type: "custom", assetId: "891a5167-c29c-4eb3-b067-d97f499a8068" }, revision: 7 });
    expect(identity.avatar).toEqual({ type: "custom", assetId: "891a5167-c29c-4eb3-b067-d97f499a8068" });
    expect(resolveAvatarBundle(identity)).toMatchObject({ still: "/identity/avatar.png?v=7", icon: "/identity/icon.png?v=7" });
    expect(resolveAvatarBundle(identity).newSession).toBeUndefined();
  });
  it("preserves legacy custom selection without inventing an asset reference", () => {
    expect(normalizeIdentity({ avatar: { type: "custom" } }).avatar).toEqual({ type: "custom" });
  });
  it("does not preserve non-string custom references or unknown preset ids", () => {
    expect(normalizeIdentity({ avatar: { type: "custom", assetId: 3 } }).avatar).toEqual({ type: "custom" });
    expect(normalizeIdentity({ avatar: { type: "custom", assetId: "../../other-instance" } }).avatar).toEqual({ type: "custom" });
    expect(normalizeIdentity({ avatar: { type: "preset", id: "unknown" } }).avatar).toEqual({ type: "preset", id: "current-pi" });
  });
});
