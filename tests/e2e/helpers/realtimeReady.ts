import type { Page } from "@playwright/test";

/** Register before navigation: a rendered page is not yet a subscribed client.
 * Mock realtime events are deliberately non-durable, so wait for the server's
 * hello frame before publishing events that the test expects the page to see. */
export function nextRealtimeHello(page: Page): Promise<void> {
  return page.waitForEvent("websocket", socket => new URL(socket.url()).pathname === "/ws")
    .then(async socket => {
      await socket.waitForEvent("framereceived", {
        predicate: frame => {
          try { return JSON.parse(String(frame.payload)).type === "hello"; }
          catch { return false; }
        },
      });
    });
}
