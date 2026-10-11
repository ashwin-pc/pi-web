import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

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
