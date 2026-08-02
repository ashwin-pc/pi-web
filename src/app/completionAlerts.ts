const soundStorageKey = "pi-web-completion-sound";
const vibrationStorageKey = "pi-web-completion-vibration";

let audioContext: AudioContext | undefined;

function storedBoolean(key: string, fallback: boolean) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function storeBoolean(key: string, value: boolean) {
  try { localStorage.setItem(key, String(value)); } catch { /* Device preference is best-effort. */ }
}

export function completionSoundEnabled() {
  return storedBoolean(soundStorageKey, false);
}

export function completionVibrationEnabled() {
  return storedBoolean(vibrationStorageKey, true);
}

function context() {
  const AudioContextConstructor = window.AudioContext || (window as any).webkitAudioContext as typeof AudioContext | undefined;
  if (!AudioContextConstructor) return undefined;
  audioContext ||= new AudioContextConstructor();
  return audioContext;
}

export async function setCompletionSoundEnabled(enabled: boolean) {
  storeBoolean(soundStorageKey, enabled);
  if (!enabled) return;
  await context()?.resume();
}

export function setCompletionVibrationEnabled(enabled: boolean) {
  storeBoolean(vibrationStorageKey, enabled);
}

function playChime() {
  const audio = context();
  if (!audio || audio.state !== "running") return;
  const now = audio.currentTime;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.025);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
  gain.connect(audio.destination);

  for (const [frequency, offset] of [[659.25, 0], [783.99, 0.14]] as const) {
    const oscillator = audio.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(now + offset);
    oscillator.stop(now + 0.7);
  }
}

export function playCompletionAlerts() {
  if (completionSoundEnabled()) playChime();
  if (completionVibrationEnabled()) navigator.vibrate?.([180, 90, 240]);
}
