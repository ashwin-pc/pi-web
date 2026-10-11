# Portable custom avatars

In **Settings → Identity**, upload a PNG as before, or import a `.pi-avatar.zip` package (legacy `.pi-avatar.json` imports also work). Export the saved custom avatar to download a self-contained file that another pi-web instance can import. Packages contain a new-session fallback still and PWA/favicon icon, with an optional separate launcher/FAB image; custom avatars may include an optional transparent single-play new-session APNG. A label describes the artwork and never changes the application name.

## Version 1 ZIP format

A ZIP contains three required regular files: `manifest.json`, `still.png`, and `icon.png`, plus optional `fab.png` and `new-session.apng`. `fab.png` overrides only the floating action launcher image; without it, the launcher uses `still.png`. Thus full-body arrival artwork and cropped-head launcher/icon artwork can coexist without adding a personal preset. The manifest is UTF-8 JSON with `{ "format": "pi-web-avatar", "version": 1, "label": "Bleckbeard" }`; label is optional. The two PNG files are the fixed roles, not base64 or arbitrary manifest paths. ZIPs are limited to 14 MiB + 64 KiB compressed, with at most 14 MiB + 4 KiB actually inflated; each PNG is at most 2 MiB and the manifest at most 4 KiB. Only stored/deflated entries are supported. Entry CRCs and actual stream sizes are verified. Missing or duplicate files, unknown entries, traversal, directories, symlinks, encryption, archive/entry comments and unsupported compression are rejected. Nothing is extracted using archive paths. The optional APNG must be non-interlaced 8-bit RGBA, at most 512×512, 8 MiB, 240 frames and 15 seconds, with `acTL.num_plays = 1`. Every frame's chunk CRC, sequence, rectangle, decoded size and filters are checked. Separate default posters and optional well-formed suggested `PLTE` palettes are supported. Use transparent artwork; RGBA alpha is preserved without normalization. Motion uses the existing preset playback/fallback and reduced-motion behavior. Artwork fetched online is cached on demand for offline use.

Use `serializeAvatarZip({still,fab,icon,newSession,label})` from `server/appIdentity.ts` to build a validated ZIP, and `parseAvatarZip(bytes)` to inspect one.

## Legacy version 1 JSON format

```json
{
  "format": "pi-web-avatar",
  "version": 1,
  "assets": {
    "still": { "mediaType": "image/png", "base64": "..." },
    "icon": { "mediaType": "image/png", "base64": "..." }
  },
  "label": "Bleckbeard"
}
```

Both roles are required: canonical base64, static RGB/RGBA PNG with width and height each between 1 and 2048 pixels (512×512 recommended), at most 2 MiB decoded per image. PNG CRCs, chunk framing, decompressed size and row filters are checked; APNG is rejected. Optional `assets.fab` uses `{ "mediaType": "image/png", "base64": "..." }` with the same static PNG validation and 2 MiB limit. The optional `assets.newSession` role uses `{ "mediaType": "image/apng", "base64": "..." }` and the APNG limits above. No paths, URLs, other roles, SVG or HTML are accepted. The optional label is trimmed plaintext, at most 80 characters, without control characters or angle brackets. Unknown fields and versions are rejected. The JSON request bound includes canonical base64 for three 2 MiB PNGs and one 8 MiB APNG, plus 4 KiB metadata.

Authenticated `POST /api/identity/avatar/package` accepts `application/zip`, `application/json` or `application/vnd.pi-web-avatar+json` and returns `{ok:true,settings}`. Authenticated `GET` at the same endpoint exports the selected custom artwork as an `application/zip` attachment named `custom-avatar.pi-avatar.zip`. Add `?format=json` to request the legacy JSON attachment; unknown formats return HTTP 400. Export fails if custom artwork is unavailable or fails PNG validation. Public image endpoints do not expose package exports.

For programmatic packaging use `serializeAvatarPackage({still,fab,icon,newSession,label})` from `server/appIdentity.ts`; the buffers are validated using the same import schema.

## Storage and compatibility

Imports and ordinary PNG uploads use the same immutable generation storage. An import receives a new server-generated UUID; no imported identifier is trusted. Storage is scoped by a hash of the exact resolved settings file path, including its filename: `<settings-parent>/pi-web-avatars/<sha256(resolved-settings-path)>/<uuid>/`, containing `still.png`, `icon.png`, optional `fab.png`, optional `new-session.apng` and optional `label.json`. Do not edit generations directly; import a new package. The saved custom selection records `assetId` and `animated: true` only for animated packages. Public `/identity/new-session.apng?v=<identity-revision>` serves the selected animation; legacy/static selections advertise no motion. Public `/identity/fab.png?v=<identity-revision>` serves the separate FAB or the still when absent. JSON/ZIP exports preserve absence of optional roles instead of synthesizing duplicate assets. All role files are written before the atomic settings pointer update; failed settings persistence removes only the uncommitted generation. Identity mutations are serialized. Successful imports retain only the selected generation and one previous generation for in-flight readers, reclaiming older generations. Settings saves reject references to reclaimed generations. Versioned custom artwork is cached separately with an eight-entry bound; unversioned favicon and notification URLs always use the network rather than cache-first. Public images resolve the saved generation after restart; missing selected artwork falls back to the default preset.

Existing `pi-web-avatar.png` uploads remain readable when a custom selection has no generation pointer. Reset does not remove this potentially shared legacy file; the UI confirmation explicitly states that retention. To remove legacy artwork permanently, first back up the file and verify that no instance whose settings share that parent directory still selects a legacy custom avatar (a custom selection without `assetId`), then manually remove `<settings-parent>/pi-web-avatar.png`. Removing it affects every legacy instance sharing that directory. New uploads use isolated storage. Original PNG uploads remain supported (up to 2 MiB, dimensions 1–2048); Settings normalizes uploaded images to 512×512.

Instances without this package feature do not understand ZIP or JSON avatar packages. Keep a standalone still PNG as a fallback and upload it normally there; that route uses the same artwork for the icon and cannot preserve a distinct package icon.
