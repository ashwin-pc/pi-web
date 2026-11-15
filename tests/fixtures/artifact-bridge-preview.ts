import type { PiWebContribution } from "../../src/extensions.js";

/** Non-STL, model-free fixture: completion event is scheduled after the reply. */
export const artifactBridgePreview: Extract<PiWebContribution, { slot: "artifact-preview" }> = {
  slot: "artifact-preview", kind: "rendered", title: "Notes bridge", match: { extensions: [".gcode"] },
  render: () => ({ artifactBridge: true, html: `<!doctype html><title>Notes bridge</title>
    <button id="request" disabled>Request echo</button><p id="reply">Waiting for bridge</p><p id="event">No event</p>
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
        if (d.type === 'response') document.querySelector('#reply').textContent = d.result.text;
        if (d.type === 'event') document.querySelector('#event').textContent = d.event.text;
        if (d.type === 'closed') document.querySelector('#reply').textContent = 'Closed';
        if (d.type !== 'closed') port.postMessage({type:'ack'});
      };
      port.start(); port.postMessage({type:'ready'});
      document.querySelector('#request').disabled = false;
      document.querySelector('#request').onclick = () => port.postMessage({type:'request',id:'echo',command:'echo',payload:{text:'Reply completed'}});
    });
    </script>` }),
  connect: (_artifact, { signal, emit }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    return { request: ({ command, payload }, { signal: requestSignal }) => {
      requestSignal.throwIfAborted();
      if (command !== "echo") throw new Error("Unsupported command");
      timer = setTimeout(() => emit({ text: "Asynchronous event after reply" }), 100);
      return payload ?? null;
    } };
  },
};
