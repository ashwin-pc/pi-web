// The VR view's lazy chunk: loads what the City needs through the client
// state layer, installs the live adapter, then evaluates the City scene
// (three.js) into the root-view element. Nothing here is in the main bundle.
import "./vrView.css";
import { createCityClient } from "./cityClient.js";
import { installClient } from "./city/client.js";
import { host } from "./city/host.js";
import type { RootViewContext } from "../rootView.js";

function chrome(el: HTMLElement, exitHref: string) {
  const top = document.createElement("div");
  top.className = "vrChrome";
  top.id = "topBar";
  top.innerHTML = `
    <div class="vrTitle">pi-web · City <span class="tag">VR</span></div>
    <div class="vrKeys"><b>WASD</b> fly · <b>Q E</b> down / up · drag: look · right-drag: pan · wheel: altitude · <b>← →</b> next session · <b>N</b> what needs me · <b>Esc</b> back to the city · <b>F</b> fly to it · <b>H</b> home · <b>T</b> tabletop · <b>M</b> reduce motion · <b>V</b> vignette</div>
    <div class="vrRow"><span id="xrStatus">Checking for a headset…</span><a class="vrBack" id="vrBack" href="${exitHref}">Back to chat</a><button id="enterVR" type="button" disabled>Enter VR</button></div>`;
  const message = document.createElement("div");
  message.className = "vrChrome";
  message.id = "xrMsg";
  message.hidden = true;
  message.setAttribute("role", "status");
  el.append(top, message);
  return [top, message];
}

export async function mountVrApp(el: HTMLElement, context: RootViewContext, progress: (text: string) => void): Promise<() => void> {
  const sessionId = new URLSearchParams(location.search).get("sessionId");
  const cityClient = createCityClient(context.client, { initialSessionId: sessionId });
  await cityClient.prepare(progress);
  if (!cityClient.sessions.getSnapshot().length) {
    cityClient.dispose();
    throw new Error("there are no sessions yet. Start one in the chat view first.");
  }
  progress("Building the city…");
  const exitHref = `/${location.search}`;
  const parts = chrome(el, exitHref);
  installClient(cityClient);
  host.el = el;
  host.exit = context.exit;
  // Evaluated once per page: the City's modules are singletons, and leaving the view navigates away.
  const city = await import("./city/main.js");
  return () => {
    city.disposeCity();
    cityClient.dispose();
    for (const part of parts) part.remove();
  };
}
