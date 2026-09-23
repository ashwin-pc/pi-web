export interface SourceRange {
  start: number;
  end: number;
  voiceId: string;
}

export interface TimelineNote extends SourceRange {
  id: string;
  startMs: number;
  endMs: number;
  pitches: number[];
  velocity: number;
  measure: number;
  repeatPass: number;
  voiceLabel: string;
  sourceRanges: SourceRange[];
  tieStart?: number;
  tieEnd?: number;
}

export interface SelectionPlayback {
  startMs: number;
  endMs: number;
  occurrenceIds: string[];
  repeatPasses: number[];
}

export interface SourceSelection {
  kind: "abc-source-ranges";
  unit: "utf16";
  sourceVoiceId: string;
  endpoints: { startOccurrenceId: string; endOccurrenceId: string };
  ranges: SourceRange[];
  label: string;
  playback: SelectionPlayback;
}

export interface RawAudioNote {
  track: number;
  /** Canonical ABC voice identity. Omit it for audition-only/unmapped tracks. */
  voiceId?: string;
  voiceLabel?: string;
  start: number;
  duration: number;
  pitch: number;
  startChar?: number;
  endChar?: number;
  volume?: number;
}

export interface TimelineOptions {
  tempo: number;
  toMilliseconds?: (value: number) => number;
  measureFor?: (track: number, startChar: number, startMs: number) => number;
  voiceLabelFor?: (track: number) => string;
}

/** Build the one canonical unfolded playback model. ABC offsets are UTF-16 code units. */
export function buildTimeline(notes: RawAudioNote[], options: TimelineOptions): TimelineNote[] {
  const toMs = options.toMilliseconds ?? (value => value * 4 * 60_000 / options.tempo);
  const groups = new Map<string, { notes: RawAudioNote[]; firstIndex: number }>();
  notes.forEach((note, index) => {
    if (note.duration <= 0) return;
    const sourceBound = !!note.voiceId && Number.isFinite(note.startChar) && note.startChar! >= 0;
    const start = sourceBound ? note.startChar! : -1, end = sourceBound ? Math.max(start + 1, note.endChar ?? start + 1) : -1;
    const identity = note.voiceId ?? `track-${note.track}`;
    const key = sourceBound ? `${identity}:${start}:${end}:${note.start}` : `${identity}:generated:${note.start}`;
    const group = groups.get(key);
    if (group) group.notes.push(note); else groups.set(key, { notes: [note], firstIndex: index });
  });
  const occurrences = [...groups.values()].map(group => {
    const first = group.notes[0], sourceBound = !!first.voiceId && Number.isFinite(first.startChar) && first.startChar! >= 0;
    const start = sourceBound ? first.startChar! : -1, end = sourceBound ? Math.max(start + 1, first.endChar ?? start + 1) : -1;
    const voiceId = first.voiceId ?? `track-${first.track + 1}`, startMs = toMs(first.start);
    return {
      id: "", start, end, voiceId, startMs,
      endMs: startMs + Math.max(40, ...group.notes.map(note => toMs(note.duration))),
      pitches: [...new Set(group.notes.map(note => note.pitch))].sort((a, b) => a - b),
      velocity: Math.max(.15, Math.min(1, Math.max(...group.notes.map(note => note.volume ?? 80)) / 127)),
      measure: options.measureFor?.(first.track, start, startMs) ?? 0, repeatPass: 0,
      voiceLabel: first.voiceLabel || options.voiceLabelFor?.(first.track) || `Voice ${first.track + 1}`,
      sourceRanges: sourceBound ? [{ start, end, voiceId }] : [], firstIndex: group.firstIndex,
    };
  }).sort((a, b) => a.startMs - b.startMs || a.firstIndex - b.firstIndex);
  const passBySpan = new Map<string, number>();
  return occurrences.map((occurrence, index) => {
    const spanKey = `${occurrence.voiceId}:${occurrence.start}:${occurrence.end}`;
    const repeatPass = occurrence.start < 0 ? 1 : (passBySpan.get(spanKey) ?? 0) + 1; if(occurrence.start>=0)passBySpan.set(spanKey, repeatPass);
    const { firstIndex: _firstIndex, ...note } = occurrence;
    return { ...note, repeatPass, id: `n${index}-${occurrence.voiceId}-${occurrence.start}-${repeatPass}` };
  });
}

/** Merge only overlapping/adjacent ranges in the same voice. Never broad-min/max voices. */
export function normalizeRanges(ranges: SourceRange[]): SourceRange[] {
  const sorted = ranges
    .filter(range => Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end > range.start)
    .map(range => ({ ...range }))
    .sort((a, b) => a.voiceId.localeCompare(b.voiceId) || a.start - b.start || a.end - b.end);
  const result: SourceRange[] = [];
  for (const range of sorted) {
    const previous = result.at(-1);
    if (previous && previous.voiceId === range.voiceId && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else result.push(range);
  }
  return result;
}

export function selectTimelineRange(notes: TimelineNote[], anchorId: string, focusId: string, sourceVoiceId?: string): SourceSelection | undefined {
  const anchor = notes.find(note => note.id === anchorId);
  const focus = notes.find(note => note.id === focusId);
  if (!anchor || !focus) return undefined;
  const voiceId = sourceVoiceId ?? anchor.voiceId;
  const voiceAnchor = anchor.voiceId === voiceId ? anchor : undefined;
  const voiceFocus = focus.voiceId === voiceId ? focus : undefined;
  if (!voiceAnchor || !voiceFocus) return undefined;
  const startEndpoint = voiceAnchor.startMs <= voiceFocus.startMs ? voiceAnchor : voiceFocus;
  const endEndpoint = startEndpoint === voiceAnchor ? voiceFocus : voiceAnchor;
  const startMs = startEndpoint.startMs;
  const endMs = Math.max(startEndpoint.endMs, endEndpoint.endMs);
  const selected = notes.filter(note => note.startMs < endMs && note.endMs > startMs);
  const sourceSelected = selected.filter(note => note.voiceId === voiceId && note.sourceRanges.length);
  const ranges = normalizeRanges(sourceSelected.flatMap(note => note.sourceRanges));
  const measures = [...new Set(sourceSelected.map(note => note.measure + 1))].sort((a, b) => a - b);
  const bars = measures.length === 1 ? `Bar ${measures[0]}` : `Bars ${measures[0]}–${measures.at(-1)}`;
  const label = `${bars} · ${voiceAnchor.voiceLabel}`;
  return {
    kind: "abc-source-ranges", unit: "utf16", sourceVoiceId: voiceId,
    endpoints: { startOccurrenceId: startEndpoint.id, endOccurrenceId: endEndpoint.id },
    ranges, label,
    playback: {
      startMs, endMs,
      occurrenceIds: selected.map(note => note.id),
      repeatPasses: [...new Set(selected.map(note => note.repeatPass))].sort((a, b) => a - b),
    },
  };
}

export interface SelectionBoundaryGesture {
  boundary: "start" | "end";
  sourceVoiceId: string;
  oppositeOccurrenceId: string;
}

/** Freeze the physical handle's opposite endpoint for the entire pointer gesture. */
export function beginSelectionBoundaryMove(selection: SourceSelection, boundary: "start" | "end"): SelectionBoundaryGesture {
  return {
    boundary,
    sourceVoiceId: selection.sourceVoiceId,
    oppositeOccurrenceId: boundary === "start" ? selection.endpoints.endOccurrenceId : selection.endpoints.startOccurrenceId,
  };
}

/** Replace one visual boundary while retaining the gesture's immutable opposite endpoint. */
export function moveSelectionBoundary(notes: TimelineNote[], gesture: SelectionBoundaryGesture, occurrenceId: string): SourceSelection | undefined {
  const target = notes.find(note => note.id === occurrenceId);
  const opposite = notes.find(note => note.id === gesture.oppositeOccurrenceId);
  if (!target || !opposite || target.voiceId !== gesture.sourceVoiceId || opposite.voiceId !== gesture.sourceVoiceId) return undefined;
  return gesture.boundary === "start"
    ? selectTimelineRange(notes, target.id, opposite.id, gesture.sourceVoiceId)
    : selectTimelineRange(notes, opposite.id, target.id, gesture.sourceVoiceId);
}

export function chooseOccurrence(notes: TimelineNote[], start: number, end: number, playheadMs: number, voiceId?: string): TimelineNote | undefined {
  const candidates = notes.filter(note => note.start === start && note.end === end && (!voiceId || note.voiceId === voiceId));
  return candidates.find(note => note.startMs >= playheadMs) ?? candidates[0];
}

export function validateReviewRequest(input: {
  score: string;
  compositionRevision: number;
  scoreSha256: string;
  selection: SourceSelection;
  comment: string;
}): void {
  if (!Number.isInteger(input.compositionRevision) || input.compositionRevision < 1) throw new Error("Invalid composition revision.");
  if (!/^[a-f0-9]{64}$/i.test(input.scoreSha256)) throw new Error("Invalid score hash.");
  if (input.comment.length > 4000) throw new Error("Comment exceeds 4000 characters.");
  if (!input.comment.trim()) throw new Error("Write a comment first.");
  if (input.selection.ranges.length < 1 || input.selection.ranges.length > 32) throw new Error("Selection must contain 1–32 source ranges.");
  for (const range of input.selection.ranges) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > input.score.length) throw new Error("Selection is outside the canonical score.");
    if (!range.voiceId || range.voiceId.length > 100) throw new Error("Selection has an invalid voice.");
  }
}
