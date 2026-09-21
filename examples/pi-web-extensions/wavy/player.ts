import { buildTimeline, chooseOccurrence, selectTimelineRange, validateReviewRequest, type SourceSelection, type TimelineNote } from "./player-model.js";

declare const ABCJS: any;
declare global { interface Window { piWebPreview?: any; __wavyTest?: any } }

interface PreviewData {
  title: string; revision: number; artifactPath: string; scoreSha256?: string; score?: string;
  lyrics: string; style: string; settings: Record<string, unknown>; warnings: string[];
  revisions: any[]; sources: any[]; takes: any[]; files: any[];
}
interface PlayerNote extends TimelineNote { elements: Element[] }

const encoded = document.documentElement.dataset.wavy || "";
const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
const data: PreviewData = JSON.parse(new TextDecoder().decode(bytes));
const one = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T;
const many = (selector: string) => [...document.querySelectorAll(selector)];
const setText = (selector: string, value: unknown) => { one(selector).textContent = String(value ?? ""); };
const appendText = (root: string | Element, tag: string, value: unknown, className?: string) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = String(value ?? "");
  (typeof root === "string" ? one(root) : root).append(element);
  return element;
};
const bridge = window.piWebPreview?.version === 1 ? window.piWebPreview : undefined;
let previewDisposed = false;
const previewLifetime = new AbortController();
interface PreviewViewport { width: number; height: number; visible: { left: number; top: number; right: number; bottom: number } }
let hostViewport: PreviewViewport | undefined = bridge?.viewport;
function visibleFrameBounds() {
  const v = bridge?.viewport || hostViewport;
  if (!v || !v.visible || ![v.width, v.height, v.visible.left, v.visible.top, v.visible.right, v.visible.bottom].every(Number.isFinite) || v.width <= 0 || v.height <= 0) {
    return { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  }
  return {
    left: Math.max(0, Math.min(innerWidth, v.visible.left)),
    top: Math.max(0, Math.min(innerHeight, v.visible.top)),
    right: Math.max(0, Math.min(innerWidth, v.visible.right)),
    bottom: Math.max(0, Math.min(innerHeight, v.visible.bottom)),
  };
}

function applyTheme(theme: any) {
  if (previewDisposed || !theme || typeof theme !== "object") return;
  for (const [key, value] of Object.entries(theme.tokens || {})) if (typeof value === "string" && key.startsWith("--pi-web-")) document.documentElement.style.setProperty(key, value);
  if (theme.colorScheme === "light" || theme.colorScheme === "dark") document.documentElement.style.colorScheme = theme.colorScheme;
  if (["comfortable", "compact", "minimal"].includes(theme.density)) document.documentElement.dataset.density = theme.density;
}
applyTheme(bridge?.theme);
const unsubscribeTheme = bridge?.onThemeChange?.(applyTheme);

function formatTime(seconds: number) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`; }
function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, milliseconds) / 1000;
  return seconds < 10 ? `${seconds.toFixed(seconds < 1 ? 2 : 1)}s` : formatTime(seconds);
}
function safeScore(score: string) { return !/(?:https?:|javascript:|%%\s*(?:beginhtml|header|footer|text|center)|\[\s*[Uu][Rr][Ll]:)/i.test(score); }

setText("#title", data.title);
setText("#summary", `Revision ${data.revision} · ${data.score ? "written music available" : "draft without a score"} · ${data.takes.length} take${data.takes.length === 1 ? "" : "s"}`);
setText("#style", data.style || "No style direction yet.");
setText("#lyrics", data.lyrics || "No lyrics yet.");
data.warnings.forEach(warning => appendText("#warnings", "li", warning));
if (!data.warnings.length) (one("#warnings") as HTMLElement).hidden = true;
Object.entries(data.settings).forEach(([key, value]) => appendText("#settings", "span", `${key.replace(/([A-Z])/g, " $1")}: ${value}`, "pill"));
data.files.forEach(file => { const item = appendText("#files", "div", "", "item"); appendText(item, "div", `${file.path} · ${file.bytes.toLocaleString()} bytes`); appendText(item, "div", `sha256 ${file.sha}`, "meta"); });
data.revisions.slice().reverse().forEach(revision => { const item = appendText("#history", "div", `v${revision.id} · ${revision.summary}`, "item"); appendText(item, "div", `${revision.origin} · ${new Date(revision.createdAt).toLocaleString()}`, "meta"); });
if (!data.revisions.length) appendText("#history", "div", "No saved revision history.", "empty");
data.sources.forEach(source => { const item = appendText("#sources", "div", source.label, "item"); appendText(item, "div", `${source.audio.path} · ${new Date(source.createdAt).toLocaleString()}`, "meta"); appendText(item, "div", `${source.transcription ? "Transcription retained" : "Not transcribed"}${source.score ? " · derived score retained" : ""}`, "meta"); });
if (!data.sources.length) appendText("#sources", "div", "No source recordings.", "empty");

let selectedTake = (() => { const index = data.takes.findLastIndex(take => take.audio); return index >= 0 ? index : data.takes.length - 1; })();
let recordingUrl: string | undefined;
let recordingLoadGeneration = 0;
let recordingAbort: AbortController | undefined;
const recording = one<HTMLAudioElement>("#recording");
const mediaNotice = one<HTMLElement>("#mediaNotice");
const takeSelect = one<HTMLSelectElement>("#takeSelect");
const loadRecordingButton = one<HTMLButtonElement>("#loadRecording");

function stopRecording() { recording.pause(); }
function clearRecording() {
  recordingAbort?.abort(); recordingAbort = undefined;
  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  recordingUrl = undefined; recording.removeAttribute("src"); recording.load(); recording.hidden = true;
}
function showTake(index: number) {
  selectedTake = index; takeSelect.value = String(index); clearRecording(); recordingLoadGeneration++;
  const take = data.takes[index];
  if (!take) { setText("#selectedTakeMeta", "No generated takes."); setText("#selectedTakeWarnings", ""); loadRecordingButton.disabled = true; mediaNotice.textContent = "No generated takes yet."; return; }
  setText("#selectedTakeMeta", `Revision ${take.revision} · ${take.status}`);
  const root = one("#selectedTakeWarnings"); root.replaceChildren();
  if (take.revision !== data.revision) appendText(root, "div", "Older revision: recording does not contain current written changes.", "warn");
  if (take.truncated === true) appendText(root, "div", "Truncated at generation safety ceiling.", "warn");
  if (take.error) appendText(root, "div", take.error, "danger");
  loadRecordingButton.disabled = !take.audio; mediaNotice.className = "meta";
  mediaNotice.textContent = take.audio ? "Selected but not loaded. Press Load recording to fetch it." : "This take has no playable audio.";
}
async function loadRecording(index = selectedTake) {
  if (previewDisposed) return;
  const take = data.takes[index]; if (!take?.audio) return showTake(index);
  player.stop(); stopRecording(); showTake(index); const generation = ++recordingLoadGeneration;
  if (!bridge || !take.audio.assetId) { mediaNotice.textContent = "Recording playback needs a supported host asset. Use the ordinary recording link in the parent chat."; return; }
  mediaNotice.className = "meta"; mediaNotice.textContent = "Loading recording…";
  const controller = new AbortController(); recordingAbort = controller;
  try {
    const blob = await bridge.loadAsset(take.audio.assetId, { signal: controller.signal });
    if (generation !== recordingLoadGeneration || controller.signal.aborted) return;
    recordingUrl = URL.createObjectURL(blob); recording.src = recordingUrl; recording.hidden = false; recording.load();
    mediaNotice.textContent = "Ready. Generated audio is not synchronized to the written score.";
  } catch (error: any) {
    if (!controller.signal.aborted) { mediaNotice.className = "warn"; mediaNotice.textContent = `Recording unavailable: ${error?.message || error}.`; }
  } finally { if (recordingAbort === controller) recordingAbort = undefined; }
}
data.takes.forEach((take, index) => {
  const option = document.createElement("option"); option.value = String(index); option.textContent = `Take ${index + 1} · revision ${take.revision} · ${take.status}${take.audio ? "" : " · no audio"}`; takeSelect.append(option);
  const wrap = appendText("#takes", "div", "", "take"); appendText(wrap, "div", `Take ${index + 1} of ${data.takes.length}`, "take-title"); appendText(wrap, "div", `${take.status} · ${take.id}`, "meta");
  appendText(wrap, "div", `revision ${take.revision} · seed ${take.seed} · ${take.precision}${take.durationSeconds != null ? ` · ${formatTime(take.durationSeconds)}` : ""}`, "meta");
  if (take.revision !== data.revision) appendText(wrap, "div", "Older revision: recording does not contain current written changes.", "warn");
  if (take.truncated === true) appendText(wrap, "div", "Truncated at generation safety ceiling.", "warn"); if (take.error) appendText(wrap, "div", take.error, "danger");
});
takeSelect.disabled = !data.takes.length; takeSelect.onchange = () => showTake(Number(takeSelect.value)); loadRecordingButton.onclick = () => void loadRecording(); showTake(selectedTake);
recording.addEventListener("play", () => player.stop()); recording.addEventListener("error", () => { mediaNotice.className = "warn"; mediaNotice.textContent = "This recording could not be decoded. Try the host-player link on its take."; });

let tune: any;
let notes: PlayerNote[] = [];
let totalMs = 0;
let rollBars:Array<{measure:number;ms:number}>=[];
let selection: SourceSelection | undefined;
let selectionAnchorId: string | undefined;
let cursorId: string | undefined;
let selecting = false;
const elementNotes = new Map<Element, PlayerNote[]>();
const scorePaper = one<HTMLElement>("#scorePaper");
const notationRoot=one<HTMLElement>("#notation");
const SCORE_WIDTH=760,MIN_SCORE_SCALE=.65,MAX_SCORE_SCALE=2.5;
let scoreScale=1,suppressScoreActivationUntil=0;
type TouchPoint={x:number;y:number};
type GestureState=
  |{mode:"idle"}
  |{mode:"tap-pan";pointerId:number;x:number;y:number;scrollLeft:number;scrollTop:number;tapEligible:boolean}
  |{mode:"pinch";pointerIds:[number,number];distance:number;scale:number;scaleY:number;contentX:number;contentY:number};
type ViewportGestureOptions={root:HTMLElement;scale:()=>number;scaleY?:()=>number;contentAt:(x:number,y:number)=>{x:number;y:number};applyScale:(scale:number,scaleY:number,anchor:{x:number;y:number;contentX:number;contentY:number})=>void;tap:(event:PointerEvent)=>void;suppress:(milliseconds:number)=>void};
function attachViewportGestures(options:ViewportGestureOptions){
  const pointers=new Map<number,TouchPoint>();let state:GestureState={mode:"idle"};
  const listenerOptions = { capture: true, signal: previewLifetime.signal };
  previewLifetime.signal.addEventListener("abort", () => {
    const captured = [...pointers.keys()];
    pointers.clear(); state = { mode: "idle" };
    for (const pointerId of captured) {
      if (options.root.hasPointerCapture(pointerId)) options.root.releasePointerCapture(pointerId);
    }
  }, { once: true });
  const beginPinch=()=>{const ids=[...pointers.keys()].slice(0,2)as[number,number],a=pointers.get(ids[0])!,b=pointers.get(ids[1])!,rect=scorePaper.getBoundingClientRect(),x=(a.x+b.x)/2-rect.left,y=(a.y+b.y)/2-rect.top,content=options.contentAt(x,y);state={mode:"pinch",pointerIds:ids,distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),scale:options.scale(),scaleY:options.scaleY?.()??options.scale(),contentX:content.x,contentY:content.y};options.suppress(700);};
  const continueRemaining=()=>{if(pointers.size>=2){beginPinch();return;}const remaining=[...pointers.entries()][0];state=remaining?{mode:"tap-pan",pointerId:remaining[0],x:remaining[1].x,y:remaining[1].y,scrollLeft:scorePaper.scrollLeft,scrollTop:scorePaper.scrollTop,tapEligible:false}:{mode:"idle"};};
  options.root.addEventListener("pointerdown",event=>{if(event.pointerType!=="touch"||pointers.size>=2)return;event.preventDefault();options.root.setPointerCapture(event.pointerId);pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});if(pointers.size===1)state={mode:"tap-pan",pointerId:event.pointerId,x:event.clientX,y:event.clientY,scrollLeft:scorePaper.scrollLeft,scrollTop:scorePaper.scrollTop,tapEligible:true};else beginPinch();},listenerOptions);
  options.root.addEventListener("pointermove",event=>{if(!pointers.has(event.pointerId))return;event.preventDefault();pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});if(state.mode==="pinch"){const a=pointers.get(state.pointerIds[0]),b=pointers.get(state.pointerIds[1]);if(!a||!b)return;const rect=scorePaper.getBoundingClientRect(),x=(a.x+b.x)/2-rect.left,y=(a.y+b.y)/2-rect.top;const factor=Math.hypot(a.x-b.x,a.y-b.y)/state.distance;options.applyScale(state.scale*factor,state.scaleY*factor,{x,y,contentX:state.contentX,contentY:state.contentY});options.suppress(700);}else if(state.mode==="tap-pan"&&state.pointerId===event.pointerId){const dx=event.clientX-state.x,dy=event.clientY-state.y;if(Math.hypot(dx,dy)>8)state.tapEligible=false;scorePaper.scrollLeft=state.scrollLeft-dx;scorePaper.scrollTop=state.scrollTop-dy;if(!state.tapEligible)options.suppress(700);}},listenerOptions);
  const end=(event:PointerEvent,activate:boolean)=>{if(!pointers.has(event.pointerId))return;event.preventDefault();const mayActivate=activate&&state.mode==="tap-pan"&&state.pointerId===event.pointerId&&state.tapEligible&&pointers.size===1;pointers.delete(event.pointerId);if(mayActivate)options.tap(event);options.suppress(500);continueRemaining();updateHandles();};
  options.root.addEventListener("pointerup",event=>end(event,true),listenerOptions);options.root.addEventListener("pointercancel",event=>end(event,false),listenerOptions);options.root.addEventListener("lostpointercapture",event=>end(event as PointerEvent,false),listenerOptions);
  return{state:()=>structuredClone(state)};
}
let notationGestures:{state:()=>GestureState};
function applyScoreScale(next:number,anchor?:{x:number;y:number;contentX:number;contentY:number}){
  next=Math.max(MIN_SCORE_SCALE,Math.min(MAX_SCORE_SCALE,next));
  const x=anchor?.x??scorePaper.clientWidth/2,y=anchor?.y??scorePaper.clientHeight/2;
  const contentX=anchor?.contentX??(scorePaper.scrollLeft+x)/scoreScale,contentY=anchor?.contentY??(scorePaper.scrollTop+y)/scoreScale;
  scoreScale=next;notationRoot.style.width=`${SCORE_WIDTH*next}px`;
  const svg=notationRoot.querySelector<SVGSVGElement>("svg");if(svg){
    // ABCJS emits fixed width/height without a viewBox. Changing CSS dimensions alone
    // only enlarges the SVG canvas, leaving every note glyph at its original size.
    const width=Number(svg.getAttribute("width")),height=Number(svg.getAttribute("height"));
    if(!svg.hasAttribute("viewBox")&&width>0&&height>0)svg.setAttribute("viewBox",`0 0 ${width} ${height}`);
    svg.style.setProperty("width",`${SCORE_WIDTH*next}px`,"important");svg.style.height="auto";
    if(width>0&&height>0)notationRoot.style.height=`${SCORE_WIDTH*next*height/width}px`;
  }
  scorePaper.scrollLeft=contentX*next-x;scorePaper.scrollTop=contentY*next-y;
  const zoomReset=document.querySelector<HTMLButtonElement>("#zoomReset");if(zoomReset)zoomReset.textContent=`${Math.round(next*100)}%`;updateHandles();
}
let activeScoreView:"notation"|"roll"="notation";
function zoomBy(factor:number){if(activeScoreView==="roll")applyRollZoom(rollZoom*factor);else applyScoreScale(scoreScale*factor);placeComment();}
const zoomOut=document.querySelector<HTMLButtonElement>("#zoomOut"),zoomIn=document.querySelector<HTMLButtonElement>("#zoomIn"),zoomReset=document.querySelector<HTMLButtonElement>("#zoomReset");
if(zoomOut)zoomOut.onclick=()=>zoomBy(1/1.2);if(zoomIn)zoomIn.onclick=()=>zoomBy(1.2);if(zoomReset)zoomReset.onclick=()=>{if(activeScoreView==="roll")resetRollView();else applyScoreScale(1);placeComment();};
notationGestures=attachViewportGestures({root:notationRoot,scale:()=>scoreScale,contentAt:(x,y)=>({x:(scorePaper.scrollLeft+x)/scoreScale,y:(scorePaper.scrollTop+y)/scoreScale}),applyScale:(scale,_scaleY,anchor)=>applyScoreScale(scale,anchor),tap:event=>{const note=noteFromPoint(document.elementFromPoint(event.clientX,event.clientY),event.clientX,event.clientY);if(note)setCursor(note,event.shiftKey);},suppress:milliseconds=>{suppressScoreActivationUntil=performance.now()+milliseconds;}});
scorePaper.addEventListener("click",event=>{if(performance.now()<suppressScoreActivationUntil){event.preventDefault();event.stopImmediatePropagation();}},{capture:true});

function timingFor(visual: any[], startChar: number) { return visual.find(item => item.type === "event" && (item.startCharArray || [item.startChar]).includes(startChar)); }
function buildPlayerTimeline(renderedTune: any): PlayerNote[] {
  renderedTune.setTiming();
  const visual = renderedTune.noteTimings || [], flattened = renderedTune.setUpAudio({}), raw: any[] = [];
  (flattened.tracks || []).forEach((track: any[], trackIndex: number) => track.forEach(note => { if (note.cmd === "note") raw.push({ track: trackIndex, start: note.start, duration: note.duration, pitch: note.pitch, startChar: note.startChar, endChar: note.endChar, volume: note.volume }); }));
  const voiceDeclarations=[...String(data.score||"").matchAll(/(?:^|\n)\s*V:\s*([^\s%]+)|\[V:([^\]\s]+)/g)].map(match=>match[1]||match[2]);
  const declaredVoices=[...new Set(voiceDeclarations)];
  const meterLength=(meter:any)=>{if(meter?.type==="specified"&&meter.value?.[0])return Number(meter.value[0].num)/Number(meter.value[0].den);if(meter?.type==="cut_time")return 1;if(meter?.type==="common_time")return 1;return undefined;};
  const initialBarLength=renderedTune.getBarLength?.()||1, meterSegments=new Map<number,Array<{start:number;length:number;baseBar:number}>>();
  for(const line of renderedTune.lines||[])for(let staffIndex=0;staffIndex<(line.staff||[]).length;staffIndex++){const staff=line.staff[staffIndex],elements=(staff.voices||[]).flat(),start=Math.min(...elements.map((element:any)=>element.currentTrackWholeNotes).filter(Number.isFinite));if(!Number.isFinite(start))continue;const length=meterLength(staff.meter);if(!length)continue;const segments=meterSegments.get(staffIndex)||[],previous=segments.at(-1);if(!previous||previous.length!==length){const baseBar=previous?previous.baseBar+Math.floor((start-previous.start+1e-8)/previous.length):0;segments.push({start,length,baseBar});meterSegments.set(staffIndex,segments);}}
  const canonicalMeasure=(track:number,startMs:number)=>{const whole=startMs*(flattened.tempo||120)/(4*60000),segments=meterSegments.get(track)||[{start:0,length:initialBarLength,baseBar:0}],segment=[...segments].reverse().find(item=>item.start<=whole+1e-8)||segments[0];return segment.baseBar+Math.floor((whole-segment.start+1e-8)/segment.length);};
  const maxWhole=Math.max(0,...raw.map(item=>item.start+item.duration)),tempo=flattened.tempo||120,segments=meterSegments.get(0)||[{start:0,length:initialBarLength,baseBar:0}];rollBars=[];for(let segmentIndex=0;segmentIndex<segments.length;segmentIndex++){const segment=segments[segmentIndex],end=Math.min(maxWhole,segments[segmentIndex+1]?.start??maxWhole);for(let whole=segment.start;whole<end+1e-8;whole+=segment.length){const ms=whole*4*60000/tempo;if(ms<=maxWhole*4*60000/tempo+1)rollBars.push({measure:canonicalMeasure(0,ms),ms});}}rollBars=[...new Map(rollBars.map(bar=>[Math.round(bar.ms),bar])).values()].sort((a,b)=>a.ms-b.ms);
  const base = buildTimeline(raw, { tempo, measureFor: (track,_startChar,startMs) => canonicalMeasure(track,startMs),voiceLabelFor:track=>declaredVoices[track]||`Voice ${track+1}` });
  const selectable = (renderedTune.getSelectableArray?.() || []).map((item: any) => {
    const abc = item.absEl?.abcelem, match = String(item.svgEl?.getAttribute?.("class") || "").match(/(?:^|\s)abcjs-v(\d+)(?:\s|$)/);
    if (!abc || !match || !Number.isInteger(abc.startChar) || abc.startChar < 0) return undefined;
    const pitches = abc.pitches || [], startsTie = pitches.some((pitch: any) => pitch.startTie), endsTie = pitches.some((pitch: any) => pitch.endTie);
    return { start: abc.startChar, end: Math.max(abc.startChar + 1, abc.endChar ?? abc.startChar + 1), voiceId: `voice-${Number(match[1]) + 1}`, element: item.svgEl as Element, startsTie, endsTie };
  }).filter(Boolean) as Array<{start:number;end:number;voiceId:string;element:Element;startsTie:boolean;endsTie:boolean}>;
  const fragments = (renderedTune.lines || []).flatMap((line:any)=>(line.staff||[]).flatMap((staff:any,staffIndex:number)=>(staff.voices||[]).flatMap((voice:any)=>voice.filter((element:any)=>element.el_type==="note"&&!element.rest).map((element:any)=>({track:staffIndex,start:element.currentTrackWholeNotes,end:element.currentTrackWholeNotes+element.duration,startChar:element.startChar,endChar:element.endChar,tied:(element.pitches||[]).some((pitch:any)=>pitch.startTie||pitch.endTie)})))));
  return base.map(note=>{
    const track=Number(note.voiceId.slice(6))-1, attack=raw.find(item=>item.track===track&&item.startChar===note.start&&Math.abs((item.start*4*60000/(flattened.tempo||120))-note.startMs)<.5);
    const tied=attack?fragments.filter((fragment:any)=>fragment.track===track&&(fragment.startChar===note.start||(fragment.tied&&fragment.start<attack.start+attack.duration-1e-8&&fragment.end>attack.start+1e-8))):[];
    const ranges=(tied.length?tied.map((fragment:any)=>({start:fragment.startChar,end:fragment.endChar,voiceId:note.voiceId})):note.sourceRanges);
    const elements=selectable.filter(item=>item.voiceId===note.voiceId&&ranges.some((range:{start:number;end:number})=>range.start===item.start&&range.end===item.end)).map(item=>item.element);
    return {...note,sourceRanges:ranges,elements};
  });
}
function indexElements() { elementNotes.clear(); for (const note of notes) for (const element of note.elements) elementNotes.set(element, [...(elementNotes.get(element) || []), note]); }
function noteFromPoint(target: EventTarget | null, x: number, y: number): PlayerNote | undefined {
  let element = target instanceof Element ? target : undefined;
  if (element?.closest(".selection-handle,.comment-panel,.selection-actions")) return undefined;
  while (element && element !== one("#notation")) { const candidates = elementNotes.get(element); if (candidates?.length) return chooseOccurrence(notes, candidates[0].start, candidates[0].end, player.playheadMs) as PlayerNote | undefined; element = element.parentElement || undefined; }
  if (!(target instanceof Element)) return undefined;
  let best: { note: PlayerNote; distance: number } | undefined;
  for (const [svgElement, candidates] of elementNotes) { const rect = svgElement.getBoundingClientRect(); const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0; const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0; const distance = Math.hypot(dx, dy); if (distance <= 22 && (!best || distance < best.distance)) best = { note: candidates[0], distance }; }
  return best?.note;
}
function selectedVisualNotes(value: SourceSelection | undefined) {
  if(!value)return [];
  return notes.filter(note=>note.sourceRanges.some(source=>value.ranges.some(range=>range.voiceId===source.voiceId&&range.start<source.end&&range.end>source.start)));
}
function elementsForSelection(value: SourceSelection | undefined) {
  const selected = new Set<Element>();
  for (const note of selectedVisualNotes(value)) note.elements.forEach(element => {if((element as SVGGraphicsElement).getClientRects().length)selected.add(element);});
  return selected;
}
function paintState() {
  many(".wavy-selected,.wavy-cursor").forEach(element => element.classList.remove("wavy-selected", "wavy-cursor"));
  elementsForSelection(selection).forEach(element => element.classList.add("wavy-selected"));
  if(selection){const selectedIds=new Set(selection.playback.occurrenceIds);for(const note of notes)if(selectedIds.has(note.id))note.elements.filter(element=>element.classList.contains("roll-note")).forEach(element=>element.classList.add("wavy-selected"));}
  const cursor = notes.find(note => note.id === cursorId); cursor?.elements.forEach(element => element.classList.add("wavy-cursor"));
  const actions = one<HTMLElement>("#selectionActions"); actions.hidden = !selection;
  const commentButton=one<HTMLButtonElement>("#commentSelection"),editable=!!selection?.ranges.length;commentButton.disabled=!editable;commentButton.title=editable?"Comment on selected passage":"Audition-only accompaniment has no editable score source";commentButton.setAttribute("aria-label",editable?"Comment on selected passage":"Comment unavailable: selected accompaniment has no editable score source");
  if (selection) setText("#selectionLabel", `${selection.label} · ${formatDuration(selection.playback.endMs - selection.playback.startMs)}${editable?"":" · audition only"}`);
  updateHandles();
  if(typeof syncCommentSelection==="function")syncCommentSelection();
}
function setCursor(note: PlayerNote, extend: boolean) {
  cursorId = note.id;
  if (extend && selectionAnchorId) selection = selectTimelineRange(notes, selectionAnchorId, note.id);
  else if (selecting) { selectionAnchorId ||= note.id; selection = selectTimelineRange(notes, selectionAnchorId, note.id); }
  else selectionAnchorId = note.id;
  player.seek(note.startMs, player.playing);
  paintState();
}
function clearSelection() { selection = undefined; selectionAnchorId = cursorId; selecting = false; one<HTMLButtonElement>("#selectMode").setAttribute("aria-pressed", "false");player.disableLoop(); closeComment(false); paintState(); }

const handleStart = one<HTMLButtonElement>("#selectionStart");
const handleEnd = one<HTMLButtonElement>("#selectionEnd");
function positionHandle(handle: HTMLElement, note: PlayerNote | undefined) {
  const element = note?.elements.find(item=>(item as HTMLElement).getClientRects().length) as Element | undefined; if (!element) { handle.hidden = true; return; }
  const rect = element.getBoundingClientRect(), paper = scorePaper.getBoundingClientRect(); handle.hidden = false;
  handle.style.left = `${rect.left - paper.left + scorePaper.scrollLeft + rect.width / 2}px`; handle.style.top = `${rect.bottom - paper.top + scorePaper.scrollTop}px`;
}
function updateHandles() {
  if (!selection) { handleStart.hidden = handleEnd.hidden = true; return; }
  const selected = selectedVisualNotes(selection).filter(note=>note.elements.some(element=>(element as SVGGraphicsElement).getClientRects().length)); positionHandle(handleStart, selected[0]); positionHandle(handleEnd, selected.at(-1));
}
function attachHandle(handle: HTMLButtonElement, boundary: "start" | "end") {
  handle.addEventListener("pointerdown", event => { event.preventDefault(); handle.setPointerCapture(event.pointerId); scorePaper.dataset.adjusting = boundary; });
  handle.addEventListener("pointermove", event => {
    if (!handle.hasPointerCapture(event.pointerId) || !selectionAnchorId) return;
    const target = document.elementFromPoint(event.clientX, event.clientY); const note = noteFromPoint(target,event.clientX,event.clientY); if (!note) return;
    const current = selection!; const otherId = boundary === "start" ? current.playback.occurrenceIds.at(-1)! : current.playback.occurrenceIds[0];
    selection = selectTimelineRange(notes, otherId, note.id); cursorId = note.id; paintState();
  });
  const finish = (event: PointerEvent) => { if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); delete scorePaper.dataset.adjusting; };
  handle.addEventListener("pointerup", finish); handle.addEventListener("pointercancel", finish);
}
attachHandle(handleStart, "start"); attachHandle(handleEnd, "end");
scorePaper.addEventListener("scroll", updateHandles, { passive: true });
one("#notation").addEventListener("keydown", event => {
  const key = (event as KeyboardEvent).key; const currentIndex = Math.max(0, notes.findIndex(note => note.id === cursorId)); let next = currentIndex;
  if (key === "ArrowRight") next = Math.min(notes.length - 1, currentIndex + 1); else if (key === "ArrowLeft") next = Math.max(0, currentIndex - 1); else if (key === "Enter") { void player.playFromCursor(); event.preventDefault(); return; } else return;
  event.preventDefault(); setCursor(notes[next], (event as KeyboardEvent).shiftKey);
});
one<HTMLButtonElement>("#selectMode").onclick = () => { selecting = !selecting; one<HTMLButtonElement>("#selectMode").setAttribute("aria-pressed", String(selecting)); if (selecting && cursorId) { selectionAnchorId = cursorId; selection = selectTimelineRange(notes, cursorId, cursorId); } paintState(); };
one<HTMLButtonElement>("#clearSelection").onclick = clearSelection;

const sampleMidi: Record<string, number> = { C1:24,"F#1":30,C2:36,"F#2":42,C3:48,"F#3":54,C4:60,"F#4":66,C5:72,"F#5":78,C6:84,"F#6":90,C7:96,"F#7":102,C8:108 };
class ScorePlayer {
  context?: AudioContext; nodes = new Set<AudioScheduledSourceNode>(); buffers = new Map<string, AudioBuffer>(); timer = 0; generation = 0; abort?: AbortController;
  playing = false; looping = false; playheadMs = 0; originPlayheadMs = 0; windowStart = 0; windowEnd = 0; contextStart = 0; cycleDurationMs = 0; nextCycleContext = 0;
  async loadSamples(signal: AbortSignal) {
    if (!bridge) return false; const needed = [...new Set(notes.flatMap(note => note.pitches).map(pitch => Object.entries(sampleMidi).reduce((a,b) => Math.abs(b[1]-pitch)<Math.abs(a[1]-pitch)?b:a)[0]))].filter(name => !this.buffers.has(name));
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, needed.length) }, async () => {
      while (cursor < needed.length && !signal.aborted && !previewDisposed) {
        const name = needed[cursor++];
        const blob = await bridge.loadAsset(`piano-${name.replace("#", "s")}`, { signal });
        if (signal.aborted || previewDisposed) return;
        const bytes = await blob.arrayBuffer();
        if (signal.aborted || previewDisposed) return;
        const decoded = await this.context!.decodeAudioData(bytes);
        if (signal.aborted || previewDisposed) return;
        this.buffers.set(name, decoded);
      }
    }));
    return !signal.aborted && !previewDisposed;
  }
  stop(reset = false) {
    this.generation++; this.abort?.abort(); this.abort = undefined; this.nodes.forEach(node => { try { node.stop(); } catch {} }); this.nodes.clear(); clearInterval(this.timer); this.timer = 0; this.playing = false;
    many(".active-note").forEach(element => element.classList.remove("active-note")); one<HTMLButtonElement>("#scorePlay").textContent = "Play"; one<HTMLButtonElement>("#scorePlay").setAttribute("aria-label", "Play written music");
    if (reset) this.playheadMs = 0; this.updateUi();
  }
  pause() { if (this.playing) { if(this.contextStart>0)this.playheadMs=this.positionAt(this.context!.currentTime); this.stop(); } }
  positionAt(contextTime:number){const elapsed=Math.max(0,(contextTime-this.contextStart)*1000);if(this.looping&&this.cycleDurationMs>0)return this.windowStart+((this.originPlayheadMs-this.windowStart+elapsed)%this.cycleDurationMs);return Math.min(this.windowEnd,this.originPlayheadMs+elapsed);}
  disableLoop(){if(!this.looping)return;const position=this.playing&&this.contextStart>0?this.positionAt(this.context!.currentTime):this.playheadMs,wasPlaying=this.playing;this.stop();this.looping=false;one<HTMLButtonElement>("#loopSelection").setAttribute("aria-pressed","false");this.playheadMs=position;if(wasPlaying)void this.startPlayback(position).catch(error=>setText("#scoreError",`Score audio unavailable: ${error.message}`));}
  seek(ms: number, resume: boolean) { const wasPlaying = this.playing, inside=ms>=this.windowStart&&ms<this.windowEnd; this.stop(); this.playheadMs = Math.max(0, Math.min(totalMs, ms)); if(!inside){this.windowStart=0;this.windowEnd=totalMs;this.looping=false;} this.updateUi(); if (resume && wasPlaying) void this.startPlayback(this.playheadMs); }
  schedule(note: PlayerNote, pitch: number, sampled: boolean, at: number, duration: number) {
    const context = this.context!; let source: AudioScheduledSourceNode; const gain = context.createGain(); const release = Math.min(.5, Math.max(.08, duration * .25));
    if (sampled) { const nearest = [...this.buffers.entries()].reduce((a,b) => Math.abs(sampleMidi[b[0]]-pitch)<Math.abs(sampleMidi[a[0]]-pitch)?b:a); const sample = context.createBufferSource(); sample.buffer = nearest[1]; sample.playbackRate.value = 2 ** ((pitch-sampleMidi[nearest[0]])/12); source = sample; }
    else { const oscillator = context.createOscillator(); oscillator.type = "triangle"; oscillator.frequency.value = 440 * 2 ** ((pitch-69)/12); source = oscillator; }
    gain.gain.setValueAtTime(.0001, at); gain.gain.exponentialRampToValueAtTime(sampled ? .16*note.velocity : .025, at+.012); gain.gain.setValueAtTime(sampled ? .16*note.velocity : .025, at+Math.max(.015,duration-release)); gain.gain.exponentialRampToValueAtTime(.0001,at+duration);
    source.connect(gain).connect(context.destination); source.addEventListener("ended", () => this.nodes.delete(source)); source.start(at); source.stop(at+duration+.03); this.nodes.add(source);
  }
  async playWindow(fromMs: number, toMs: number, loop: boolean) {
    if (previewDisposed || !notes.length) return; if(this.playing)this.stop(); this.windowStart=fromMs;this.windowEnd=toMs;this.looping=loop;one<HTMLButtonElement>("#loopSelection").setAttribute("aria-pressed",String(loop));this.playheadMs=fromMs;await this.startPlayback(fromMs);
  }
  async startPlayback(startAt:number) {
    if (previewDisposed) return;
    stopRecording(); const generation = ++this.generation; const controller = new AbortController(); this.abort = controller; this.playing = true; this.playheadMs=startAt;this.originPlayheadMs=startAt;this.contextStart=0;
    one<HTMLButtonElement>("#scorePlay").textContent = "Pause"; one<HTMLButtonElement>("#scorePlay").setAttribute("aria-label", "Pause written music");
    try {
      this.context ||= new AudioContext();
      await this.context.resume();
    } catch (error) {
      if (previewDisposed || controller.signal.aborted || generation !== this.generation) return;
      this.stop(); throw error;
    }
    if (previewDisposed || controller.signal.aborted || generation !== this.generation) return;
    setText("#scoreError", bridge ? "Loading local piano samples…" : "Host samples unavailable; using oscillator preview.");
    let sampled = false; try { sampled = await this.loadSamples(controller.signal); } catch (error: any) { if (controller.signal.aborted || generation !== this.generation) return; setText("#scoreError", `Piano samples unavailable; using oscillator preview (${error?.message || error}).`); }
    if (controller.signal.aborted || generation !== this.generation) return; this.abort = undefined; if (sampled) setText("#scoreError", ""); this.contextStart = this.context.currentTime + .04;this.cycleDurationMs=this.windowEnd-this.windowStart;
    const selectedIds = selection && this.windowStart === selection.playback.startMs && this.windowEnd === selection.playback.endMs ? new Set(selection.playback.occurrenceIds) : undefined;
    const scheduleCycle=(fromMs:number,atContext:number)=>{for(const note of notes)if((!selectedIds||selectedIds.has(note.id))&&note.startMs<this.windowEnd&&note.endMs>fromMs){const clippedStart=Math.max(note.startMs,fromMs),clippedEnd=Math.min(note.endMs,this.windowEnd),at=atContext+(clippedStart-fromMs)/1000;note.pitches.forEach(pitch=>this.schedule(note,pitch,sampled,at,Math.max(.04,(clippedEnd-clippedStart)/1000)));}};
    try{scheduleCycle(startAt,this.contextStart);this.nextCycleContext=this.contextStart+(this.windowEnd-startAt)/1000;
    const scheduleAhead=()=>{if(!this.looping)return;while(this.nextCycleContext<this.context!.currentTime+1){scheduleCycle(this.windowStart,this.nextCycleContext);this.nextCycleContext+=this.cycleDurationMs/1000;}};scheduleAhead();
    this.timer = window.setInterval(() => { if (generation !== this.generation) return;try{scheduleAhead();this.playheadMs=this.positionAt(this.context!.currentTime);this.paintPlayback();if(!this.looping&&this.playheadMs>=this.windowEnd)this.stop();}catch(error:any){this.stop();setText("#scoreError",`Score audio unavailable: ${error.message}`);} }, 40);}catch(error){this.stop();throw error;}
  }
  paintPlayback() { many(".active-note").forEach(element => element.classList.remove("active-note")); const active = notes.filter(note => this.playheadMs >= note.startMs && this.playheadMs < note.endMs); active.forEach(note => note.elements.forEach(element => element.classList.add("active-note"))); this.updateUi(active); }
  updateUi(active: PlayerNote[] = []) { const ratio=totalMs?Math.min(1,this.playheadMs/totalMs):0; const input=one<HTMLInputElement>("#scoreProgressTrack");input.value=String(Math.round(ratio*1000));input.setAttribute("aria-valuetext",`${formatTime(this.playheadMs/1000)} of ${formatTime(totalMs/1000)}`); setText("#position", `${active.length ? `Bar ${Math.min(...active.map(note=>note.measure))+1} · ` : ""}${formatTime(this.playheadMs/1000)} / ${formatTime(totalMs/1000)}`); const activePitches=this.playing?new Set(active.flatMap(note=>note.pitches)):new Set<number>();many(".roll-key").forEach(element=>{const key=element as HTMLElement,name=key.dataset.pitchName||"Pitch",sounding=activePitches.has(Number(key.dataset.pitch));key.classList.toggle("playing",sounding);key.setAttribute("aria-label",sounding?`${name}, sounding`:name);key.toggleAttribute("aria-current",sounding);});updateRollPlayhead(this.playheadMs); }
  async toggle() { if (this.playing) this.pause(); else {if(!(this.windowEnd>this.windowStart)){this.windowStart=0;this.windowEnd=totalMs;this.looping=false;}await this.startPlayback(this.playheadMs>=this.windowEnd?this.windowStart:this.playheadMs);} }
  async playFromCursor() { const note = notes.find(item => item.id === cursorId); await this.playWindow(note?.startMs ?? this.playheadMs, totalMs, false); }
}
const player = new ScorePlayer();
one<HTMLButtonElement>("#scorePlay").onclick = () => void player.toggle().catch(error => setText("#scoreError", `Score audio unavailable: ${error.message}`));
one<HTMLButtonElement>("#playSelection").onclick = () => selection && void player.playWindow(selection.playback.startMs, selection.playback.endMs, false).catch(error=>setText("#scoreError",`Score audio unavailable: ${error.message}`));
const loopButton=one<HTMLButtonElement>("#loopSelection");loopButton.setAttribute("aria-pressed","false");loopButton.onclick = () => {if(player.looping)player.disableLoop();else if(selection)void player.playWindow(selection.playback.startMs, selection.playback.endMs, true).catch(error=>setText("#scoreError",`Score audio unavailable: ${error.message}`));};
const progressInput=one<HTMLInputElement>("#scoreProgressTrack");
progressInput.addEventListener("input",()=>player.seek(Number(progressInput.value)/1000*totalMs,player.playing));

const ROLL_GUTTER=46,ROLL_BASE_ROW=18,ROLL_MIN_ROW=5,ROLL_MAX_ROW=40,ROLL_MIN_ZOOM=.55,ROLL_MAX_ZOOM=4,ROLL_BASE_PX_PER_MS=.035;
let rollZoom=1,rollPitchZoom=1,rollLow=48,rollHigh=72,rollSuppressClickUntil=0;
let rollGestures:{state:()=>GestureState},rollPitchInitialized=false,rollPitchFitMode=true,rollHostSize="";
function midiName(midi:number){const names=["C","C♯","D","E♭","E","F","F♯","G","A♭","A","B♭","B"];return `${names[midi%12]}${Math.floor(midi/12)-1}`;}
function rollContent(){return document.querySelector<HTMLElement>("#rollContent");}
function rollRowHeight(){return ROLL_BASE_ROW*rollPitchZoom;}
function rollPitchTop(pitch:number){return 28+(rollHigh-pitch)*rollRowHeight();}
function applyRollGeometry(){const content=rollContent();if(!content)return;const row=rollRowHeight(),width=Math.max(520,totalMs*ROLL_BASE_PX_PER_MS*rollZoom);content.style.width=`${ROLL_GUTTER+width}px`;content.style.height=`${(rollHigh-rollLow+1)*row+28}px`;many(".roll-row,.roll-key").forEach(element=>{const item=element as HTMLElement,pitch=Number(item.dataset.pitch);item.style.top=`${rollPitchTop(pitch)}px`;item.style.height=`${row}px`;});many(".roll-key-label").forEach(element=>{const label=element as HTMLElement;label.hidden=row<9;label.style.lineHeight=`${row}px`;});many(".roll-note").forEach(element=>{const button=element as HTMLElement,start=Number(button.dataset.start),end=Number(button.dataset.end),pitch=Number(button.dataset.pitch);button.style.left=`${ROLL_GUTTER+start*ROLL_BASE_PX_PER_MS*rollZoom}px`;button.style.width=`${Math.max(6,(end-start)*ROLL_BASE_PX_PER_MS*rollZoom)}px`;button.style.top=`${rollPitchTop(pitch)+Math.min(2,row*.15)}px`;button.style.height=`${Math.max(3,row-Math.min(4,row*.3))}px`;});many(".roll-barline").forEach(element=>{const line=element as HTMLElement;line.style.left=`${ROLL_GUTTER+Number(line.dataset.ms)*ROLL_BASE_PX_PER_MS*rollZoom}px`;});updateRollPlayhead(player?.playheadMs||0);}
function applyRollScale(nextTime:number,nextPitch:number,anchor?:{x:number;y:number;contentX:number;contentY:number}){const x=anchor?.x??scorePaper.clientWidth/2,y=anchor?.y??scorePaper.clientHeight/2,ms=anchor?.contentX??Math.max(0,(scorePaper.scrollLeft+x-ROLL_GUTTER)/(ROLL_BASE_PX_PER_MS*rollZoom)),pitchRow=anchor?.contentY??Math.max(0,(scorePaper.scrollTop+y-28)/rollRowHeight());rollZoom=Math.max(ROLL_MIN_ZOOM,Math.min(ROLL_MAX_ZOOM,nextTime));rollPitchZoom=Math.max(ROLL_MIN_ROW/ROLL_BASE_ROW,Math.min(ROLL_MAX_ROW/ROLL_BASE_ROW,nextPitch));applyRollGeometry();scorePaper.scrollLeft=ROLL_GUTTER+ms*ROLL_BASE_PX_PER_MS*rollZoom-x;scorePaper.scrollTop=28+pitchRow*rollRowHeight()-y;if(activeScoreView==="roll"&&zoomReset)zoomReset.textContent=`${Math.round(rollZoom*100)}%`;updatePitchLabel();updateHandles();}
function applyRollZoom(next:number,anchorX?:number,contentMs?:number){applyRollScale(next,rollPitchZoom,anchorX==null?undefined:{x:anchorX,y:scorePaper.clientHeight/2,contentX:contentMs??0,contentY:(scorePaper.scrollTop+scorePaper.clientHeight/2-28)/rollRowHeight()});}
function updatePitchLabel(){const button=document.querySelector<HTMLButtonElement>("#pitchFit");if(button)button.textContent=`Fit · ${Math.round(rollPitchZoom*100)}%`;}
function fitRollPitches(){rollPitchFitMode=true;const available=Math.max(1,scorePaper.clientHeight-28),rows=rollHigh-rollLow+1;rollPitchZoom=Math.max(ROLL_MIN_ROW/ROLL_BASE_ROW,Math.min(1,available/rows/ROLL_BASE_ROW));applyRollGeometry();scorePaper.scrollTop=0;updatePitchLabel();updateHandles();}
function resetRollView(){rollZoom=1;rollPitchFitMode=true;applyRollGeometry();fitRollPitches();scorePaper.scrollLeft=0;if(zoomReset)zoomReset.textContent="100%";}
const pitchOut=document.querySelector<HTMLButtonElement>("#pitchOut"),pitchIn=document.querySelector<HTMLButtonElement>("#pitchIn"),pitchFit=document.querySelector<HTMLButtonElement>("#pitchFit");
const reflowCommentAfterControl=()=>{const reflow=()=>{if(!commentPanel.hidden)placeComment();};requestAnimationFrame(reflow);setTimeout(reflow,60);};
if(pitchOut)pitchOut.onclick=()=>{rollPitchFitMode=false;applyRollScale(rollZoom,rollPitchZoom/1.2);reflowCommentAfterControl();};if(pitchIn)pitchIn.onclick=()=>{rollPitchFitMode=false;applyRollScale(rollZoom,rollPitchZoom*1.2);reflowCommentAfterControl();};if(pitchFit)pitchFit.onclick=()=>{fitRollPitches();rollPitchInitialized=true;reflowCommentAfterControl();};
function updateRollPlayhead(ms:number){const cursor=document.querySelector<HTMLElement>("#rollPlayhead");if(cursor)cursor.style.left=`${ROLL_GUTTER+ms*ROLL_BASE_PX_PER_MS*rollZoom}px`;}
function revealRollOnSwitch(){
  rollHostSize=hostViewport?`${hostViewport.width}x${hostViewport.height}:${hostViewport.visible.left},${hostViewport.visible.top},${hostViewport.visible.right},${hostViewport.visible.bottom}`:`${innerWidth}x${innerHeight}:0,0,${innerWidth},${innerHeight}`;const viewport=visibleFrameBounds(),desiredTop=viewport.top+118,safeHeight=Math.max(160,viewport.bottom-desiredTop-8);scorePaper.style.height=`${safeHeight}px`;
  const selectedIds=new Set(selection?.playback.occurrenceIds||[]),target=notes.find(note=>note.id===cursorId)||notes.find(note=>selectedIds.has(note.id))||notes.reduce((best,note)=>Math.abs(note.startMs-player.playheadMs)<Math.abs(best.startMs-player.playheadMs)?note:best,notes[0]);
  const pitch=target?.pitches[Math.floor(target.pitches.length/2)]??Math.round((rollLow+rollHigh)/2),time=target?.startMs??player.playheadMs;
  scorePaper.scrollTop=Math.max(0,28+(rollHigh-pitch)*rollRowHeight()-scorePaper.clientHeight/2+rollRowHeight()/2);scorePaper.scrollLeft=Math.max(0,ROLL_GUTTER+time*ROLL_BASE_PX_PER_MS*rollZoom-scorePaper.clientWidth*.2);
  const section=one<HTMLElement>("#scoreSection").getBoundingClientRect(),paper=scorePaper.getBoundingClientRect();
  // View switching is an explicit navigation action. Reveal the controls and roll once,
  // but never auto-follow playback or fight subsequent user panning.
  const safeTop=Math.max(viewport.top+8,Math.min(viewport.bottom-Math.min(paper.height,220)-8,desiredTop));
  if(section.top<viewport.top||paper.top>safeTop+24)window.scrollBy({top:paper.top-safeTop,behavior:"instant"});
  const finalize=()=>{if(activeScoreView!=="roll")return;const current=visibleFrameBounds(),placed=scorePaper.getBoundingClientRect(),placedHeight=Math.max(160,current.bottom-placed.top-8);if(Math.abs(placed.height-placedHeight)>1)scorePaper.style.height=`${placedHeight}px`;if(!rollPitchInitialized||rollPitchFitMode){fitRollPitches();rollPitchInitialized=true;}};requestAnimationFrame(finalize);setTimeout(finalize,60);
}
function drawRoll(){if(!notes.length)return;const roll=one<HTMLElement>("#roll"),pitches=notes.flatMap(note=>note.pitches);rollLow=Math.max(0,Math.min(...pitches)-2);rollHigh=Math.min(127,Math.max(...pitches)+2);const content=document.createElement("div");content.id="rollContent";content.className="roll-content";content.setAttribute("role","application");content.setAttribute("aria-label","Piano roll. Tap a note to position playback; drag to pan and pinch to zoom.");const keyboard=document.createElement("div");keyboard.className="roll-keyboard";keyboard.setAttribute("role","img");keyboard.setAttribute("aria-label",`Compact piano keyboard, ${midiName(rollLow)} through ${midiName(rollHigh)}`);for(let pitch=rollHigh;pitch>=rollLow;pitch--){const black=[1,3,6,8,10].includes(pitch%12),row=document.createElement("div");row.className=`roll-row ${black?"black-key":""}`;row.dataset.pitch=String(pitch);content.append(row);const key=document.createElement("span");key.className=`roll-key ${black?"piano-black":"piano-white"}`;key.dataset.pitch=String(pitch);key.dataset.pitchName=midiName(pitch);key.setAttribute("aria-label",midiName(pitch));key.title=midiName(pitch);if(pitch%12===0){const label=document.createElement("span");label.className="roll-key-label";label.textContent=midiName(pitch);key.append(label);}keyboard.append(key);}content.append(keyboard);for(const {measure,ms}of rollBars){const line=document.createElement("div");line.className="roll-barline";line.dataset.ms=String(ms);line.innerHTML=`<span>Bar ${measure+1}</span>`;content.append(line);}const playhead=document.createElement("div");playhead.id="rollPlayhead";playhead.className="roll-playhead";content.append(playhead);for(const note of notes)for(const pitch of note.pitches){const bar=document.createElement("button");bar.type="button";bar.className="roll-note";bar.dataset.start=String(note.startMs);bar.dataset.end=String(note.endMs);bar.dataset.pitch=String(pitch);bar.dataset.noteId=note.id;bar.setAttribute("aria-label",`${midiName(pitch)}, bar ${note.measure+1}, ${formatTime(note.startMs/1000)}`);bar.onclick=event=>{if(performance.now()<rollSuppressClickUntil)return;setCursor(note,(event as MouseEvent).shiftKey);};note.elements.push(bar);content.append(bar);}roll.append(content);applyRollGeometry();
rollGestures=attachViewportGestures({root:content,scale:()=>rollZoom,scaleY:()=>rollPitchZoom,contentAt:(x,y)=>({x:Math.max(0,(scorePaper.scrollLeft+x-ROLL_GUTTER)/(ROLL_BASE_PX_PER_MS*rollZoom)),y:Math.max(0,(scorePaper.scrollTop+y-28)/rollRowHeight())}),applyScale:(scale,scaleY,anchor)=>{rollPitchFitMode=false;applyRollScale(scale,scaleY,anchor);},tap:event=>{const target=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>(".roll-note");target?.click();},suppress:milliseconds=>{rollSuppressClickUntil=performance.now()+milliseconds;}});}

const commentPanel = one<HTMLElement>("#commentPanel"), commentText = one<HTMLTextAreaElement>("#commentText"), commentStatus = one<HTMLElement>("#commentStatus"), fallback = one<HTMLElement>("#commentFallback"),commentStage=one<HTMLButtonElement>("#commentStage");
const commentDrafts=new Map<string,{text:string;version:number}>();let activeDraftKey="",reviewPending=false;
function currentSelectionKey(){return selection?`${data.revision}:${selection.ranges.map(range=>`${range.voiceId}:${range.start}-${range.end}`).join("|")}`:"";}
function saveActiveDraft(){if(activeDraftKey)commentDrafts.set(activeDraftKey,{text:commentText.value,version:(commentDrafts.get(activeDraftKey)?.version||0)+1});}
function syncCommentSelection(){if(commentPanel.hidden)return;if(!selection?.ranges.length){closeComment(false);return;}const next=currentSelectionKey();if(!next||next===activeDraftKey)return;saveActiveDraft();activeDraftKey=next;commentText.value=commentDrafts.get(next)?.text||"";setText("#commentContext",`${selection.label} · revision ${data.revision}`);placeComment();}
commentText.addEventListener("input",()=>{if(activeDraftKey)commentDrafts.set(activeDraftKey,{text:commentText.value,version:(commentDrafts.get(activeDraftKey)?.version||0)+1});});
function visibleSelectionRect(){const elements=[...elementsForSelection(selection)];if(!elements.length)return undefined;const rects=elements.map(element=>element.getBoundingClientRect());return {left:Math.min(...rects.map(rect=>rect.left)),right:Math.max(...rects.map(rect=>rect.right)),top:Math.min(...rects.map(rect=>rect.top)),bottom:Math.max(...rects.map(rect=>rect.bottom))};}
type ScoreViewGeometry={insetLeft:number;prepareNarrow:(height:number)=>void;restore:()=>void};
const scoreViewGeometry:Record<"notation"|"roll",ScoreViewGeometry>={
  notation:{insetLeft:0,prepareNarrow:height=>{scorePaper.style.removeProperty("height");scorePaper.style.maxHeight=`${Math.max(96,height)}px`;},restore:()=>{scorePaper.style.maxHeight="";}},
  roll:{insetLeft:ROLL_GUTTER,prepareNarrow:height=>{scorePaper.style.maxHeight="";scorePaper.style.height=`${Math.max(160,height)}px`;if(rollPitchFitMode)fitRollPitches();else{applyRollGeometry();updateHandles();}},restore:()=>{scorePaper.style.maxHeight="";}},
};
function ensureCommentSelectionVisible(insetLeft:number){
  let selected=visibleSelectionRect();if(!selected)return;const paper=scorePaper.getBoundingClientRect(),left=paper.left+insetLeft+8,right=paper.right-12,top=paper.top+8,bottom=paper.bottom-54;
  if(selected.right>right)scorePaper.scrollLeft+=selected.right-right;else if(selected.left<left)scorePaper.scrollLeft-=left-selected.left;
  selected=visibleSelectionRect()||selected;if(selected.bottom>bottom)scorePaper.scrollTop+=selected.bottom-bottom;else if(selected.top<top)scorePaper.scrollTop-=top-selected.top;
}
function placeComment() {
  if(commentPanel.hidden||!selection?.ranges.length)return;const viewport=visibleFrameBounds();if(viewport.right<=viewport.left||viewport.bottom<=viewport.top)return;
  const narrow=matchMedia("(max-width: 680px)").matches,geometry=scoreViewGeometry[activeScoreView];commentPanel.classList.toggle("phone-drawer",narrow);commentPanel.classList.toggle("desktop-anchor",!narrow);
  commentPanel.style.width="";commentPanel.style.left="";commentPanel.style.top="";
  if(narrow){
    const panelHeight=commentPanel.getBoundingClientRect().height,available=viewport.bottom-viewport.top-panelHeight-32;geometry.prepareNarrow(available);ensureCommentSelectionVisible(geometry.insetLeft);
    const paper=scorePaper.getBoundingClientRect(),targetTop=viewport.top+8;if(Math.abs(paper.top-targetTop)>1)window.scrollBy({top:paper.top-targetTop,behavior:"instant"});ensureCommentSelectionVisible(geometry.insetLeft);
    const overflow=commentPanel.getBoundingClientRect().bottom-viewport.bottom+8;if(overflow>0){const selected=visibleSelectionRect(),room=Math.max(0,(selected?.top??viewport.top)-viewport.top-8);if(room>0)window.scrollBy({top:Math.min(overflow,room),behavior:"instant"});}
  }else{
    geometry.restore();ensureCommentSelectionVisible(geometry.insetLeft);const selected=visibleSelectionRect();if(!selected)return;const section=one<HTMLElement>("#scoreSection").getBoundingClientRect(),width=Math.min(440,section.width-24);commentPanel.style.width=`${width}px`;commentPanel.style.left=`${Math.max(12,Math.min(section.width-width-12,selected.left-section.left))}px`;const height=commentPanel.getBoundingClientRect().height,above=selected.top-section.top-height-8;commentPanel.style.top=`${above>45?above:selected.bottom-section.top+8}px`;
  }
}
function openComment() { if (!selection?.ranges.length) {setText("#scoreError","This accompaniment can be auditioned, but it has no editable score source to comment on.");return;}saveActiveDraft();activeDraftKey=currentSelectionKey();commentText.value=commentDrafts.get(activeDraftKey)?.text||""; commentPanel.hidden=false; commentPanel.classList.add("open"); setText("#commentContext",`${selection.label} · revision ${data.revision}`); placeComment(); commentText.focus({preventScroll:true}); }
function closeComment(clearDraft: boolean) { if(clearDraft&&activeDraftKey)commentDrafts.delete(activeDraftKey);else saveActiveDraft();scoreViewGeometry[activeScoreView].restore();commentPanel.hidden=true; commentPanel.classList.remove("open","phone-drawer","desktop-anchor");commentPanel.removeAttribute("style"); if(clearDraft) commentText.value="";activeDraftKey=""; commentStatus.textContent=""; fallback.hidden=true;if(activeScoreView==="roll")requestAnimationFrame(revealRollOnSwitch); }
const onPreviewResize = () => { if (!previewDisposed) { placeComment(); updateHandles(); } };
window.visualViewport?.addEventListener("resize", onPreviewResize, { signal: previewLifetime.signal });
window.addEventListener("resize", onPreviewResize, { signal: previewLifetime.signal });
const unsubscribeViewport = bridge?.onViewportChange?.((viewport: PreviewViewport) => {
  if (previewDisposed) return;
  hostViewport = viewport;
  if (!commentPanel.hidden) {placeComment();setTimeout(()=>{if(!commentPanel.hidden)placeComment();},60);}
  const nextSize=`${viewport.width}x${viewport.height}:${viewport.visible.left},${viewport.visible.top},${viewport.visible.right},${viewport.visible.bottom}`;if(activeScoreView==="roll"&&nextSize!==rollHostSize&&commentPanel.hidden)requestAnimationFrame(revealRollOnSwitch);
  updateHandles();
});
one<HTMLButtonElement>("#commentSelection").onclick=openComment; one<HTMLButtonElement>("#commentCancel").onclick=()=>closeComment(false);
commentStage.onclick=async()=>{
  if(previewDisposed||!selection||reviewPending)return; const frozenSelection=structuredClone(selection),submittedKey=currentSelectionKey(),draft=commentDrafts.get(submittedKey)||{text:commentText.value,version:0},comment=commentText.value,submittedVersion=draft.version,score=data.score||"";
  try { validateReviewRequest({score,compositionRevision:data.revision,scoreSha256:data.scoreSha256||"",selection:frozenSelection,comment});
    const request={action:"review-score-edit",payload:{snapshot:{compositionRevision:data.revision,scoreSha256:data.scoreSha256},selection:{...frozenSelection,ranges:frozenSelection.ranges.map(range=>({...range,excerpt:score.slice(range.start,range.end)}))},comment,path:data.artifactPath}};
    const json=JSON.stringify(request); if(new TextEncoder().encode(json).length>32768)throw new Error("Review request exceeds 32 KiB. Select a smaller passage or shorten the comment.");
    commentStatus.textContent="Adding to chat for review…"; fallback.hidden=true;reviewPending=true;commentStage.disabled=true;
    if(typeof bridge?.requestReview!=="function")throw new Error("This host does not support score review yet.");
    const outcome=await bridge.requestReview(request);
    if (previewDisposed) return;
    if(outcome?.status==="added"){const current=commentDrafts.get(submittedKey);if(current?.version===submittedVersion&&current.text===comment)commentDrafts.delete(submittedKey);commentStatus.textContent="Added to chat for review. Your score is unchanged.";if(activeDraftKey===submittedKey&&commentText.value===comment)closeComment(true);else commentStatus.textContent="Added the submitted draft to chat. Your newer passage draft is still here.";}
    else if(outcome?.status==="cancelled")commentStatus.textContent="Review cancelled. Your comment is still here.";
    else if(outcome?.status==="stale")commentStatus.textContent=outcome.message||"The composition changed. Reopen it and select the passage again; your comment is still here.";
    else {commentStatus.textContent=outcome?.message||"Score review is not supported by this host yet.";fallback.hidden=false;fallback.textContent=json;}
  }catch(error:any){if(previewDisposed)return;commentStatus.textContent=error?.message||String(error); fallback.hidden=false; fallback.textContent=JSON.stringify({selection:frozenSelection,comment},null,2);}finally{reviewPending=false;if(!previewDisposed)commentStage.disabled=false;}
};

if (data.score && safeScore(data.score)) {
  try {
    tune = ABCJS.renderAbc("notation", data.score, { add_classes:true, staffwidth:760, selectTypes:["note","rest","bar"], selectionColor:"currentColor",clickListener:(abcElement:any,_tuneNumber:any,classes:string,_analysis:any,_drag:any,event:any)=>{if(performance.now()<suppressScoreActivationUntil)return;const match=String(classes||"").match(/(?:^|\s)abcjs-v(\d+)(?:\s|$)/),voiceId=match?`voice-${Number(match[1])+1}`:undefined;const note=chooseOccurrence(notes,abcElement.startChar,abcElement.endChar,player.playheadMs,voiceId) as PlayerNote|undefined;if(note)setCursor(note,!!event?.shiftKey);} })[0];
    notes = buildPlayerTimeline(tune); totalMs = notes.reduce((maximum,note)=>Math.max(maximum,note.endMs),0); applyScoreScale(scoreScale); drawRoll(); indexElements(); player.updateUi();
    const notation=one<HTMLElement>("#notation"); notation.tabIndex=0; notation.setAttribute("aria-label","Written score. Click a note to position playback; use Select or Shift-click to select a passage.");
  } catch(error:any) { setText("#scoreError",`Notation could not be rendered: ${error.message}`); }
} else if (data.score) setText("#scoreError","Score contains a network-bearing or unsafe ABC directive and was not rendered.");
else { one<HTMLElement>("#scoreSection").hidden=true; setText("#scoreMissing","No score exists yet; audition and piano roll are unavailable."); }

const notationButton=one<HTMLButtonElement>("#notationButton"),rollButton=one<HTMLButtonElement>("#rollButton");
function setScoreView(next:"notation"|"roll"){
  activeScoreView=next;const isRoll=next==="roll";scorePaper.classList.toggle("roll-view",isRoll);if(!isRoll)scorePaper.style.removeProperty("height");const pitchControls=document.querySelector<HTMLElement>("#pitchZoomControls");if(pitchControls)pitchControls.hidden=!isRoll;one<HTMLElement>("#notation").hidden=isRoll;one<HTMLElement>("#roll").hidden=!isRoll;notationButton.setAttribute("aria-pressed",String(!isRoll));rollButton.setAttribute("aria-pressed",String(isRoll));if(zoomReset)zoomReset.textContent=`${Math.round((isRoll?rollZoom:scoreScale)*100)}%`;paintState();const settleView=()=>{if(commentPanel.hidden){if(isRoll)revealRollOnSwitch();}else placeComment();};requestAnimationFrame(settleView);setTimeout(settleView,60);
}
notationButton.onclick=()=>setScoreView("notation");rollButton.onclick=()=>setScoreView("roll");setScoreView("notation");
window.__wavyTest={data,notes:()=>notes.map(({elements,...note})=>({...note,elements:elements.map(element=>element.getAttribute("class"))})),events:()=>notes.map(note=>({ms:note.startMs,dur:note.endMs-note.startMs,p:note.pitches,measure:note.measure,startChar:note.start,elements:note.elements.map(element=>element.getAttribute("class"))})),bars:()=>structuredClone(rollBars),selection:()=>selection,zoom:()=>scoreScale,rollZoom:()=>rollZoom,rollPitchZoom:()=>rollPitchZoom,rowHeight:()=>rollRowHeight(),view:()=>activeScoreView,gesture:()=>notationGestures.state(),rollGesture:()=>rollGestures?.state(),selectTake:loadRecording,recordingUrl:()=>recordingUrl,player};
let unsubscribeDispose: (() => void) | undefined;
function disposePreview() {
  if (previewDisposed) return;
  previewDisposed = true;
  previewLifetime.abort();
  unsubscribeTheme?.();
  unsubscribeViewport?.();
  unsubscribeDispose?.();
  recordingLoadGeneration++;
  player.stop();
  stopRecording();
  clearRecording();
  player.buffers.clear();
  if (player.context && player.context.state !== "closed") void player.context.close().catch(() => {});
  // A host may revoke a still-connected frame before replacing its document.
  // Leave it readable, but no longer interactive or capable of restarting audio.
  document.body.inert = true;
}
window.addEventListener("pagehide", disposePreview, { once: true, signal: previewLifetime.signal });
unsubscribeDispose = bridge?.onDispose?.(disposePreview);
