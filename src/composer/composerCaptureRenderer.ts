import { createComposerCaptureLayout } from "./composerCaptureLayout.js";

export type CaptureVisualPhase = "permission" | "recording" | "handoff" | "processing" | "resolving" | "idle";

type Sample = { at: number; rms: number };
type Snapshot = { envelope: Float32Array; energy: Float32Array; span: number; end: number };
type FrozenView = { phase: "handoff" | "processing"; clock: number };

const TAU = Math.PI * 2;
const POINTS = 1024;
const HISTORY_MS = 6_000;
const HANDOFF_MS = 180;
const PROCESS_CANONICAL_MS = 4_800;
const PROCESS_PERIOD_MS = 3_200;
const PROCESS_TIME_SCALE = PROCESS_CANONICAL_MS / PROCESS_PERIOD_MS;
const RECORDING_CARRIER_RATE = .6;
const PROCESSING_CARRIER_RATE = 1;
const RESOLVE_EXIT_MS = 220;
const TEXT_REVEAL_DELAY_MS = 50;
const TEXT_REVEAL_DURATION_MS = 150;
const CHROME_SETTLE_MS = 500;
const CAPTURE_ENTRY_MS = 120;
const SIGNAL = "#d3ae75";
const SECONDARY = "#75664e";
const WORDS = "#f0d9ae";

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smooth = (value: number) => { const n = clamp(value); return n * n * (3 - 2 * n); };
const mix = (a: number, b: number, amount: number) => a + (b - a) * amount;
const blank = (): Snapshot => ({ envelope: new Float32Array(POINTS + 1), energy: new Float32Array(POINTS + 1), span: HISTORY_MS, end: 0 });

export function createComposerCaptureRenderer(container: HTMLElement) {
  const composer = container.closest<HTMLElement>(".composer") || container;
  const prompt = composer.querySelector<HTMLElement>("#prompt");
  const canvas = document.createElement("canvas");
  canvas.className = "composerCaptureVisual";
  canvas.setAttribute("aria-hidden", "true");
  canvas.hidden = true;
  canvas.style.maxWidth = "none";
  composer.append(canvas);
  const context = canvas.getContext("2d");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let phase: CaptureVisualPhase = "idle";
  let samples: Sample[] = [];
  let phaseStarted = performance.now();
  let handoffStarted = phaseStarted;
  let captureStarted = phaseStarted;
  let source = blank();
  let origin = source;
  let lastLive = source;
  let frozenView: FrozenView | undefined;
  let frame = 0;
  let exitPinned = false;
  let textRevealActive = false;
  let textRevealColor: [number, number, number] = [242, 242, 242];
  const footer = composer.querySelector<HTMLElement>(".composerFooter");
  const captureInputs = container;
  let chromeReleaseTimer: number | undefined;
  const chromeLayout = createComposerCaptureLayout(composer, footer, captureInputs);

  function clearTextReveal() {
    textRevealActive = false;
    prompt?.style.removeProperty("color");
  }

  function parseColor(value: string): [number, number, number] {
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    const probeContext = probe.getContext("2d");
    if (!probeContext) return [242, 242, 242];
    probeContext.fillStyle = value;
    probeContext.fillRect(0, 0, 1, 1);
    const pixel = probeContext.getImageData(0, 0, 1, 1).data;
    return [pixel[0]!, pixel[1]!, pixel[2]!];
  }

  function releaseChrome() {
    if (chromeReleaseTimer !== undefined) window.clearTimeout(chromeReleaseTimer);
    chromeReleaseTimer = undefined;
    chromeLayout.release();
  }

  function pinExitFrame() {
    const rect = canvas.getBoundingClientRect();
    canvas.style.position = "fixed";
    canvas.style.left = `${rect.left}px`;
    canvas.style.top = `${rect.top}px`;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.style.maxWidth = "none";
    canvas.style.zIndex = "20";
    exitPinned = true;
  }

  function releaseExitFrame() {
    if (!exitPinned) return;
    canvas.style.position = "";
    canvas.style.left = "";
    canvas.style.top = "";
    canvas.style.width = "";
    canvas.style.height = "";
    canvas.style.maxWidth = "none";
    canvas.style.zIndex = "";
    canvas.style.opacity = "";
    exitPinned = false;
  }

  function level(rms: number) {
    return clamp(Math.pow(Math.max(0, rms - .005) * 15, .7));
  }

  function rmsAt(time: number) {
    if (!samples.length || time < samples[0]!.at) return 0;
    const last = samples[samples.length - 1]!;
    if (time >= last.at) return last.rms;
    let low = 0, high = samples.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (samples[middle]!.at <= time) low = middle; else high = middle;
    }
    const a = samples[low]!, b = samples[high]!;
    return mix(a.rms, b.rms, (time - a.at) / Math.max(1, b.at - a.at));
  }

  function snapshot(end: number, span = HISTORY_MS): Snapshot {
    const envelope = new Float32Array(POINTS + 1);
    const energy = new Float32Array(POINTS + 1);
    let sum = 0;
    for (let i = 0; i <= POINTS; i++) {
      envelope[i] = level(rmsAt(end - span * (1 - i / POINTS)));
      sum += envelope[i]! ** 2;
      energy[i] = sum;
    }
    if (sum) for (let i = 0; i <= POINTS; i++) energy[i] = energy[i]! / sum;
    return { envelope, energy, span, end };
  }

  function valueAt(values: Float32Array, position: number) {
    if (position < 0 || position > 1) return 0;
    const at = position * POINTS, index = Math.floor(at);
    return mix(values[index]!, values[Math.min(POINTS, index + 1)]!, at - index);
  }

  function signalAt(view: Snapshot, width: number, position: number, offset = 0, carrierRate = PROCESSING_CARRIER_RATE) {
    const frequency = clamp((width - 8) / (8 * Math.max(.1, view.span / 1_000)), .5, 11);
    const sampleTime = view.end - view.span * (1 - position);
    return valueAt(view.envelope, position) * Math.sin(TAU * frequency * sampleTime / 1_000 * carrierRate + offset);
  }

  function resize() {
    const compact = composer.classList.contains("compactInactive") && !composer.classList.contains("expanded") && !composer.matches(":has(#prompt:focus)");
    // In compact mode the prompt is the grid's actual free column, excluding the
    // model and controls. In expanded mode it is likewise the canonical input width.
    const available = prompt?.getBoundingClientRect().width || composer.clientWidth;
    const width = Math.max(40, available - (compact ? 24 : 28));
    const height = compact ? 24 : 38;
    const dpr = devicePixelRatio || 1;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      context?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { width, height, compact };
  }

  function stroke(points: Array<{ x: number; y: number }>, color: string, width: number, alpha: number) {
    if (!context || alpha <= 0) return;
    context.save(); context.globalAlpha *= alpha; context.strokeStyle = color;
    context.lineWidth = width; context.lineCap = "round"; context.lineJoin = "round"; context.beginPath();
    points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
    context.stroke(); context.restore();
  }

  function line(x1: number, y1: number, x2: number, y2: number, color: string | CanvasGradient, width: number, alpha: number) {
    if (!context || alpha <= 0) return;
    context.save(); context.globalAlpha *= alpha; context.strokeStyle = color; context.lineWidth = width; context.lineCap = "round";
    context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke(); context.restore();
  }

  function livePoints(view: Snapshot, width: number, height: number, strand = 0) {
    const amplitude = (height > 24 ? 12.5 : 7.5) * (1 - strand * .22);
    return Array.from({ length: POINTS + 1 }, (_, index) => ({
      x: 4 + (width - 8) * index / POINTS,
      y: height / 2 + signalAt(view, width, index / POINTS, strand * 1.08, RECORDING_CARRIER_RATE) * amplitude,
    }));
  }

  function band(width: number, compact: boolean) { return Math.max(40, Math.min(width, compact ? 156 : 200)); }

  function gatePoints(width: number, height: number, compact: boolean, progress: number, strand = 0) {
    const before = livePoints(origin, width, height, strand), gate = band(width, compact) * .42;
    return before.map((point, index) => ({
      x: mix(point.x, 4 + (gate - 8) * index / POINTS, progress),
      y: mix(point.y, height / 2 + signalAt(source, gate - 8, index / POINTS, 0, PROCESSING_CARRIER_RATE) * 7.5, progress),
    }));
  }

  function drawHandoff(width: number, height: number, compact: boolean, progress: number) {
    for (let strand = 2; strand >= 0; strand--) {
      stroke(gatePoints(width, height, compact, progress, strand), strand ? SECONDARY : SIGNAL,
        strand ? .8 : 1.15, strand ? .4 * (1 - smooth(progress / .75)) : .95);
    }
  }

  function wordMarks(width: number) {
    const result: Array<{ x: number; y: number; width: number }> = [], gap = Math.min(5, width * .033);
    [[.18, .29, .15, .24], [.3, .18, .29]].forEach((weights, row) => {
      const usable = (width - 8) * (row ? .84 : 1) - gap * (weights.length - 1), sum = weights.reduce((a, b) => a + b);
      let x = 4;
      weights.forEach(weight => { const markWidth = usable * weight / sum; result.push({ x, y: row ? 4 : -4, width: markWidth }); x += markWidth + gap; });
    });
    return result;
  }

  function drawGate(width: number, height: number, compact: boolean, seconds: number) {
    if (!context) return;
    const bounded = band(width, compact), gate = bounded * .42, cy = height / 2;
    const marks = wordMarks(bounded - gate - 9), progress = clamp((seconds - .45) / 2.85);
    const typed = valueAt(source.energy, progress) * marks.length, travel = clamp((seconds - .2) / 3.55);
    const points = Array.from({ length: POINTS + 1 }, (_, index) => {
      const u = index / POINTS;
      return { x: 4 + (gate - 8) * u, y: cy + signalAt(source, gate - 8, u - travel, 0, PROCESSING_CARRIER_RATE) * 7.5 };
    });
    stroke(points, SIGNAL, 1.15, .95);
    const glow = context.createLinearGradient(gate - 4, 0, gate + 4, 0);
    glow.addColorStop(0, "#e8ba7100"); glow.addColorStop(.5, "#e8ba7123"); glow.addColorStop(1, "#e8ba7100");
    context.fillStyle = glow; context.fillRect(gate - 4, cy - 10, 8, 20);
    const beam = context.createLinearGradient(0, cy - 10, 0, cy + 10);
    beam.addColorStop(0, "#f4d9a600"); beam.addColorStop(.25, "#f4d9a6cc"); beam.addColorStop(.75, "#f4d9a6cc"); beam.addColorStop(1, "#f4d9a600");
    line(gate, cy - 10, gate, cy + 10, beam, .8, .65 + .2 * Math.sin(typed * Math.PI) ** 2);
    marks.forEach((mark, index) => {
      const amount = smooth((typed - index) / .82);
      line(gate + 5 + mark.x, cy + mark.y, gate + 5 + mark.x + mark.width * amount, cy + mark.y, WORDS, 1.6, amount);
    });
    if (typed < marks.length) {
      const mark = marks[Math.min(marks.length - 1, Math.floor(typed))]!;
      const amount = smooth((typed - Math.floor(typed)) / .82), x = gate + 5 + mark.x + mark.width * amount + 1.7;
      line(x, cy + mark.y - 3.5, x, cy + mark.y + 2, WORDS, .8, .5);
    }
  }

  function drawProcessing(width: number, height: number, compact: boolean, clock: number) {
    // Run the approved 4.8-second gate choreography on a shorter wall clock;
    // travel, word reveal, and the terminal crossfade retain their proportions.
    const seconds = ((clock % PROCESS_PERIOD_MS) * PROCESS_TIME_SCALE) / 1_000;
    const crossfade = smooth((seconds - 4.1) / .7);
    if (!context) return;
    context.save(); context.globalAlpha *= 1 - crossfade; drawGate(width, height, compact, seconds); context.restore();
    if (crossfade > 0) { context.save(); context.globalAlpha *= crossfade; drawGate(width, height, compact, 0); context.restore(); }
  }

  function draw(now: number) {
    if (phase === "resolving" && exitPinned) {
      // Keep the exact last rendered pixels and viewport coordinates while the
      // committed draft changes the composer's intrinsic layout underneath.
      const elapsed = now - phaseStarted;
      canvas.style.opacity = String(1 - smooth(elapsed / RESOLVE_EXIT_MS));
      if (textRevealActive && prompt) {
        const alpha = reduced.matches ? 1 : clamp((elapsed - TEXT_REVEAL_DELAY_MS) / TEXT_REVEAL_DURATION_MS);
        const [red, green, blue] = textRevealColor;
        prompt.style.color = `rgba(${red}, ${green}, ${blue}, ${alpha})`;
      }
      if (!reduced.matches) frame = requestAnimationFrame(draw);
      return;
    }
    const { width, height, compact } = resize();
    if (!context) return;
    context.clearRect(0, 0, width, height);
    if (phase === "idle") return;
    if (phase === "recording") {
      canvas.style.opacity = String(reduced.matches ? 1 : clamp((now - captureStarted) / CAPTURE_ENTRY_MS));
      lastLive = snapshot(now);
      for (let strand = 2; strand >= 0; strand--) stroke(livePoints(lastLive, width, height, strand), strand ? SECONDARY : SIGNAL, strand ? .8 : 1.2, strand ? .4 : .95);
    } else if (phase === "permission") {
      canvas.style.opacity = String(reduced.matches ? 1 : clamp((now - captureStarted) / CAPTURE_ENTRY_MS));
      stroke(livePoints(blank(), width, height), SIGNAL, 1, .22);
    } else {
      let view = frozenView;
      if (!view) {
        const clock = reduced.matches ? HANDOFF_MS + 1_600 : Math.max(0, now - handoffStarted);
        view = clock < HANDOFF_MS ? { phase: "handoff", clock } : { phase: "processing", clock: clock - HANDOFF_MS };
      }
      context.save();
      if (view.phase === "handoff") drawHandoff(width, height, compact, clamp(view.clock / HANDOFF_MS));
      else drawProcessing(width, height, compact, view.clock);
      context.restore();
    }
    if (!(reduced.matches && phase !== "recording")) frame = requestAnimationFrame(draw);
  }

  function currentView(now = performance.now()): FrozenView {
    const clock = reduced.matches ? HANDOFF_MS + 1_600 : Math.max(0, now - handoffStarted);
    return clock < HANDOFF_MS ? { phase: "handoff", clock } : { phase: "processing", clock: clock - HANDOFF_MS };
  }

  function setPhase(next: CaptureVisualPhase) {
    if (next === phase) return;
    const now = performance.now();
    if (next === "permission") {
      captureStarted = now;
      canvas.style.opacity = reduced.matches ? "1" : "0";
    } else if (next === "handoff") {
      canvas.style.opacity = "1";
      clearTextReveal();
      releaseChrome();
      releaseExitFrame();
      source = snapshot(now, Math.max(100, Math.min(HISTORY_MS, samples.length ? now - samples[0]!.at : HISTORY_MS)));
      origin = lastLive;
      handoffStarted = now;
      frozenView = undefined;
    } else if (next === "processing") {
      // Keep the handoff clock continuous when the capture lifecycle publishes
      // its semantic processing phase.
    } else if (next === "resolving") {
      clearTextReveal();
      frozenView = currentView(now);
      // Paint the exact current handoff/gate frame before draft insertion can
      // remove compact layout, then detach that bitmap from composer geometry.
      cancelAnimationFrame(frame); frame = 0;
      draw(now);
      cancelAnimationFrame(frame); frame = 0;
      pinExitFrame();
      chromeLayout.pin();
    } else if (next === "idle") {
      clearTextReveal();
      if (chromeLayout.isPinned() && footer) {
        // Exchange the pseudo utility slot for the real attachment without
        // interpolating, then restore flow once the parent has settled.
        chromeLayout.prepareIdle();
        const remaining = Math.max(0, CHROME_SETTLE_MS - (now - phaseStarted));
        chromeReleaseTimer = window.setTimeout(() => {
          chromeReleaseTimer = undefined;
          if (phase === "idle") releaseChrome();
        }, reduced.matches ? 0 : remaining);
      }
      releaseExitFrame();
    }
    phase = next; phaseStarted = now;
    composer.dataset.capturePhase = next;
    cancelAnimationFrame(frame); frame = 0;
    if (next !== "idle" && next !== "resolving") {
      // Never expose the canvas's intrinsic 300×150 backing size or a bitmap
      // retained from the previous capture before its first animation frame.
      const { width, height } = resize();
      context?.clearRect(0, 0, width, height);
    }
    canvas.hidden = next === "idle";
    if (next !== "idle") {
      if (next === "resolving" && reduced.matches) canvas.style.opacity = "0";
      else frame = requestAnimationFrame(draw);
    }
  }

  return {
    setPhase,
    revealResult() {
      // Called only after the synchronous draft commit, so the old draft can
      // never flash between entering resolving and revealing the result.
      if (phase !== "resolving" || !prompt) return;
      const target = getComputedStyle(composer).getPropertyValue("--text").trim() || "#f2f2f2";
      textRevealColor = parseColor(target);
      textRevealActive = true;
      chromeLayout.settle();
      const elapsed = performance.now() - phaseStarted;
      const alpha = reduced.matches ? 1 : clamp((elapsed - TEXT_REVEAL_DELAY_MS) / TEXT_REVEAL_DURATION_MS);
      const [red, green, blue] = textRevealColor;
      prompt.style.color = `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    },
    addSample(rms: number) {
      const now = performance.now(); samples.push({ at: now, rms });
      samples = samples.filter(sample => sample.at >= now - HISTORY_MS - 200);
    },
    reset() { samples = []; source = blank(); origin = source; lastLive = source; frozenView = undefined; canvas.style.opacity = ""; setPhase("idle"); },
    destroy() { clearTextReveal(); releaseChrome(); cancelAnimationFrame(frame); canvas.remove(); delete composer.dataset.capturePhase; },
  };
}
