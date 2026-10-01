/** Server-side only. These clients are never serialized into browser contributions. */
export type PiWebHttpScope = "sessions.read" | "sessions.create" | "sessions.write" | "sessions.delete";

export interface PiWebHttpClientOptions {
  /** Diagnostic label supplied by trusted code, not a verified package identity. */
  name: string;
  scopes: readonly PiWebHttpScope[];
  /** Defaults to this agent session plus sessions created by this client.
   * `all` explicitly permits cross-session tools such as orchestration.
   */
  sessionIds?: "all" | readonly string[];
}

export interface PiWebHttpClient {
  /** Relative pi-web API path only. HTTP errors remain ordinary Responses.
   * JSON bodies and sessionId defaults are handled by core. No credential is exposed.
   */
  request(method: "GET" | "POST", path: string, options?: {
    body?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<Response>;
  /** Idempotently revoke this client's credentials and abort pending requests. */
  dispose(): void;
}
