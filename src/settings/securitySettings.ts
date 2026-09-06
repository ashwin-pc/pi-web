import type { ApiClient } from "../app/api.js";
import { createQrSvg } from "../token/qr.js";

export type AuthMode = "none" | "legacy" | "passkey" | "external";
type Identity = { id: string; displayName?: string };
type SecurityState = {
  mode: AuthMode;
  policy?: "open" | "authenticated";
  methods?: Array<"passkey" | "password" | "legacy" | "external">;
  passwordConfigured?: boolean;
  verifiedMethods?: string[];
  externalAvailable?: boolean;
  identity: Identity;
  passkeys: Array<{ id: string; name: string; createdAt: number }>;
  sessions: Array<{
    id: string;
    identity: Identity;
    method?: string;
    device?: string;
    ip?: string;
    createdAt: number;
    lastSeenAt: number;
    expiresAt: number;
    current: boolean;
  }>;
  apiTokens: Array<{
    id: string;
    name: string;
    createdAt: number;
    expiresAt: number;
  }>;
  deviceGrants: Array<{
    id: string;
    createdAt: number;
    expiresAt: number;
    createdBy: Identity;
  }>;
};

type Options = {
  container: HTMLElement;
  api: ApiClient;
  setStatus: (message: string, error?: boolean) => void;
};
const decode = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
type RegistrationOptions = Omit<
  PublicKeyCredentialCreationOptions,
  "challenge" | "user" | "excludeCredentials"
> & {
  challenge: string;
  user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
  excludeCredentials?: Array<
    Omit<PublicKeyCredentialDescriptor, "id"> & { id: string }
  >;
};
const encode = (value: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function createSecuritySettings({ container, api, setStatus }: Options) {
  let current: SecurityState | undefined;
  async function request<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { ...api.headers(), ...(init.headers || {}) },
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(value.error || `Request failed (${response.status})`);
    return value as T;
  }
  function button(label: string, action: () => Promise<void>, danger = false) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    if (danger) element.className = "danger";
    element.addEventListener("click", () => {
      element.disabled = true;
      action()
        .catch((e) =>
          setStatus(e instanceof Error ? e.message : String(e), true),
        )
        .finally(() => {
          element.disabled = false;
        });
    });
    return element;
  }
  function section(title: string, hint?: string) {
    const el = document.createElement("section");
    el.className = "settingsSection securitySection";
    const h = document.createElement("h4");
    h.textContent = title;
    el.append(h);
    if (hint) {
      const p = document.createElement("p");
      p.className = "settingsHint";
      p.textContent = hint;
      el.append(p);
    }
    return el;
  }
  function row(title: string, detail: string, action?: HTMLElement) {
    const el = document.createElement("div");
    el.className = "securityRow";
    const copy = document.createElement("div"),
      strong = document.createElement("strong"),
      small = document.createElement("small");
    strong.textContent = title;
    small.textContent = detail;
    copy.append(strong, small);
    el.append(copy);
    if (action) el.append(action);
    return el;
  }
  function date(value: number) {
    return new Date(value).toLocaleString();
  }

  function render(state: SecurityState) {
    current = state;
    container.replaceChildren();
    const modeHints: Record<AuthMode, string> = {
      legacy:
        "Legacy token login is deprecated. Add and verify a replacement below before retiring it.",
      passkey: "Keep a backup credential and terminal recovery access.",
      external:
        "Only trust a proxy that strips caller-supplied identity headers. Direct access to the backend must be blocked.",
      none: "Warning: this instance has no authentication.",
    };
    const mode = section("Authentication mode", modeHints[state.mode]);
    mode.dataset.mode = state.mode;
    mode.append(
      row(state.mode, state.identity.displayName || state.identity.id),
    );
    if (state.policy) mode.append(row("Access policy", state.policy));
    container.append(mode);

    const enabled = new Set(
      state.methods || (state.mode === "none" ? [] : [state.mode]),
    );
    if (state.mode !== "none") {
      const methods = section(
        "Sign-in methods",
        "Legacy is deprecated. Enroll and test a replacement in another browser before disabling it. Existing sessions remain valid until revoked.",
      );
      for (const method of [
        "passkey",
        "password",
        "legacy",
        "external",
      ] as const) {
        const checked = enabled.has(method);
        methods.append(
          row(
            method,
            `${checked ? "Enabled" : "Disabled"}${state.verifiedMethods?.includes(method) ? " · Verified login" : " · Not yet verified"}`,
            button(checked ? "Disable" : "Enable", async () => {
              const next = new Set(enabled);
              if (checked) next.delete(method);
              else next.add(method);
              await request("/api/auth/methods", {
                method: "PUT",
                body: JSON.stringify({ methods: [...next] }),
              });
              await refresh();
            }),
          ),
        );
      }
      container.append(methods);
    }
    if (state.mode !== "none") {
      const keys = section(
        "Passkeys",
        "Adding a passkey requires this authenticated browser session. Revoking any passkey signs out all devices.",
      );
      for (const key of state.passkeys)
        keys.append(
          row(
            key.name,
            `Added ${date(key.createdAt)}`,
            button(
              "Revoke",
              async () => {
                if (!confirm(`Revoke ${key.name} and sign out all devices?`))
                  return;
                await request(
                  `/api/auth/passkeys/${encodeURIComponent(key.id)}`,
                  { method: "DELETE" },
                );
                location.reload();
              },
              true,
            ),
          ),
        );
      const name = document.createElement("input");
      name.placeholder = "Passkey name";
      name.value = "Passkey";
      keys.append(
        name,
        button("Add passkey", async () => {
          const json = await request<RegistrationOptions>(
            "/api/auth/passkeys/options",
            { method: "POST", body: JSON.stringify({ name: name.value }) },
          );
          const options: PublicKeyCredentialCreationOptions = {
            ...json,
            challenge: decode(json.challenge),
            user: { ...json.user, id: decode(json.user.id) },
            excludeCredentials: json.excludeCredentials?.map((item) => ({
              ...item,
              id: decode(item.id),
            })),
          };
          const credential = (await navigator.credentials.create({
            publicKey: options,
          })) as PublicKeyCredential | null;
          if (!credential) throw new Error("Passkey creation cancelled");
          const response =
            credential.response as AuthenticatorAttestationResponse;
          await request("/api/auth/passkeys/verify", {
            method: "POST",
            body: JSON.stringify({
              response: {
                id: credential.id,
                rawId: encode(credential.rawId),
                type: credential.type,
                response: {
                  clientDataJSON: encode(response.clientDataJSON),
                  attestationObject: encode(response.attestationObject),
                },
                clientExtensionResults: credential.getClientExtensionResults(),
              },
            }),
          });
          await refresh();
          setStatus("Passkey added");
        }),
      );
      container.append(keys);
    }

    if (
      (state.policy || (state.mode === "none" ? "open" : "authenticated")) ===
      "authenticated"
    ) {
      const devices = section(
        "Devices & sessions",
        "Every human login becomes a revocable session. API tokens are listed separately.",
      );
      for (const session of state.sessions)
        devices.append(
          row(
            session.identity.displayName || session.identity.id,
            `${session.current ? "This device · " : ""}${session.method || "legacy"} · ${session.device || "Unknown browser"} · Last seen ${date(session.lastSeenAt)}`,
            button(
              "Revoke",
              async () => {
                await request(`/api/auth/sessions/${session.id}`, {
                  method: "DELETE",
                });
                if (session.current) location.reload();
                else await refresh();
              },
              true,
            ),
          ),
        );
      if (!state.sessions.length)
        devices.append(
          row(
            "No active devices",
            "Sign in from a browser to create a session.",
          ),
        );
      if (state.sessions.length)
        devices.append(
          button(
            "Revoke all sessions",
            async () => {
              if (!confirm("Sign out every browser and device?")) return;
              await request("/api/auth/sessions", { method: "DELETE" });
              location.reload();
            },
            true,
          ),
        );
      container.append(devices);
    }

    if (state.mode !== "none") {
      const password = section(
        "Password",
        state.passwordConfigured
          ? "Changing it revokes every other session."
          : "Set a password before retiring the legacy method.",
      );
      const value = document.createElement("input");
      value.type = "password";
      value.minLength = 12;
      value.autocomplete = "new-password";
      value.placeholder = "New password (12+ characters)";
      password.append(
        value,
        button(
          state.passwordConfigured ? "Change password" : "Set password",
          async () => {
            await request("/api/auth/password", {
              method: "PUT",
              body: JSON.stringify({ password: value.value }),
            });
            value.value = "";
            await refresh();
            setStatus("Password updated; other sessions revoked");
          },
        ),
      );
      container.append(password);
    }

    const tokens = section(
      "API tokens",
      "Tokens are for automation. The secret is displayed once and cannot be recovered.",
    );
    for (const token of state.apiTokens)
      tokens.append(
        row(
          token.name,
          `Expires ${date(token.expiresAt)}`,
          button(
            "Revoke",
            async () => {
              await request(`/api/auth/tokens/${token.id}`, {
                method: "DELETE",
              });
              await refresh();
            },
            true,
          ),
        ),
      );
    const tokenName = document.createElement("input");
    tokenName.placeholder = "Token name";
    const days = document.createElement("input");
    days.type = "number";
    days.min = "1";
    days.max = "365";
    days.value = "30";
    days.setAttribute("aria-label", "Token lifetime in days");
    const secret = document.createElement("div");
    secret.className = "securitySecret";
    secret.hidden = true;
    tokens.append(
      tokenName,
      days,
      button(
        "Create API token",
        async () => {
          const value = await request<{ secret: string }>("/api/auth/tokens", {
            method: "POST",
            body: JSON.stringify({
              name: tokenName.value,
              days: Number(days.value),
            }),
          });
          secret.replaceChildren();
          const warning = document.createElement("strong");
          warning.textContent = "Copy this secret now — it is shown once:";
          const code = document.createElement("code");
          code.textContent = value.secret;
          secret.append(
            warning,
            code,
            button("Copy secret", async () => {
              await navigator.clipboard.writeText(value.secret);
              setStatus("API token copied");
            }),
          );
          secret.hidden = false;
          await refresh(false);
        },
        false,
      ),
      secret,
    );
    container.append(tokens);

    if (state.mode !== "none") {
      const grants = section(
        "Add device",
        "Create a cancellable, single-use link valid for two minutes. It never shares the permanent server token.",
      );
      const output = document.createElement("div");
      output.className = "deviceGrantOutput";
      grants.append(
        button("Create add-device link", async () => {
          const grant = await request<{
            id: string;
            url: string;
            expiresAt: number;
          }>("/api/auth/device-grants", { method: "POST", body: "{}" });
          output.replaceChildren();
          const status = document.createElement("p");
          status.textContent = `Pending until ${date(grant.expiresAt)}`;
          const link = document.createElement("input");
          link.readOnly = true;
          link.value = grant.url;
          link.setAttribute("aria-label", "Add-device link");
          const qr = document.createElement("div");
          qr.className = "deviceGrantQr";
          qr.append(createQrSvg(grant.url, "Add device QR code"));
          output.append(
            status,
            qr,
            link,
            button("Copy link", async () =>
              navigator.clipboard.writeText(grant.url),
            ),
            button(
              "Cancel grant",
              async () => {
                await request(`/api/auth/device-grants/${grant.id}`, {
                  method: "DELETE",
                });
                await refresh();
                setStatus("Add-device grant cancelled");
              },
              true,
            ),
          );
          await refresh(false);
        }),
        output,
      );
      for (const grant of state.deviceGrants)
        grants.append(
          row(
            "Pending grant",
            `Created by ${grant.createdBy.displayName || grant.createdBy.id} · expires ${date(grant.expiresAt)}`,
            button(
              "Cancel",
              async () => {
                await request(`/api/auth/device-grants/${grant.id}`, {
                  method: "DELETE",
                });
                await refresh();
              },
              true,
            ),
          ),
        );
      container.append(grants);
    }
  }
  async function refresh(renderResult = true) {
    const state = await request<SecurityState>("/api/auth/security");
    if (renderResult) render(state);
    else current = state;
  }
  return { refresh, render: () => current && render(current) };
}
