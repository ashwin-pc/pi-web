import { watchArtifactConnection } from "./artifactStreamLifecycle.js";
import { createBridgeDelivery } from "./artifactBridgeDelivery.js";
import { createBridgeCommands } from "./artifactBridgeCommands.js";
import { createBridgeConnection, type BridgeState } from "./artifactBridgeConnection.js";
import type { BridgeAuthority } from "./artifactBridgeHttp.js";
export { receiveArtifactBridgeEvent, setArtifactBridgeSocket } from "./artifactBridgeConnection.js";

/** Preview lifetime owns one iframe/port; socket lifetimes own replaceable, non-replayed attempts. */
export function mountArtifactBridge(options: BridgeAuthority & {
  frame: HTMLIFrameElement; current: () => boolean;
  onReopen?: () => void; onState?: (state: BridgeState) => void;
}) {
  const { frame } = options;
  let closed = false, started = false, attached = frame.isConnected;
  let unwatch = () => {};
  let attachment: ReturnType<typeof setTimeout> | undefined;
  const current = () => !closed && options.current();
  const send = (data: Record<string, unknown>) => {
    if (!current()) { close(); return; }
    delivery.send(data);
  };
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(attachment); unwatch();
    frame.removeEventListener("load", start);
    connection.dispose(); delivery.dispose(); options.onState?.("closed");
  };
  const delivery = createBridgeDelivery(close);
  const connection = createBridgeConnection({ ...options, current, send,
    state: state => options.onState?.(state),
    reset: () => { delivery.reset(); commands.reset(); },
  });
  const commands = createBridgeCommands({ connection, current, send,
    ready: delivery.ready, ack: delivery.ack, close,
    reopen: () => { close(); options.onReopen?.(); },
  });
  const start = () => {
    if (started || !current()) { close(); return; }
    started = true; attached = frame.isConnected; clearTimeout(attachment);
    const channel = new MessageChannel();
    delivery.attach(channel.port1);
    channel.port1.onmessage = event => commands.dispatch(event.data);
    channel.port1.start();
    try { frame.contentWindow?.postMessage({ type: "pi-artifact-bridge", version: 1 }, "*", [channel.port2]); }
    catch { channel.port2.close(); close(); return; }
    connection.start();
  };
  const check = () => {
    if (frame.isConnected) attached = true;
    if (!current() || (attached && !frame.isConnected)) close();
  };
  unwatch = watchArtifactConnection(check);
  frame.addEventListener("load", start);
  attachment = setTimeout(close, 30_000);
  check();
  return close;
}
