import type { AuthMode } from "./kernel.js";

export type AccessPolicy = "open" | "authenticated";
export type HumanAuthMethod = "passkey" | "password" | "external";
export type AuthConfig = {
  policy: AccessPolicy;
  methods: HumanAuthMethod[];
  mode: AuthMode;
  trustedHeader: string;
};

const methods = new Set<HumanAuthMethod>([
  "passkey",
  "password",
  "external",
]);

export const legacyAuthMigration =
  "Legacy token authentication has been removed. Unset PI_WEB_TOKEN, remove legacy from PI_WEB_AUTH_MODE/PI_WEB_AUTH_METHODS, then run `pi-web auth recover` to create a one-time password/passkey setup URL.";

/** One translation boundary keeps supported PI_WEB_AUTH_MODE presets compatible. */
export function resolveAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  if (env.PI_WEB_TOKEN)
    throw new Error(legacyAuthMigration);
  const explicitPolicy = env.PI_WEB_AUTH_POLICY;
  if (
    explicitPolicy &&
    explicitPolicy !== "open" &&
    explicitPolicy !== "authenticated"
  )
    throw new Error(`Invalid PI_WEB_AUTH_POLICY: ${explicitPolicy}`);
  if (env.PI_WEB_AUTH_MODE === "legacy")
    throw new Error(legacyAuthMigration);
  const mode = (env.PI_WEB_AUTH_MODE || "") as AuthMode | "";
  if (mode && !["none", "passkey", "external"].includes(mode))
    throw new Error(`Invalid PI_WEB_AUTH_MODE: ${mode}`);
  const configured =
    env.PI_WEB_AUTH_METHODS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) || [];
  for (const method of configured) {
    if (method === "legacy") {
      throw new Error(legacyAuthMigration);
    }
    if (!methods.has(method as HumanAuthMethod)) {
      throw new Error(`Invalid PI_WEB_AUTH_METHODS entry: ${method}`);
    }
  }
  const translated: HumanAuthMethod[] =
    mode === "passkey" || mode === "external" ? [mode] : [];
  return {
    policy:
      (explicitPolicy as AccessPolicy | undefined) ||
      (mode === "none" ? "open" : "authenticated"),
    methods: [
      ...new Set(
        (configured.length ? configured : translated) as HumanAuthMethod[],
      ),
    ],
    mode: mode || "passkey",
    trustedHeader: env.PI_WEB_AUTH_TRUSTED_HEADER || "",
  };
}
