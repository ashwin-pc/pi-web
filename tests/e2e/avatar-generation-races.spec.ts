import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";

test("concurrent package export and reset never omit selected optional roles", async ({ request }, info) => {
  test.skip(info.project.name !== "desktop", "Portable package snapshot serialization");
  const asset = async (path: string, mediaType = "image/png") => ({ mediaType, base64: (await readFile(path)).toString("base64") });
  const data = { format: "pi-web-avatar", version: 1, label: "Concurrency sample", assets: {
    still: await asset("public/avatars/fox/still.png"), icon: await asset("public/avatars/fox/icon.png"),
    fab: await asset("public/avatars/cat/still.png"), newSession: await asset("public/avatars/fox/new-session.apng", "image/apng"),
  } };
  for (const format of ["zip", "json"]) {
    expect((await request.post("/api/identity/avatar/package", { data })).ok()).toBe(true);
    const exported = request.get(`/api/identity/avatar/package?format=${format}`);
    const reset = request.patch("/api/settings", { data: { identity: { avatar: { type: "preset", id: "current-pi" } } } }).then(async response => {
      expect(response.ok()).toBe(true);
      const revision = (await response.json()).settings.identity.revision;
      expect((await request.delete(`/api/identity/avatar?revision=${revision}`)).ok()).toBe(true);
    });
    const response = await exported;
    await reset;
    // Either the entire snapshot won the lock, or reset won and no custom
    // selection existed. Success may never silently omit optional roles.
    expect([200, 404]).toContain(response.status());
    if (response.ok()) {
      if (format === "json") expect(await response.json()).toEqual(data);
      else {
        const files = unzipSync(await response.body());
        expect(JSON.parse(Buffer.from(files["manifest.json"]).toString()).label).toBe(data.label);
        expect(Buffer.from(files["fab.png"])).toEqual(Buffer.from(data.assets.fab.base64, "base64"));
        expect(Buffer.from(files["new-session.apng"])).toEqual(Buffer.from(data.assets.newSession.base64, "base64"));
      }
    }
  }
});

test("a stale settings form cannot select a reclaimed avatar generation", async ({ request }, info) => {
  test.skip(info.project.name !== "desktop", "Serialized generation reference validation");
  const png = (await readFile("public/avatars/fox/still.png")).toString("base64");
  const data = { format: "pi-web-avatar", version: 1, assets: { still: { mediaType: "image/png", base64: png }, icon: { mediaType: "image/png", base64: png } } };
  const upload = async () => {
    const response = await request.post("/api/identity/avatar/package", { data });
    expect(response.ok()).toBe(true);
    return (await response.json()).settings.identity;
  };
  const stale = await upload();
  await upload();
  const latest = await upload();
  const rejected = await request.patch("/api/settings", { data: { identity: { name: "Stale draft", avatar: stale.avatar } } });
  expect(rejected.status()).toBe(400);
  expect(await rejected.json()).toMatchObject({ error: expect.stringContaining("import it again") });
  expect((await (await request.get("/api/settings")).json()).settings.identity).toEqual(latest);
  expect((await request.get("/identity/avatar.png")).ok()).toBe(true);
});
