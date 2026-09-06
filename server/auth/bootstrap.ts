import { hashSecret, randomSecret, type AuthKernel } from "./kernel.js";

/** Only terminal possession can claim an unconfigured instance. Never grant setup to a visitor. */
export async function initializeAuth(
  kernel: AuthKernel,
  origin: string,
  explicitlyConfigured: boolean,
): Promise<string | undefined> {
  await kernel.refreshConfig();
  const state = await kernel.store.read();
  if (
    explicitlyConfigured ||
    state.config ||
    kernel.legacyToken ||
    state.password ||
    state.credentials.length ||
    state.sessions.length ||
    state.apiTokens.length
  )
    return;
  const token = randomSecret();
  await kernel.store.update((s) => {
    s.config = { policy: "authenticated", methods: ["passkey", "password"] };
    s.bootstrap = { hash: hashSecret(token), expiresAt: Date.now() + 600_000 };
  });
  await kernel.refreshConfig();
  const url = new URL("/api/auth/bootstrap", origin);
  url.searchParams.set("token", token);
  return url.href;
}
