import { randomUUID } from "node:crypto";
import { AuthStore, hashSecret, randomSecret } from "../server/auth/kernel.js";

export async function mintStoredApiToken(store: AuthStore, name = "test") {
  const secret = `piw_${randomSecret()}`;
  const id = randomUUID();
  await store.update((state) => {
    state.config ||= { policy: "authenticated", methods: [] };
    state.apiTokens.push({
      id,
      name,
      hash: hashSecret(secret),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
  });
  return { id, secret };
}
