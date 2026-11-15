import type { PiWebContribution } from "../../src/extensions.js";

/** Non-STL, model-free fixture: completion event is scheduled after the reply. */
export const artifactBridgePreview: Extract<PiWebContribution, { slot: "artifact-preview" }> = {
  slot: "artifact-preview", kind: "rendered", title: "Notes bridge", match: { extensions: [".gcode"] },
  render: () => ({ artifactBridge: true, html: `<!doctype html><title>Notes bridge</title>
    <input id="draft" aria-label="Preview draft" value=""><button id="request" disabled>Request echo</button><button id="slow" disabled>Slow request</button><p id="connection">Waiting for bridge</p><p id="reply">Waiting for bridge</p><p id="event">No event</p>
    <script>
    let port;
    addEventListener('message', e => {
      if (e.source === parent && e.data?.type === 'pi-artifact-stream' && e.ports[0]) {
        const source = e.ports[0];
        source.onmessage = e => {
          if (e.data.type === 'chunk') source.postMessage({type:'ack',id:e.data.id,bytes:e.data.bytes.byteLength});
          if (e.data.type === 'end') source.postMessage({type:'complete'});
        };
        source.start(); source.postMessage({type:'ready',streamVersion:2}); return;
      }
      if (e.source !== parent || e.data?.type !== 'pi-artifact-bridge' || port || !e.ports[0]) return;
      port = e.ports[0];
      port.onmessage = e => {
        const d = e.data;
        if (d.type === 'connection-state') {
          document.querySelector('#connection').textContent = d.state;
          document.querySelector('#request').disabled = d.state !== 'ready';
          document.querySelector('#slow').disabled = d.state !== 'ready';
        }
        if (d.type === 'error') document.querySelector('#reply').textContent = d.error.message;
        if (d.type === 'response') document.querySelector('#reply').textContent = d.result.text;
        if (d.type === 'event') document.querySelector('#event').textContent = d.event.text;
        if (d.type === 'closed') document.querySelector('#reply').textContent = 'Closed';
        if (d.type !== 'closed') port.postMessage({type:'ack'});
      };
      port.start(); port.postMessage({type:'ready'});
      document.querySelector('#slow').onclick = () => port.postMessage({type:'request',id:'slow',command:'wait',payload:{text:'Slow completed'}});
      document.querySelector('#request').onclick = () => port.postMessage({type:'request',id:'echo',command:'echo',payload:{text:'Reply completed'}});
    });
    </script>` }),
  connect: (_artifact, { signal, emit }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    return { request: async ({ command, payload }, { signal: requestSignal }) => {
      requestSignal.throwIfAborted();
      if (command === "wait") await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(delay); reject(new Error("Cancelled")); };
        const delay = setTimeout(() => { requestSignal.removeEventListener("abort", abort); resolve(); }, 10_000);
        requestSignal.addEventListener("abort", abort, { once: true });
      });
      if (command !== "echo" && command !== "wait") throw new Error("Unsupported command");
      timer = setTimeout(() => emit({ text: "Asynchronous event after reply" }), 100);
      return payload ?? null;
    } };
  },
};
