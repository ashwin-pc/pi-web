import { describe, expect, it } from "vitest";
import { renderLoginPage } from "../../server/auth/loginPage.js";

describe("shared sign-in presentation", () => {
  it("prioritizes direct passkey authentication and discloses enabled alternatives", () => {
    const html = renderLoginPage({ methods: ["password", "passkey", "legacy", "external"] });
    expect(html).toContain('id="go"');
    expect(html).toContain('aria-controls="password"');
    expect(html).toContain('id="password" data-method="password" hidden');
    expect(html).toContain("Other ways to sign in");
    expect(html).toContain('data-method="legacy"');
    expect(html).toContain('data-method="external"');
    expect(html).toContain("navigator.credentials.get");
    expect(html).toContain('role="status"');
    expect(html).toContain("prefers-reduced-motion");
    expect(html).not.toContain("studio.balinese-bull");
  });
  it("shows a password-only form without hiding it or offering disabled methods", () => {
    const html = renderLoginPage({ methods: ["password"] });
    expect(html).toContain('id="password" data-method="password" >');
    expect(html).not.toContain('id="go"');
    expect(html).not.toContain('data-method="legacy"');
    expect(html).not.toContain('data-method="external"');
    expect(html).not.toContain("<details>");
  });
  it("preserves password and passkey setup while escaping terminal secrets", () => {
    const token = '</script><img src=x onerror="alert(1)">';
    const html = renderLoginPage({ methods: ["password", "passkey"], setupToken: token });
    expect(html).not.toContain(token);
    expect(html).toContain('name="confirm"');
    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain('minlength="12" maxlength="1024"');
    expect(html).toContain("passkey-bootstrap?token=%3C%2Fscript%3E");
    expect(html).toContain("\\u003c/script>");
    const passkey = renderLoginPage({ methods: ["passkey"], setupToken: token, passkeyOnly: true });
    expect(passkey).toContain('id="name"');
    expect(passkey).toContain("Create passkey");
    expect(passkey).not.toContain(token);
  });
  it("emits executable scripts for every page variant", () => {
    for (const options of [
      { methods: [] }, { methods: ["legacy"] },
      { methods: ["passkey", "password"] },
      { methods: ["passkey"], setupToken: "test", passkeyOnly: true },
    ]) {
      const html = renderLoginPage(options);
      const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
      expect(() => new Function(script)).not.toThrow();
    }
  });
});
