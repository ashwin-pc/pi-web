import type { AuthMode } from "./kernel.js";

export type AccessPolicy = "open" | "authenticated";
export type HumanAuthMethod = "passkey" | "password" | "legacy" | "external";
export type AuthConfig = {
  policy: AccessPolicy;
  methods: HumanAuthMethod[];
  legacyMode: AuthMode;
  trustedHeader: string;
};

const methods = new Set<HumanAuthMethod>([
  "passkey",
  "password",
  "legacy",
  "external",
]);

/** One translation boundary keeps PI_WEB_AUTH_MODE compatible without maintaining mode-specific gates. */
export function resolveAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const explicitPolicy = env.PI_WEB_AUTH_POLICY;
  if (
    explicitPolicy &&
    explicitPolicy !== "open" &&
    explicitPolicy !== "authenticated"
  )
    throw new Error(`Invalid PI_WEB_AUTH_POLICY: ${explicitPolicy}`);
  const mode = (env.PI_WEB_AUTH_MODE || "legacy") as AuthMode;
  if (!["none", "legacy", "passkey", "external"].includes(mode))
    throw new Error(`Invalid PI_WEB_AUTH_MODE: ${mode}`);
  const configured =
    env.PI_WEB_AUTH_METHODS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) || [];
  for (const method of configured)
    if (!methods.has(method as HumanAuthMethod))
      throw new Error(`Invalid PI_WEB_AUTH_METHODS entry: ${method}`);
  const translated: HumanAuthMethod[] = mode === "none" ? [] : [mode];
  return {
    policy:
      (explicitPolicy as AccessPolicy | undefined) ||
      (mode === "none" ? "open" : "authenticated"),
    methods: [
      ...new Set(
        (configured.length ? configured : translated) as HumanAuthMethod[],
      ),
    ],
    legacyMode: mode,
    trustedHeader: env.PI_WEB_AUTH_TRUSTED_HEADER || "",
  };
}
