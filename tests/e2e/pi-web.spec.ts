import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/mock/reset");
  await page.request.patch("/api/settings", {
    data: {
      appearance: { density: "comfortable", accentColor: "#e2b15f", loadingAnimation: "fireworks" },
      composer: { queueMode: "steer", expanded: false },
      defaults: { model: null, thinkingLevel: null },
    },
  });
});

test.describe("composer layout", () => {
  test("status header shows current session title and path", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("#statusBar")).toBeVisible();
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
    await expect(page.locator("#statusPath")).toContainText("pi-web");
  });

  test("running activity badge keeps header actions right-aligned", async ({ page }) => {
    await page.goto("/");

    const readLayout = () =>
      page.locator("#statusBar").evaluate((bar) => {
        const rect = bar.getBoundingClientRect();
        const lastActionRect = bar.querySelector("#currentSessionBucketButton")?.getBoundingClientRect();
        return {
          scrollWidth: bar.scrollWidth,
          clientWidth: bar.clientWidth,
          right: rect.right,
          lastActionRight: lastActionRect?.right || 0,
          viewportWidth: window.innerWidth,
        };
      });
    const expectActionsAtRight = (layout: Awaited<ReturnType<typeof readLayout>>) => {
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
      expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
      expect(layout.lastActionRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
      expect(layout.lastActionRight).toBeGreaterThanOrEqual(layout.right - 12);
    };

    expectActionsAtRight(await readLayout());

    await page.locator("#activityStatus").evaluate((el) => {
      el.hidden = false;
      el.className = "activityStatus running";
      el.textContent = "Running 12m 34s · tool: bash · no updates 45s";
    });

    expectActionsAtRight(await readLayout());
  });

  test("shows transient WebSocket reconnect state outside the chat", async ({ page }) => {
    let messagesRequestCount = 0;
    await page.route("**/api/messages**", async (route) => {
      messagesRequestCount += 1;
      await route.continue();
    });

    await page.clock.install({ time: 0 });
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      const fakeSockets: any[] = [];
      (window as any).__piWebSockets = fakeSockets;
      (window as any).__piWebSocketAutoOpen = true;

      class FakeWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readonly url: string;
        readonly protocol = "";
        readonly extensions = "";
        binaryType: BinaryType = "blob";
        bufferedAmount = 0;
        readyState = FakeWebSocket.CONNECTING;
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        constructor(url: string | URL, protocols?: string | string[]) {
          super();
          const parsed = new URL(String(url), location.href);
          if (parsed.pathname !== "/ws") {
            return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
          }

          this.url = parsed.href;
          fakeSockets.push(this);
          setTimeout(() => {
            if (this.readyState !== FakeWebSocket.CONNECTING) return;
            if ((window as any).__piWebSocketAutoOpen) this.emitOpen();
            else this.emitClose();
          }, 0);
        }

        send() {}
        close() { this.emitClose(); }
        emitOpen() {
          this.readyState = FakeWebSocket.OPEN;
          const event = new Event("open");
          this.dispatchEvent(event);
          this.onopen?.(event);
        }
        emitClose() {
          if (this.readyState === FakeWebSocket.CLOSED) return;
          this.readyState = FakeWebSocket.CLOSED;
          const event = new CloseEvent("close");
          this.dispatchEvent(event);
          this.onclose?.(event);
        }
      }

      (window as any).WebSocket = FakeWebSocket as any;
    });

    await page.goto("/");
    await page.clock.runFor(1);
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
    await expect(page.locator("#connectionStatus")).toBeHidden();

    await page.evaluate(() => (window as any).__piWebSockets.at(-1).emitClose());
    await page.clock.runFor(2501);
    await expect(page.locator("#connectionStatus")).toBeHidden();
    await expect(page.locator(".message.system", { hasText: "Disconnected" })).toHaveCount(0);
    expect(messagesRequestCount).toBe(1);

    await page.evaluate(() => {
      (window as any).__piWebSocketAutoOpen = false;
      (window as any).__piWebSockets.at(-1).emitClose();
    });
    await page.clock.runFor(2501);
    await expect(page.locator("#connectionStatus")).toHaveText("Live updates reconnecting…");
    await expect(page.locator(".message.system", { hasText: "Disconnected" })).toHaveCount(0);

    await page.clock.runFor(12_500);
    await expect(page.locator("#connectionStatus")).toHaveText("Live updates unavailable");

    await page.evaluate(() => {
      (window as any).__piWebSocketAutoOpen = true;
      (window as any).__piWebSockets.at(-1).emitOpen();
    });
    await expect(page.locator("#connectionStatus")).toHaveText("Reconnected");
    expect(messagesRequestCount).toBe(1);
    await page.clock.runFor(1_500);
    await expect(page.locator("#connectionStatus")).toBeHidden();
  });

  test("restores unsent composer draft after page refresh", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("draft survives refresh");

    await page.reload();

    await expect(page.locator("#prompt")).toHaveValue("draft survives refresh");
  });

  test("persists composer controls after page refresh", async ({ page }) => {
    await page.goto("/");

    await page.locator("#prompt").focus();
    await page.locator("#queueToggle").click();
    await page.locator("#promptForm").hover();
    await page.locator("#expandButton").click();
    await expect(page.locator("#promptForm")).toHaveClass(/expanded/);

    await page.reload();

    await expect(page.locator("#queueToggle")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#promptForm")).toHaveClass(/expanded/);
  });

  test("keeps send disabled until initial messages and websocket are ready", async ({ page }) => {
    let releaseMessages!: () => void;
    const messagesGate = new Promise<void>((resolve) => { releaseMessages = resolve; });
    let heldMessages = false;
    await page.route("**/api/messages**", async (route) => {
      if (!heldMessages) {
        heldMessages = true;
        await messagesGate;
      }
      await route.continue();
    });

    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      const fakeSockets: any[] = [];
      (window as any).__piWebSockets = fakeSockets;

      class FakeWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readonly url: string;
        readonly protocol = "";
        readonly extensions = "";
        binaryType: BinaryType = "blob";
        bufferedAmount = 0;
        readyState = FakeWebSocket.CONNECTING;
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        constructor(url: string | URL, protocols?: string | string[]) {
          super();
          const parsed = new URL(String(url), location.href);
          if (parsed.pathname !== "/ws") {
            return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
          }
          this.url = parsed.href;
          fakeSockets.push(this);
        }

        send() {}
        close() { this.emitClose(); }
        emitOpen() {
          this.readyState = FakeWebSocket.OPEN;
          const event = new Event("open");
          this.dispatchEvent(event);
          this.onopen?.(event);
        }
        emitClose() {
          if (this.readyState === FakeWebSocket.CLOSED) return;
          this.readyState = FakeWebSocket.CLOSED;
          const event = new CloseEvent("close");
          this.dispatchEvent(event);
          this.onclose?.(event);
        }
      }

      (window as any).WebSocket = FakeWebSocket as any;
    });

    await page.goto("/");
    await page.locator("#prompt").fill("hello");
    await expect(page.locator("#primaryButton")).toBeDisabled();

    releaseMessages();
    await expect(page.locator("#primaryButton")).toBeDisabled();
    await page.waitForFunction(() => (window as any).__piWebSockets.length > 0);
    await page.evaluate(() => (window as any).__piWebSockets.at(-1).emitOpen());

    await expect(page.locator("#primaryButton")).toBeEnabled();
  });

  test("renames the current session from the status title", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");

    await page.locator("#statusTitle").click();
    await page.locator("#statusTitle input").fill("Renamed from title");
    await page.locator("#statusTitle input").press("Enter");

    await expect(page.locator("#statusTitle")).toHaveText("Renamed from title");
    const sessions = await (await page.request.get("/api/sessions")).json();
    expect(sessions.sessions.find((item: any) => item.id === "mock-current").name).toBe("Renamed from title");
  });

  test("new session resets status title", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");

    await page.locator("#sessionButton").click();
    await page.locator("#sessionNewButton").click();

    await expect(page.locator("#statusTitle")).toHaveText("New session");
  });

  test("uses the URL session id as the active tab session", async ({ page, context }) => {
    await page.goto("/?sessionId=mock-older");
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");

    const other = await context.newPage();
    await other.goto("/?sessionId=mock-current");
    await expect(other.locator("#statusTitle")).toHaveText("Current mock session");
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");

    await page.locator("#sessionButton").click();
    await page.locator(".sessionItem", { hasText: "Current mock session" }).locator(".sessionItemNavBtn").click();
    await expect(page).toHaveURL(/sessionId=mock-current/);
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
    await expect(other.locator("#statusTitle")).toHaveText("Current mock session");
    await other.close();
  });

  test("switching sessions ignores stale drawer list refreshes", async ({ page }) => {
    let releaseStaleSessionsResponse!: () => void;
    const staleSessionsResponseReleased = new Promise<void>((resolve) => {
      releaseStaleSessionsResponse = resolve;
    });
    let sessionsRequestCount = 0;

    await page.route("**/api/sessions**", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }

      sessionsRequestCount += 1;
      if (sessionsRequestCount === 1) {
        await route.continue();
        return;
      }

      await staleSessionsResponseReleased;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [
            {
              id: "mock-current",
              name: "Current mock session",
              firstMessage: "Can you add image attachments?",
              created: "2026-05-01T10:00:00.000Z",
              modified: "2026-05-07T10:00:00.000Z",
              messageCount: 2,
              isCurrent: true,
            },
            {
              id: "mock-older",
              name: "Older mock session",
              firstMessage: "Review the mobile composer layout",
              created: "2026-05-01T09:00:00.000Z",
              modified: "2026-05-06T09:00:00.000Z",
              messageCount: 4,
              isCurrent: false,
            },
          ],
        }),
      });
    });

    await page.goto("/");
    await page.locator("#sessionButton").click();
    await page.getByText("Older mock session").click();
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");

    releaseStaleSessionsResponse();
    await page.waitForTimeout(100);
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");
  });

  test("composer controls fit without horizontal overflow", async ({ page }) => {
    await page.goto("/");
    const composer = page.locator("#promptForm");
    await expect(composer).toBeVisible();
    await expect(page.locator("#sessionButton")).toBeVisible();
    await expect(page.locator("#attachButton")).toBeVisible();
    await expect(page.locator("#primaryButton")).toBeHidden();

    await page.locator("#prompt").focus();
    await expect(page.locator("#primaryButton")).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);

    const composerBox = await composer.boundingBox();
    const sendBox = await page.locator("#primaryButton").boundingBox();
    expect(composerBox).toBeTruthy();
    expect(sendBox).toBeTruthy();
    expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(composerBox!.x + composerBox!.width + 1);
  });

  test("composer action row is flush, 40px tall, and has rounded bottom corners", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").focus();

    const footerBox = await page.locator(".composerFooter").boundingBox();
    const textAreaBox = await page.locator("#prompt").boundingBox();
    const modelSettingsBox = await page.locator("#modelSettingsButton").boundingBox();
    const sendBox = await page.locator("#primaryButton").boundingBox();
    expect(footerBox).toBeTruthy();
    expect(textAreaBox).toBeTruthy();
    expect(modelSettingsBox).toBeTruthy();
    expect(sendBox).toBeTruthy();

    expect(footerBox!.height).toBeCloseTo(40, 1);
    expect(footerBox!.y).toBeCloseTo(textAreaBox!.y + textAreaBox!.height, 1);
    expect(modelSettingsBox!.height).toBeCloseTo(40, 1);
    expect(sendBox!.height).toBeCloseTo(40, 1);

    const modelRadius = await page.locator("#modelSettingsButton").evaluate((el) => getComputedStyle(el).borderBottomLeftRadius);
    const sendRadius = await page.locator("#primaryButton").evaluate((el) => getComputedStyle(el).borderBottomRightRadius);
    expect(modelRadius).toBe("15px");
    expect(sendRadius).toBe("15px");
  });

  test("composer focus ring is inset instead of clipped", async ({ page }) => {
    await page.goto("/");
    await page.locator("#modelSettingsButton").focus();
    const styles = await page.locator("#modelSettingsButton").evaluate((el) => getComputedStyle(el));
    expect(styles.outlineStyle).toBe("none");
    expect(styles.boxShadow).toContain("inset");
  });

  test("accent color setting previews in one row and saves explicitly", async ({ page }) => {
    await page.goto("/");

    const readAccentStyles = () => page.evaluate(() => {
      let dot = document.querySelector<HTMLElement>("#accentTestUnreadDot");
      if (!dot) {
        dot = document.createElement("span");
        dot.id = "accentTestUnreadDot";
        dot.className = "sessionUnreadDot";
        dot.style.position = "fixed";
        dot.style.left = "8px";
        dot.style.bottom = "8px";
        document.body.append(dot);
      }
      const prompt = document.querySelector<HTMLElement>("#prompt")!;
      prompt.focus();
      return {
        rootAccent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
        buttonBackground: getComputedStyle(document.querySelector<HTMLElement>("#primaryButton")!).backgroundColor,
        promptFocusBorder: getComputedStyle(prompt).borderBottomColor,
        unreadDotBackground: getComputedStyle(dot).backgroundColor,
      };
    });

    const openSettings = async () => {
      if (await page.locator("#settingsPanel").isVisible()) return;
      if (await page.locator("#sessionDrawer").isHidden()) await page.locator("#sessionButton").click();
      await page.locator("#settingsButton").click();
      await expect(page.locator("#settingsPanel")).toBeVisible();
    };

    const before = await readAccentStyles();
    expect(before.rootAccent).toBe("#e2b15f");
    expect(before.promptFocusBorder).toBe("rgb(226, 177, 95)");
    expect(before.unreadDotBackground).toBe("rgb(226, 177, 95)");

    await openSettings();
    await expect(page.locator("#settingAccentMenuButton")).toBeVisible();
    await expect(page.locator("#settingAccentMenuName")).toHaveText("Antique Gold");
    await expect(page.locator("#settingAccentMenuValue")).toHaveText("#e2b15f");
    await expect(page.locator("#settingAccentPopover")).toBeHidden();

    await page.locator("#settingAccentMenuButton").click();
    await expect(page.locator("#settingAccentPopover")).toBeVisible();
    await expect(page.locator("#settingAccentColorInput")).toHaveValue("#e2b15f");
    await expect(page.locator('.settingsAccentSwatch[data-accent-color="#e2b15f"]')).toHaveAttribute("aria-checked", "true");

    await page.locator('.settingsAccentSwatch[data-accent-color="#d98adf"]').click();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#d98adf");
    await expect(page.locator("#settingAccentMenuName")).toHaveText("Velvet Orchid");
    await expect(page.locator('.settingsAccentSwatch[data-accent-color="#d98adf"]')).toHaveAttribute("aria-checked", "true");
    const preview = await readAccentStyles();
    expect(preview.buttonBackground).not.toBe(before.buttonBackground);
    expect(preview.promptFocusBorder).toBe("rgb(217, 138, 223)");
    expect(preview.unreadDotBackground).toBe("rgb(217, 138, 223)");

    await page.locator("#settingAccentCancelButton").click();
    await expect(page.locator("#settingAccentPopover")).toBeHidden();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#e2b15f");
    await expect(page.locator("#settingAccentMenuName")).toHaveText("Antique Gold");

    await page.locator("#settingAccentMenuButton").click();
    await page.locator('.settingsAccentSwatch[data-accent-color="#d98adf"]').click();
    await page.locator("#settingAccentApplyButton").click();
    await expect(page.locator("#settingAccentPopover")).toBeHidden();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#d98adf");
    await expect(page.locator("#settingAccentMenuValue")).toHaveText("#d98adf");

    await page.reload();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#d98adf");

    await openSettings();
    await page.locator("#settingAccentMenuButton").click();
    await page.locator("#settingAccentColorInput").fill("#ff00aa");
    await page.locator("#settingAccentApplyButton").click();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#ff00aa");
    const custom = await readAccentStyles();
    expect(custom.buttonBackground).not.toBe(before.buttonBackground);
    expect(custom.buttonBackground).not.toBe(preview.buttonBackground);
    expect(custom.promptFocusBorder).toBe("rgb(255, 0, 170)");
    expect(custom.unreadDotBackground).toBe("rgb(255, 0, 170)");
  });

  test("loading animation setting defaults to fireworks and persists", async ({ page }) => {
    await page.goto("/");

    const openSettings = async () => {
      if (await page.locator("#settingsPanel").isVisible()) return;
      if (await page.locator("#sessionDrawer").isHidden()) await page.locator("#sessionButton").click();
      await page.locator("#settingsButton").click();
      await expect(page.locator("#settingsPanel")).toBeVisible();
    };

    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.loadingAnimation)).toBe("fireworks");
    await openSettings();
    await expect(page.locator("#settingLoadingAnimationSelect")).toHaveValue("fireworks");

    await page.locator("#settingLoadingAnimationSelect").selectOption("pulse");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.loadingAnimation)).toBe("pulse");
    const settings = await (await page.request.get("/api/settings")).json();
    expect(settings.settings.appearance.loadingAnimation).toBe("pulse");

    await page.reload();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.loadingAnimation)).toBe("pulse");
    await openSettings();
    await expect(page.locator("#settingLoadingAnimationSelect")).toHaveValue("pulse");
  });

  test("keeps the local workbench selector in the session drawer footer", async ({ page }) => {
    await page.route("**/api/runtimes", (route) => route.fulfill({ json: { ok: true, runtimes: [
      { id: "local", label: "Local machine", kind: "local", cwd: "/Users/test/project" },
    ] } }));
    await page.goto("/");
    await page.locator("#sessionButton").click();
    await expect(page.locator("#workbenchRuntimeButton")).toBeVisible();
    await expect(page.locator("#workbenchRuntimeLabel")).toHaveText("Local");
  });

  test("recovers a stale per-tab runtime selection after that runtime was forgotten", async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem("pi-web-active-runtime", JSON.stringify({ id: "cmd-api", label: "Command API" })));
    await page.route("**/api/runtimes", (route) => route.fulfill({ json: { ok: true, runtimes: [
      { id: "local", label: "Local machine", kind: "local", cwd: "/Users/test/project" },
    ] } }));
    await page.goto("/");
    await page.locator("#sessionButton").click();
    await expect(page.locator("#workbenchRuntimeLabel")).toHaveText("Local");
    await expect(page.locator("#sessionList")).toContainText("Current mock session");
  });

  test("runtime panel lists runtimes and populates connect examples", async ({ page }) => {
    let runtimes = [
      { id: "local", label: "Local machine", kind: "local", cwd: "/Users/test/project" },
      { id: "mock-container", label: "Mock container", kind: "container", cwd: "/workspace", command: "mock-runtime", args: ["run"], disconnectable: true, capabilities: { messageBranching: true, sessionRename: false, slashCommands: false, shellCommands: false, sessionStats: false, gitPanel: false, gitSync: false, extensionUi: false, compactionCancel: false } },
    ];
    const connectedBodies: any[] = [];
    await page.route("**/api/runtimes/connect", async (route) => {
      const connectedBody = JSON.parse(route.request().postData() || "{}");
      connectedBodies.push(connectedBody);
      const runtime = {
        id: connectedBody.id,
        label: connectedBody.label,
        kind: connectedBody.adapter === "ssh" ? "ssh" : connectedBody.kind || "container",
        cwd: connectedBody.cwd,
        command: connectedBody.command || (connectedBody.adapter === "apple" ? "container" : connectedBody.adapter),
        args: connectedBody.args || [],
        disconnectable: true,
      };
      runtimes = [...runtimes, runtime];
      await route.fulfill({ status: 201, json: { ok: true, runtime } });
    });
    await page.route("**/api/runtimes", (route) => route.fulfill({ json: { ok: true, runtimes } }));

    await page.goto("/");
    await page.locator("#sessionButton").click();
    await page.locator("#workbenchRuntimeButton").click();
    await page.locator(".runtimePicker", { hasText: "Switch workbench runtime" }).getByRole("button", { name: "Manage runtimes…" }).click();
    await expect(page.locator("#runtimePanel")).toBeVisible();
    await expect(page.locator("#runtimeList")).toContainText("Local machine");
    await expect(page.locator("#runtimeList")).toContainText("Mock container");
    await expect(page.locator("#runtimeList")).toContainText("Unavailable: rename, slash commands, shell commands, full stats, Git panel, git sync, extension UI, compaction cancel");
    await expect(page.locator("#runtimeConnectKind")).toHaveValue("apple");
    await expect(page.locator("#runtimeAdvancedDetails")).not.toHaveAttribute("open", "");

    await page.locator("#runtimeConnectButton").click();
    await expect(page.locator("#runtimePanelStatus")).toContainText("Choose how this runtime should access models");
    expect(connectedBodies).toHaveLength(0);

    await page.locator("#runtimeConnectKind").selectOption("ssh");
    await page.locator("#runtimeConnectModelAccess").selectOption("runtime");
    await page.locator("#runtimeConnectLabel").fill("SSH test");
    await page.locator("#runtimeConnectTarget").fill("test-host");
    await page.locator("#runtimeConnectButton").click();
    await expect(page.locator("#runtimePanelStatus")).toContainText("Connected SSH test");
    expect(connectedBodies.at(-1)).toMatchObject({ id: "ssh:test-host", label: "SSH test", adapter: "ssh", target: "test-host", cwd: "~/workspace", runnerDir: "~/pi-web-runner", modelBroker: false });
    await expect(page.locator("#runtimeList")).toContainText("SSH test");

    await page.locator(".runtimeExample", { hasText: "SSH host" }).locator(".runtimeExampleUse").click();
    await expect(page.locator("#runtimeAdvancedDetails")).toHaveAttribute("open", "");
    await expect(page.locator("#runtimeConnectJson")).toHaveValue(/"id": "ssh:devbox"/);
  });

  test("context meter shows known usage details without low-usage label", async ({ page }) => {
    await page.goto("/");

    const meter = page.locator("#contextMeter");
    await expect(meter).toBeVisible();
    await expect(meter).toHaveClass(/normal/);
    await expect(page.locator("#contextMeterLabel")).toHaveText("");

    const percent = await meter.evaluate((el) => getComputedStyle(el).getPropertyValue("--context-percent").trim());
    expect(percent).toBe("14.5%");

    await meter.click();
    const popover = page.locator("#contextMeterPopover");
    await expect(popover).toBeVisible();
    await expect(popover).toContainText("Context usage");
    await expect(popover).toContainText("19k / 128k tokens · 15%");
    await expect(popover).toContainText("Input");
    await expect(popover).toContainText("Cache read");
  });

  test("context meter unknown state is subtle and unlabeled", async ({ page }) => {
    await page.goto("/");
    await page.locator("#sessionButton").click();
    await page.locator("#sessionNewButton").click();

    const meter = page.locator("#contextMeter");
    await expect(meter).toHaveClass(/unknown/);
    await expect(page.locator("#contextMeterLabel")).toHaveText("");
    await expect(meter).toHaveCSS("height", "2px");

    await meter.click();
    await expect(page.locator("#contextMeterPopover")).toContainText("Usage will appear after the next model response.");
  });

  test("context meter sits above rounded composer without covering focus ring on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const compactMeterBox = await page.locator("#contextMeter").boundingBox();
    const compactComposerBox = await page.locator("#promptForm").boundingBox();
    expect(compactMeterBox).toBeTruthy();
    expect(compactComposerBox).toBeTruthy();
    expect(compactMeterBox!.y + compactMeterBox!.height).toBeLessThanOrEqual(compactComposerBox!.y + 1);

    await page.locator("#prompt").focus();
    const meterBox = await page.locator("#contextMeter").boundingBox();
    const composerBox = await page.locator("#promptForm").boundingBox();
    const textareaBox = await page.locator("#prompt").boundingBox();
    expect(meterBox).toBeTruthy();
    expect(composerBox).toBeTruthy();
    expect(textareaBox).toBeTruthy();

    expect(meterBox!.y + meterBox!.height).toBeLessThanOrEqual(composerBox!.y + 1);
    expect(textareaBox!.y).toBeCloseTo(composerBox!.y + 1, 2);

    const textareaRadius = await page.locator("#prompt").evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    const trackRadius = await page.locator(".contextMeterTrack").evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    expect(textareaRadius).toBe("15px");
    expect(trackRadius).toBe("999px");
  });

  test("model settings popover changes reasoning level explicitly", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("#modelSettingsButton")).toContainText("Mock Model");
    await expect(page.locator("#modelSettingsButton")).toHaveAttribute("title", /mock\/model/);
    await expect(page.locator("#modelSettingsThinking")).toContainText("medium");
    await expect(page.locator("#modelSettingsThinking")).not.toContainText("reasoning");

    await page.locator("#modelSettingsButton").click();
    await expect(page.locator("#modelSettingsPopover")).toBeVisible();
    await expect(page.locator("#modelSelect")).toHaveValue("mock/model");
    await expect(page.locator("#thinkingSelect")).toHaveValue("medium");

    await page.locator("#thinkingSelect").selectOption("off");
    await expect(page.locator("#modelSettingsButton")).toHaveAttribute("data-thinking-level", "off");
    await expect(page.locator("#modelSettingsThinking")).toContainText("off");

    const state = await (await page.request.get("/api/state")).json();
    expect(state.thinkingLevel).toBe("off");
  });

  test("model settings popover stays open after mobile model selection", async ({ page }) => {
    const models = [
      { provider: "mock", id: "model", name: "Mock Model", reasoning: true, contextWindow: 128000, maxTokens: 4096 },
      { provider: "mock", id: "other", name: "Other Mock Model", reasoning: true, contextWindow: 128000, maxTokens: 4096 },
    ];
    let current = models[0];
    await page.route("**/api/models**", async (route) => {
      await route.fulfill({
        json: { ok: true, cwd: process.cwd(), current, thinkingLevel: "medium", thinkingLevels: ["off", "low", "medium", "high"], models },
      });
    });
    await page.route("**/api/model", async (route) => {
      const body = route.request().postDataJSON() as { provider?: string; id?: string; thinkingLevel?: string };
      current = models.find((model) => model.provider === body.provider && model.id === body.id) || current;
      await route.fulfill({
        json: { ok: true, sessionId: "mock-current", cwd: process.cwd(), model: current, thinkingLevel: body.thinkingLevel || "medium", thinkingLevels: ["off", "low", "medium", "high"] },
      });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.locator("#promptForm")).toHaveClass(/compactInactive/);

    await page.locator("#modelSettingsButton").click();
    await expect(page.locator("#modelSettingsPopover")).toBeVisible();
    await expect(page.locator("#modelSelect")).toHaveValue("mock/model");

    await page.locator("#modelSelect").selectOption("mock/other");
    await expect(page.locator("#modelSettingsButton")).toBeEnabled();

    await page.evaluate(() => {
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    });

    await expect(page.locator("#modelSettingsPopover")).toBeVisible();
    await expect(page.locator("#modelSettingsButton")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#modelSelect")).toHaveValue("mock/other");
    await expect(page.locator("#modelSettingsButton")).toContainText("Other Mock Model");
    await expect(page.locator("#modelSettingsButton")).toHaveAttribute("title", /mock\/other/);

    await page.mouse.click(5, 5);
    await expect(page.locator("#modelSettingsPopover")).toBeHidden();
  });

  test("model settings popover is not clipped on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    await page.locator("#modelSettingsButton").click();
    await expect(page.locator("#modelSettingsPopover")).toBeVisible();

    const composerOverflow = await page.locator("#promptForm").evaluate((el) => getComputedStyle(el).overflow);
    expect(composerOverflow).toBe("visible");

    const popoverBox = await page.locator("#modelSettingsPopover").boundingBox();
    expect(popoverBox).toBeTruthy();
    expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
    expect(popoverBox!.y).toBeGreaterThanOrEqual(0);
    expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(390);
    expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(844);
  });

  test("composer expands to fullscreen editor", async ({ page }) => {
    await page.goto("/");
    const composer = page.locator("#promptForm");
    await page.locator("#prompt").focus();
    const before = await composer.boundingBox();
    expect(before).toBeTruthy();

    await composer.hover();
    await page.locator("#expandButton").click();

    await expect(composer).toHaveClass(/expanded/);
    const after = await composer.boundingBox();
    expect(after).toBeTruthy();
    expect(after!.height).toBeGreaterThan(before!.height * 2);

    await page.locator("#expandButton").click();
    await expect(composer).not.toHaveClass(/expanded/);
  });
});

test.describe("sessions drawer", () => {
  test("session rows keep title and metadata on one line", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.locator("#sessionButton").click();

    const drawer = page.locator("#sessionDrawer");
    await expect(drawer).toBeVisible();

    const drawerBox = await drawer.boundingBox();
    expect(drawerBox).toBeTruthy();
    expect(drawerBox!.width).toBeLessThanOrEqual(390);

    const items = page.locator(".sessionItem");
    await expect(items).toHaveCount(2);

    for (let i = 0; i < 2; i += 1) {
      const item = items.nth(i);
      const itemBox = await item.boundingBox();
      const titleBox = await item.locator(".sessionItemTitle").boundingBox();
      const metaBox = await item.locator(".sessionItemMeta").boundingBox();
      expect(itemBox).toBeTruthy();
      expect(titleBox).toBeTruthy();
      expect(metaBox).toBeTruthy();

      expect(itemBox!.height).toBeCloseTo(32, 1);
      expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(metaBox!.x + 1);
      expect(Math.abs((titleBox!.y + titleBox!.height / 2) - (metaBox!.y + metaBox!.height / 2))).toBeLessThanOrEqual(2);
    }

    const firstBox = await items.nth(0).boundingBox();
    const secondBox = await items.nth(1).boundingBox();
    expect(firstBox).toBeTruthy();
    expect(secondBox).toBeTruthy();
    expect(firstBox!.y + firstBox!.height).toBeLessThanOrEqual(secondBox!.y);
  });

  test("shows a spinner for a background running session", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("slow background task");
    await page.locator("#primaryButton").click();
    await page.locator("#sessionButton").click();
    await expect(page.locator(".sessionItem", { hasText: "Current mock session" }).locator(".sessionSpinner")).toBeVisible();

    await page.getByText("Older mock session").click();
    const isMobile = (page.viewportSize()?.width || 0) <= 700;
    if (isMobile) {
      await expect(page.locator("#sessionDrawer")).toBeHidden();
      await page.locator("#sessionButton").click();
    } else {
      await expect(page.locator("#sessionDrawer")).toBeVisible();
    }
    await expect(page.locator(".sessionItem", { hasText: "Current mock session" }).locator(".sessionSpinner")).toBeVisible();
    await expect(page.locator(".sessionItem", { hasText: "Older mock session" }).locator(".sessionSpinner")).toHaveCount(0);
  });

  test("desktop push mode uses the full space beside the drawer", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/");
    await page.locator("#sessionButton").click();

    const drawerBox = await page.locator("#sessionDrawer").boundingBox();
    const appBox = await page.locator(".app").boundingBox();
    expect(drawerBox).toBeTruthy();
    expect(appBox).toBeTruthy();
    expect(drawerBox!.x + drawerBox!.width).toBeCloseTo(appBox!.x, 1);
    expect(appBox!.x + appBox!.width).toBeCloseTo(1600, 1);
  });

  test("includes browser-remembered cwds when listing sessions", async ({ page }) => {
    const rememberedCwd = "/Users/ashwin/projects/remembered";
    await page.addInitScript((cwd) => {
      localStorage.setItem("pi-web-known-session-cwds", JSON.stringify([cwd]));
    }, rememberedCwd);

    let sessionsUrl = "";
    await page.route("**/api/sessions?**", async (route) => {
      sessionsUrl = route.request().url();
      await route.continue();
    });

    await page.goto("/");
    await page.locator("#sessionButton").click();
    await expect.poll(() => sessionsUrl).toContain("/api/sessions?");
    expect(new URL(sessionsUrl).searchParams.getAll("cwd")).toContain(rememberedCwd);
  });

  test("workbench runtime scopes new-session folder browsing", async ({ page }) => {
    const dirRequests: Array<{ runtimeId: string | null; path: string | null }> = [];
    const sessionListRequests: URL[] = [];
    await page.route("**/api/runtimes", (route) => route.fulfill({ json: { ok: true, runtimes: [
      { id: "local", label: "Local machine", kind: "local", cwd: "/Users/test/project" },
      { id: "container:test", label: "Test container", kind: "container", cwd: "/workspace" },
    ] } }));
    await page.route("**/api/sessions?**", async (route) => {
      sessionListRequests.push(new URL(route.request().url()));
      await route.continue();
    });
    await page.route("**/api/sessions/new", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      if (body.runtimeId !== "container:test") return route.continue();
      await route.fulfill({ json: { ok: true, sessionId: "runtime-session", cwd: body.cwd || "/workspace", sessionFile: "/runtime/session.jsonl", runtimeRef: { id: "container:test", kind: "container", label: "Test container", cwd: body.cwd || "/workspace" }, model: null, thinkingLevel: "off", thinkingLevels: ["off"], isStreaming: false, isCompacting: false } });
    });
    await page.route("**/api/state*", async (route) => {
      if (route.request().headers()["x-pi-web-runtime-id"] !== "container:test") return route.continue();
      await route.fulfill({ json: { ok: true, sessionId: "runtime-session", cwd: "/workspace", sessionFile: "/runtime/session.jsonl", runtimeRef: { id: "container:test", kind: "container", label: "Test container", cwd: "/workspace" }, model: null, thinkingLevel: "off", thinkingLevels: ["off"], isStreaming: false, isCompacting: false } });
    });
    await page.route("**/api/messages?**", async (route) => {
      if (route.request().headers()["x-pi-web-runtime-id"] !== "container:test") return route.continue();
      await route.fulfill({ json: { ok: true, messages: [] } });
    });
    await page.route("**/api/fs/dirs?**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.searchParams.get("path") || "/";
      dirRequests.push({ runtimeId: url.searchParams.get("runtimeId"), path });
      await route.fulfill({ json: { ok: true, path, parent: path === "/" ? "/" : "/", dirs: [{ name: "app", path: `${path.replace(/\/$/, "")}/app` }] } });
    });

    page.on("dialog", (dialog) => dialog.accept());
    await page.goto("/");
    await page.locator("#sessionButton").click();
    await expect(page.locator("#workbenchRuntimeButton")).toBeVisible();
    await page.locator("#sessionNewButton").click();
    await expect(page.locator(".emptyCwdChooser", { hasText: "Working directory" })).toBeVisible();
    if (await page.locator("#sessionDrawer").isHidden()) await page.locator("#sessionButton").click();

    await page.locator("#workbenchRuntimeButton").click();
    await page.locator(".runtimePicker .folderPickerRow", { hasText: "Test container" }).click();
    await page.locator(".runtimePicker .primaryAction").click();
    await expect(page.locator("#workbenchRuntimeLabel")).toHaveText("Test container");
    await expect(page.locator("#sessionList")).not.toContainText("Current mock session");
    await expect.poll(() => sessionListRequests.some((url) => url.searchParams.get("runtimeId") === "container:test" && url.searchParams.get("cached") === "1")).toBe(true);
    await expect.poll(() => sessionListRequests.some((url) => url.searchParams.get("runtimeId") === "container:test" && !url.searchParams.has("cached"))).toBe(true);

    if (await page.locator("#sessionDrawer").isHidden()) await page.locator("#sessionButton").click();
    await page.locator("#settingsButton").click();
    await expect(page.locator("#settingSessionDefaultsTitle")).toHaveText("Test container new sessions");
    await expect(page.locator("#settingSessionDefaultsHint")).toContainText("owns its model authentication and defaults");
    await expect(page.locator("#settingSaveModelDefaultsButton")).toBeDisabled();
    await page.locator("#settingsCloseButton").click();

    await page.locator(".emptyCwdButton").evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator(".folderPickerRuntimeSelect")).toBeHidden();
    await expect(page.locator(".folderPickerInput")).toHaveValue("/workspace");
    await expect.poll(() => dirRequests.at(-1)?.runtimeId).toBe("container:test");
    await expect(page.locator(".folderPickerList")).toContainText("app");

    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.locator("#workbenchRuntimeLabel")).toHaveText("Test container");
  });

  test("pinned folders stay first and folder labels disambiguate on one row", async ({ page }) => {
    const pinnedCwd = "/Users/ashwin/projects/pi";
    const projectCwd = "/Users/ashwin/projects/pi-web";
    const archiveCwd = "/Users/ashwin/archive/pi-web";
    await page.request.patch("/api/session-ui-state", { data: { pinnedFolders: [pinnedCwd] } });

    await page.route(/\/api\/sessions(?:\?.*)?$/, async (route) => {
      await route.fulfill({
        json: {
          ok: true,
          sessions: [
            { id: "archive", name: "Archive session", created: "2026-01-03T00:00:00.000Z", modified: "2026-01-03T00:00:00.000Z", messageCount: 1, cwd: archiveCwd, isCurrent: false, unread: false },
            { id: "project", name: "Project session", created: "2026-01-02T00:00:00.000Z", modified: "2026-01-02T00:00:00.000Z", messageCount: 1, cwd: projectCwd, isCurrent: false, unread: false },
            { id: "pinned", name: "Pinned session", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 1, cwd: pinnedCwd, isCurrent: false, unread: false },
          ],
        },
      });
    });

    await page.goto("/");
    await page.locator("#sessionButton").click();

    const headers = page.locator(".sessionFolderHeader");
    await expect(headers).toHaveCount(3);
    await expect(headers.locator(".sessionFolderPath")).toHaveCount(0);
    await expect(headers.nth(0).locator(".sessionFolderName")).toHaveText("projects/pi");
    await expect(headers.nth(1).locator(".sessionFolderName")).toHaveText("archive/pi-web");
    await expect(headers.nth(2).locator(".sessionFolderName")).toHaveText("projects/pi-web");
    await expect(headers.nth(0).locator(".sessionFolderPinButton")).toHaveAttribute("aria-pressed", "true");

    await headers.nth(2).locator(".sessionFolderPinButton").click();
    await expect(headers.nth(0).locator(".sessionFolderName")).toHaveText("projects/pi");
    await expect(headers.nth(1).locator(".sessionFolderName")).toHaveText("projects/pi-web");
    await expect(headers.nth(2).locator(".sessionFolderName")).toHaveText("archive/pi-web");

    const uiState = await (await page.request.get("/api/session-ui-state")).json();
    expect(uiState.sessionUiState.pinnedFolders).toEqual([pinnedCwd, projectCwd]);
  });

  test("opens, lists sessions, resumes an older session, and creates new session", async ({ page }) => {
    await page.goto("/");
    await page.locator("#sessionButton").click();
    await expect(page.locator("#sessionDrawer")).toBeVisible();
    const drawer = page.locator("#sessionDrawer");
    await expect(page.locator("#sessionNewButton")).toBeVisible();
    await expect(drawer.getByText("Current mock session")).toBeVisible();
    await expect(drawer.getByText("Older mock session")).toBeVisible();

    await drawer.getByText("Older mock session").click();
    const isMobile = (page.viewportSize()?.width || 0) <= 700;
    if (isMobile) await expect(page.locator("#sessionDrawer")).toBeHidden();
    else await expect(page.locator("#sessionDrawer")).toBeVisible();
    await expect(page.getByText("Resumed older session.")).toBeVisible();

    if (isMobile) await page.locator("#sessionButton").click();
    await page.locator("#sessionNewButton").click();
    if (isMobile) await expect(page.locator("#sessionDrawer")).toBeHidden();
    else await expect(page.locator("#sessionDrawer")).toBeVisible();
    await expect(page.locator(".emptyCwdChooser", { hasText: "Working directory" })).toBeVisible();
  });

  test("deletes a non-current session from the row actions menu", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto("/");
    await page.locator("#sessionButton").click();

    const drawer = page.locator("#sessionDrawer");
    const olderRow = drawer.locator(".sessionItem", { hasText: "Older mock session" });
    await expect(olderRow).toBeVisible();

    await olderRow.locator(".sessionItemActionsBtn").click();
    const menu = page.locator(".sessionActionsMenu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Delete" }).click();

    await expect(drawer.getByText("Older mock session")).toHaveCount(0);
    await expect(drawer.getByText("Current mock session")).toBeVisible();
    await expect(page.locator(".message.system", { hasText: /Session (deleted|moved to trash)/ })).toBeVisible();
  });
});

test.describe("slash commands", () => {
  test("runs slash commands from the composer", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("/reload");
    await page.locator("#primaryButton").click();
    await expect(page.locator(".message.system", { hasText: "› /reload" })).toBeVisible();
    await expect(page.locator(".message.system", { hasText: "Reloaded pi resources" })).toBeVisible();

    await page.locator("#prompt").fill("/thinking low");
    await page.locator("#primaryButton").click();
    await expect(page.locator(".message.system", { hasText: "Thinking level set to low" })).toBeVisible();
  });

  test("sends leading-whitespace slash input as a normal prompt", async ({ page }) => {
    let promptBody: any;
    await page.route("**/api/prompt", async (route) => {
      promptBody = route.request().postDataJSON();
      await route.continue();
    });

    await page.goto("/");
    await page.locator("#prompt").fill(" /reload");
    await expect(page.locator("#slashCommands")).toBeHidden();
    await page.locator("#primaryButton").click();

    await expect.poll(() => promptBody?.message).toBe("/reload");
    await expect(page.locator(".message.user", { hasText: "/reload" })).toBeVisible();
    await expect(page.locator(".message.system", { hasText: "› /reload" })).toHaveCount(0);
    await expect(page.locator(".message.system", { hasText: "Reloaded pi resources" })).toHaveCount(0);
  });

  test("sends leading-whitespace shell escape input as a normal prompt", async ({ page }) => {
    let promptBody: any;
    await page.route("**/api/prompt", async (route) => {
      promptBody = route.request().postDataJSON();
      await route.continue();
    });

    await page.goto("/");
    await page.locator("#prompt").fill(" !echo hi");
    await page.locator("#primaryButton").click();

    await expect.poll(() => promptBody?.message).toBe("!echo hi");
    await expect(page.locator(".message.user", { hasText: "!echo hi" })).toBeVisible();
    await expect(page.locator(".message.system", { hasText: "› !echo hi" })).toHaveCount(0);
  });
});

test.describe("attachments and prompt", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
    await expect(page.locator("#connectionStatus")).toBeHidden();
  });

  test("empty attachment container collapses and populated attachment row has padding", async ({ page }) => {
    const attachments = page.locator("#attachments");
    await expect(attachments).toHaveCSS("display", "none");

    const file = {
      name: "tiny.png",
      mimeType: "image/png",
      buffer: VALID_PNG,
    };
    await page.locator("#imageInput").setInputFiles(file);
    await expect(page.locator(".attachmentChip")).toBeVisible();
    await expect(attachments).toHaveCSS("padding-top", "8px");
    await expect(attachments).toHaveCSS("padding-right", "8px");
    await expect(attachments).toHaveCSS("padding-bottom", "8px");
    await expect(attachments).toHaveCSS("padding-left", "8px");

    const attachmentBg = await attachments.evaluate((el) => getComputedStyle(el).backgroundColor);
    const composerBg = await page.locator("#promptForm").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(attachmentBg).toBe(composerBg);
  });

  test("supports dragging and dropping image attachments", async ({ page }) => {
    const dataTransfer = await page.evaluateHandle((bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "dropped.png", { type: "image/png" }));
      return transfer;
    }, Array.from(VALID_PNG));

    await page.locator("#promptForm").dispatchEvent("dragenter", { dataTransfer });
    await expect(page.locator("#promptForm")).toHaveClass(/dragOver/);
    await page.locator("#promptForm").dispatchEvent("drop", { dataTransfer });

    await expect(page.locator(".attachmentChip")).toContainText("dropped.png");
    await expect(page.locator("#primaryButton")).toBeEnabled();
  });

  test("supports image-only prompt and attachment removal", async ({ page }) => {
    const file = {
      name: "tiny.png",
      mimeType: "image/png",
      buffer: VALID_PNG,
    };
    await page.locator("#imageInput").setInputFiles(file);
    await expect(page.locator(".attachmentChip")).toBeVisible();
    await expect(page.locator("#primaryButton")).toBeEnabled();

    await page.locator(".removeAttachment").click();
    await expect(page.locator(".attachmentChip")).toHaveCount(0);
    await expect(page.locator("#primaryButton")).toBeDisabled();

    await page.locator("#imageInput").setInputFiles(file);
    await expect(page.locator(".attachmentChip")).toBeVisible();
    await page.locator("#primaryButton").click();
    await expect(page.locator(".message.user .messageImageThumb")).toBeVisible();
    await expect(page.getByText("Mock response with image.").first()).toBeVisible();
  });
});

test.describe("tool cards", () => {
  test("renders tool results as tool cards instead of tool bubbles", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("use tool");
    await page.locator("#primaryButton").click();

    const card = page.locator(".toolCard.toolCard--success").last();
    await expect(card).toBeVisible();
    await expect(card.locator(".toolCardName")).toHaveText("read");
    await expect(card.locator(".toolCardSubtitle")).toHaveText("/some/file");
    await expect(card.locator(".toolCardBody")).toContainText("file contents here");
    await expect(page.locator(".toolCard--running")).toHaveCount(0);
    await expect(page.locator(".message.tool")).toHaveCount(0);
  });

  test("restores pending tool calls after refresh", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("pending tool refresh");
    await page.locator("#primaryButton").click();

    const liveCard = page.locator(".toolCard.toolCard--running", { hasText: "read" }).last();
    await expect(liveCard).toBeVisible();
    await expect(liveCard.locator(".toolCardSubtitle")).toHaveText("/some/file");

    await page.reload();

    const restoredCard = page.locator(".toolCard.toolCard--running", { hasText: "read" }).last();
    await expect(restoredCard).toBeVisible();
    await expect(restoredCard.locator(".toolCardSubtitle")).toHaveText("/some/file");
    await expect(page.locator(".message.tool")).toHaveCount(0);
  });

  test("adds elapsed time when a running tool timestamp arrives after the card", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Timer regression is covered once on desktop.");

    await page.goto("/");
    await page.locator("#prompt").fill("late tool timestamp");
    await page.locator("#primaryButton").click();

    const liveCard = page.locator(".toolCard.toolCard--running", { hasText: "read" }).last();
    await expect(liveCard).toBeVisible();
    await expect(liveCard.locator(".toolCardProgress")).toContainText(/running [1-9]s|running \d+m/, { timeout: 3000 });
    await expect(page.locator(".toolCard--running")).toHaveCount(0, { timeout: 6000 });
  });

  test("keeps running elapsed timers when returning to a running session", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Timer regression is covered once on desktop.");

    await page.goto("/");
    await page.locator("#prompt").fill("progress demo");
    await page.locator("#primaryButton").click();

    const liveCard = page.locator(".toolCard.toolCard--running", { hasText: "read" }).last();
    await expect(liveCard).toBeVisible();

    await page.waitForTimeout(2200);
    await expect(liveCard.locator(".toolCardProgress")).toContainText(/running [2-9]s|running \d+m/);

    await page.reload();
    const reloadedCard = page.locator(".toolCard.toolCard--running", { hasText: "read" }).last();
    await expect(reloadedCard).toBeVisible();
    await expect(reloadedCard.locator(".toolCardProgress")).toContainText(/running [2-9]s|running \d+m/);

    await page.goto("/?sessionId=mock-older");
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");

    await page.goto("/?sessionId=mock-current");
    const restoredCard = page.locator(".toolCard.toolCard--running", { hasText: "read" }).last();
    await expect(restoredCard).toBeVisible();
    await expect(restoredCard.locator(".toolCardProgress")).toContainText(/running [2-9]s|running \d+m/);
  });

  test("keeps quiet activity elapsed when returning to a running session", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Timer regression is covered once on desktop.");

    const quietPattern = /no updates (3[0-9]|4[0-9]|5[0-9])s|no updates \d+m/;

    await page.goto("/");
    await page.locator("#prompt").fill("quiet runtime");
    await page.locator("#primaryButton").click();

    await expect(page.locator("#runtimeStatus")).toContainText(quietPattern);

    await page.reload();
    await expect(page.locator("#runtimeStatus")).toContainText(quietPattern);

    await page.goto("/?sessionId=mock-older");
    await expect(page.locator("#statusTitle")).toHaveText("Older mock session");

    await page.goto("/?sessionId=mock-current");
    await expect(page.locator("#runtimeStatus")).toContainText(quietPattern);

    await page.locator("#stopButton").click();
    await expect(page.locator("#runtimeStatus")).toBeHidden();
  });

  test("compact density keeps tool calls to one row until expanded", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
    await page.evaluate(() => { document.documentElement.dataset.density = "compact"; });
    await page.locator("#prompt").fill("use tool");
    await page.locator("#primaryButton").click();
    await expect(page.locator(".message.assistant", { hasText: "Let me check that for you." }).last()).toBeVisible();
    await expect(page.locator(".message.assistant", { hasText: "Done reading." }).last()).toBeVisible();

    const card = page.locator(".toolCard.toolCard--success").last();
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/toolCard--compactCollapsed/);
    await expect(card.locator(".toolCardExpandToggle")).toHaveAttribute("aria-expanded", "false");
    await expect(card.locator(".toolCardBody")).toBeHidden();

    const collapsedHeight = await card.evaluate((el) => el.getBoundingClientRect().height);
    expect(collapsedHeight).toBeLessThanOrEqual(32);

    await card.locator(".toolCardExpandToggle").click();
    await expect(card).not.toHaveClass(/toolCard--compactCollapsed/);
    await expect(card.locator(".toolCardBody")).toBeVisible();
    await expect(card.locator(".toolCardArgKey")).toContainText("path");
    await expect(card.locator(".toolCardArgValue")).toContainText("/some/file");
    await expect(card.locator(".toolCardExpandToggle")).toHaveAttribute("aria-expanded", "true");

    const expandedHeight = await card.evaluate((el) => el.getBoundingClientRect().height);
    expect(expandedHeight).toBeGreaterThan(collapsedHeight);
  });

  test("renders edit tool calls as a side-by-side intraline diff with an icon layout toggle", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("edit diff");
    await page.locator("#primaryButton").click();

    const card = page.locator(".toolCard.toolCard--success", { hasText: "edit" }).last();
    await expect(card).toBeVisible();
    await expect(card.locator(".toolCardName")).toHaveText("edit");
    await expect(card.locator(".toolCardSubtitle")).toHaveText("/some/file.ts");
    await expect(card.locator(".diffContainer")).toHaveClass(/diffContainer--sideBySide/);
    await expect(card.locator(".diffLayoutToggle")).toHaveAttribute("aria-label", "Switch to top/bottom diff view");
    await expect(card.locator(".diffLayoutToggle svg")).toHaveCount(1);
    await expect(card.locator(".diffLine--changed")).toHaveCount(2);
    await expect(card.locator(".diffWord--del", { hasText: "41" })).toBeVisible();
    await expect(card.locator(".diffWord--add", { hasText: "42" })).toBeVisible();
    await expect(card.locator(".diffWord--del", { hasText: "log" })).toBeVisible();
    await expect(card.locator(".diffWord--add", { hasText: "info" })).toBeVisible();
    await expect(card.locator(".toolCardBody")).toHaveCount(0);

    await card.locator(".diffLayoutToggle").click();
    await expect(card.locator(".diffContainer")).toHaveClass(/diffContainer--stacked/);
    await expect(card.locator(".diffLayoutToggle")).toHaveAttribute("aria-label", "Switch to side-by-side diff view");
  });

  test("renders edit diffs for flat oldText/newText args", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("flat edit");
    await page.locator("#primaryButton").click();

    const card = page.locator(".toolCard.toolCard--success", { hasText: "edit" }).last();
    await expect(card).toBeVisible();
    await expect(card.locator(".toolCardName")).toHaveText("edit");
    await expect(card.locator(".toolCardSubtitle")).toHaveText("/some/file.ts");
    await expect(card.locator(".diffContainer")).toBeVisible();
    await expect(card.locator(".diffLine--changed")).toHaveCount(2);
    await expect(card.locator(".diffWord--del", { hasText: "41" })).toBeVisible();
    await expect(card.locator(".diffWord--add", { hasText: "42" })).toBeVisible();
    await expect(card.locator(".toolCardBody")).toHaveCount(0);
  });

  test("does not crash when edit tool args omit oldText or newText", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    await page.locator("#prompt").fill("malformed edit");
    await page.locator("#primaryButton").click();

    const card = page.locator(".toolCard.toolCard--success", { hasText: "edit" }).last();
    await expect(card).toBeVisible();
    await expect(card.locator(".diffContainer")).toBeVisible();
    expect(errors).not.toContain("Cannot read properties of undefined (reading 'split')");
  });
});

test.describe("assistant markdown rendering", () => {
  test("renders normal assistant responses as markdown", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("please return markdown");
    await page.locator("#primaryButton").click();

    const latestAssistant = page.locator(".message.assistant", { hasText: "Here is" }).last();
    await expect(latestAssistant.locator(".markdownBody strong")).toHaveText("bold");
    await expect(latestAssistant.locator(".markdownBody li")).toHaveText(["one", "two"]);
    await expect(latestAssistant.locator(".markdownBody pre code")).toContainText("const answer = 42;");
    await expect(latestAssistant.locator(".body")).not.toContainText("**bold**");
  });

  test("renders Mermaid code fences as diagrams", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("please return mermaid");
    await page.locator("#primaryButton").click();

    const latestAssistant = page.locator(".message.assistant", { hasText: "Here is a Mermaid diagram" }).last();
    await expect(latestAssistant.locator(".mermaidDiagram svg")).toBeVisible({ timeout: 10_000 });
    await expect(latestAssistant.locator("pre > code.language-mermaid")).toHaveCount(0);
  });

  test("renders collapsed long assistant messages as markdown before and after show more", async ({ page }) => {
    await page.goto("/");
    const longMessage = page.locator(".message.assistant.collapsible").first();
    await expect(longMessage).toBeVisible();
    await expect(longMessage).toHaveClass(/collapsed/);

    const toggle = longMessage.locator(".messageToggle");
    let toggleStyles = await toggle.evaluate((el) => getComputedStyle(el));
    expect(toggleStyles.borderTopStyle).toBe("none");
    await toggle.hover();
    toggleStyles = await toggle.evaluate((el) => getComputedStyle(el));
    expect(toggleStyles.borderTopStyle).toBe("none");

    await expect(longMessage.locator(".body.markdownBody")).toHaveAttribute("data-markdown-rendered", "true");
    await expect(longMessage.locator(".markdownBody h2").first()).toHaveText("Image attachment support");
    await expect(longMessage.locator(".markdownBody strong").first()).toHaveText("enabled");
    await expect(longMessage.locator(".body")).not.toContainText("**enabled**");

    await toggle.evaluate((el: HTMLButtonElement) => el.click());
    await expect(longMessage).not.toHaveClass(/collapsed/);
    await expect(toggle).toHaveText("Show less");
    await expect(longMessage.locator(".markdownBody pre code").first()).toContainText("const enabled = true;");

    await toggle.evaluate((el: HTMLButtonElement) => el.click());
    await expect(longMessage).toHaveClass(/collapsed/);
  });
});

test.describe("code block copy button", () => {
  test("copy button appears on hover and switches to check icon on click", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("please return markdown");
    await page.locator("#primaryButton").click();

    const pre = page.locator(".message.assistant .markdownBody pre").last();
    await expect(pre).toBeVisible();

    const copyBtn = pre.locator(".copyCode");

    // move mouse away so no hover state bleeds in
    await page.mouse.move(0, 0);
    await expect(copyBtn).toBeHidden();

    await pre.hover();
    await expect(copyBtn).toBeVisible();

    // before click: copy state
    await expect(copyBtn).toHaveAttribute("data-icon", "copy");

    await copyBtn.click();

    // after click: check state
    await expect(copyBtn).toHaveAttribute("data-icon", "check");
  });

  test("copy button reverts to copy icon after timeout", async ({ page }) => {
    await page.goto("/");
    await page.locator("#prompt").fill("please return markdown");
    await page.locator("#primaryButton").click();

    const pre = page.locator(".message.assistant .markdownBody pre").last();
    await expect(pre).toBeVisible();
    await pre.hover();
    const copyBtn = pre.locator(".copyCode");
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    await expect(copyBtn).toHaveAttribute("data-icon", "check");

    await page.waitForTimeout(2000);
    await expect(pre.locator(".copyCode")).toHaveAttribute("data-icon", "copy");
  });
});

// Minimal valid 1x1 transparent PNG
const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test.describe("context compaction", () => {
  test("shows context meter compaction progress and handles cancellation", async ({ page }) => {
    let abortRequested = false;
    await page.route("**/api/compaction/abort", async (route) => {
      abortRequested = true;
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true, sessionId: "mock-current" }) });
    });
    await page.addInitScript(() => {
      const fakeSockets: any[] = [];
      (window as any).__piWebSockets = fakeSockets;
      class FakeWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readyState = FakeWebSocket.OPEN;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onclose: ((event: Event) => void) | null = null;
        constructor() {
          super();
          fakeSockets.push(this);
          queueMicrotask(() => {
            const event = new Event("open");
            this.dispatchEvent(event);
            this.onopen?.(event);
          });
        }
        send() {}
        close() {
          this.readyState = FakeWebSocket.CLOSED;
          const event = new Event("close");
          this.dispatchEvent(event);
          this.onclose?.(event);
        }
        emit(value: unknown) {
          const event = new MessageEvent("message", { data: JSON.stringify(value) });
          this.dispatchEvent(event);
          this.onmessage?.(event);
        }
      }
      (window as any).WebSocket = FakeWebSocket as any;
    });

    await page.goto("/");
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
    await page.evaluate(() => (window as any).__piWebSockets.at(-1).emit({ type: "pi_event", event: { type: "compaction_start", reason: "manual" } }));

    await expect(page.locator("#contextMeter")).toHaveClass(/compacting/);
    await expect(page.locator("#contextMeterLabel")).toHaveText("compacting");
    await expect(page.locator(".message.system.compaction")).toHaveCount(0);

    expect(abortRequested).toBe(false);
    await page.evaluate(() => (window as any).__piWebSockets.at(-1).emit({ type: "pi_event", event: { type: "compaction_end", reason: "manual", aborted: true } }));
    const compaction = page.locator(".message.system.compaction").last();
    await expect(compaction).toContainText("Compaction cancelled.");
    await expect(page.locator("#contextMeter")).not.toHaveClass(/compacting/);
  });

  test("renders completed compaction summaries", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
    await page.locator("#prompt").fill("compact context");
    await page.locator("#primaryButton").click();

    const compaction = page.locator(".message.system.compaction").last();
    await expect(compaction).toContainText("Context compacted from 12,345 tokens.");
    await expect(compaction).toContainText("Mock compacted context summary.");
  });
});

test.describe("image rendering", () => {
  async function submitPrompt(page: Page) {
    const send = page.locator("#primaryButton");
    await expect(send).toBeEnabled();
    await send.click();
  }

  test.beforeAll(async () => {
    const artifactDir = join(process.cwd(), ".pi", "web", "artifacts");
    const htmlPreview = `<!doctype html><html><body>
<h1>HTML artifact</h1>
<p id="static">Rendered in a sandboxed iframe.</p>
<p id="script-status">script did not run</p>
<script>
  const statuses = [];
  document.getElementById("script-status").textContent = "script ran";
  try {
    parent.document.body.dataset.artifactAccess = "unexpected";
    statuses.push("parent accessible");
  } catch (error) {
    statuses.push("parent blocked");
  }
  try {
    localStorage.getItem("pi-web-token");
    statuses.push("localStorage accessible");
  } catch (error) {
    statuses.push("localStorage blocked");
  }
  try {
    statuses.push(document.cookie ? "cookies visible" : "cookies empty");
  } catch (error) {
    statuses.push("cookies blocked");
  }
  const list = document.createElement("ul");
  list.id = "sandbox-status";
  for (const status of statuses) {
    const item = document.createElement("li");
    item.textContent = status;
    list.append(item);
  }
  document.body.append(list);
</script>
</body></html>`;
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "e2e-test.png"), VALID_PNG);
    await writeFile(join(artifactDir, "report.md"), "# Artifact report\n\nThis **markdown** artifact renders inline.\n\n```ts\nconst preview = true;\n```\n");
    await writeFile(join(artifactDir, "preview.html"), htmlPreview);
    await writeFile(join(artifactDir, "e2e-video-artifact.webm"), Buffer.from([]));
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#statusTitle")).toHaveText("Current mock session");
    await expect(page.locator("#connectionStatus")).toBeHidden();
  });

  test("renders markdown artifact links inline", async ({ page }) => {
    await page.locator("#prompt").fill("show markdown artifact");
    await submitPrompt(page);

    const preview = page.locator(".artifactPreview--markdown").last();
    await expect(preview.locator(".artifactPreviewTitle")).toHaveText("report.md");
    await expect(preview.locator(".artifactPreviewContent h1")).toHaveText("Artifact report");
    await expect(preview.locator(".artifactPreviewContent strong")).toHaveText("markdown");
    await expect(preview.locator(".artifactPreviewContent pre code")).toContainText("const preview = true;");
  });

  test("opens markdown artifacts in a rendered preview page", async ({ page }) => {
    await page.locator("#prompt").fill("show markdown artifact");
    await submitPrompt(page);

    const open = page.locator(".artifactPreview--markdown").last().getByRole("link", { name: "Open" });
    await expect(open).toHaveAttribute("href", /\/artifact-preview\.html\?src=%2Fapi%2Fartifacts%2Freport\.md/);

    const href = await open.getAttribute("href");
    expect(href).toBeTruthy();
    await page.goto(href!);

    await expect(page.locator("#artifactPreviewTitle")).toHaveText("report.md");
    await expect(page.getByRole("button", { name: "Back" })).toHaveClass(/artifactPreviewPageAction/);
    await expect(page.getByRole("link", { name: "Raw" })).toHaveClass(/artifactPreviewPageAction/);
    await expect(page.locator("#artifactPreviewBody h1")).toHaveText("Artifact report");
    await expect(page.locator("#artifactPreviewBody strong")).toHaveText("markdown");
    await expect(page.locator("#artifactPreviewBody pre code")).toContainText("const preview = true;");
    await expect(page.locator("html")).toHaveCSS("overflow-y", "auto");
    await expect(page.locator("body")).toHaveCSS("overflow-y", "auto");
  });

  test("renders html artifact links in a sandboxed iframe", async ({ page }) => {
    await page.locator("#prompt").fill("show html artifact");
    await submitPrompt(page);

    const preview = page.locator(".artifactPreview--html").last();
    await expect(preview.locator(".artifactPreviewTitle")).toHaveText("preview.html");
    const frame = preview.locator("iframe.artifactPreviewFrame");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frame).not.toHaveAttribute("sandbox", /allow-same-origin/);
    await expect(frame).toHaveAttribute("src", "/api/artifacts/preview.html");
    const artifactFrame = frame.contentFrame();
    await expect(artifactFrame.locator("#script-status")).toHaveText("script ran");
    await expect(artifactFrame.locator("#sandbox-status")).toContainText("parent blocked");
    await expect(artifactFrame.locator("#sandbox-status")).toContainText("localStorage blocked");
    await expect(artifactFrame.locator("#sandbox-status")).toContainText(/cookies (empty|blocked)/);
  });

  test("renders video artifact links inline", async ({ page }) => {
    await page.locator("#prompt").fill("show video artifact");
    await submitPrompt(page);

    const preview = page.locator(".artifactPreview--video").last();
    await expect(preview.locator(".artifactPreviewTitle")).toHaveText("e2e-video-artifact.webm");
    const video = preview.locator("video.artifactPreviewVideo");
    await expect(video).toBeVisible();
    await expect(video.locator("source")).toHaveAttribute("src", "/api/artifacts/e2e-video-artifact.webm");
    await expect(video.locator("source")).toHaveAttribute("type", "video/webm");
  });

  test("image actions appear on hover with fullscreen, download and open buttons", async ({ page }) => {
    await page.locator("#prompt").fill("show artifact");
    await page.locator("#primaryButton").click();

    const frame = page.locator(".message.assistant .imageFrame").last();
    await expect(frame).toBeVisible();

    // move mouse away so no hover state bleeds in
    await page.mouse.move(0, 0);
    const actions = frame.locator(".imageActions");
    await expect(actions).toBeHidden();

    await frame.hover();
    await expect(actions).toBeVisible();

    await expect(frame.locator('[title="Fullscreen"]')).toBeVisible();
    await expect(frame.locator('[title="Download"]')).toBeVisible();
    await expect(frame.locator('[title="Open in new tab"]')).toBeVisible();
  });

  test("fullscreen button opens overlay with image", async ({ page }) => {
    await page.locator("#prompt").fill("show artifact");
    await page.locator("#primaryButton").click();

    const frame = page.locator(".message.assistant .imageFrame").last();
    await expect(frame).toBeVisible();
    await frame.hover();
    await frame.locator('[title="Fullscreen"]').click();

    const overlay = page.locator(".imageOverlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator("img")).toBeVisible();
  });

  test("overlay closes when clicked", async ({ page }) => {
    await page.locator("#prompt").fill("show artifact");
    await page.locator("#primaryButton").click();

    const frame = page.locator(".message.assistant .imageFrame").last();
    await expect(frame).toBeVisible();
    await frame.hover();
    await frame.locator('[title="Fullscreen"]').click();

    const overlay = page.locator(".imageOverlay");
    await expect(overlay).toBeVisible();
    await overlay.click();
    await expect(overlay).toHaveCount(0);
  });

  test("image is constrained and does not overflow the message", async ({ page }) => {
    await page.locator("#prompt").fill("show artifact");
    await page.locator("#primaryButton").click();

    const img = page.locator(".message.assistant .imageFrame img").last();
    await expect(img).toBeVisible();

    const imgBox = await img.boundingBox();
    const msgBox = await page.locator(".message.assistant").last().boundingBox();
    expect(imgBox).toBeTruthy();
    expect(msgBox).toBeTruthy();
    expect(imgBox!.width).toBeLessThanOrEqual(msgBox!.width + 1);
  });
});
