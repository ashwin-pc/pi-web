export type StreamingBatch<T> = {
  queue: (value: T) => void;
  flush: (value?: T) => void;
  cancel: () => void;
};

export function createStreamingBatch<T>(
  delayMs: number,
  render: (value: T) => void,
  timers: {
    set: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clear: (id: ReturnType<typeof setTimeout>) => void;
  } = {
    set: (callback, delay) => globalThis.setTimeout(callback, delay),
    clear: (id) => globalThis.clearTimeout(id),
  },
): StreamingBatch<T> {
  let pending: T | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelTimer = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
  };

  return {
    queue(value) {
      pending = value;
      if (timer !== undefined) return;
      timer = timers.set(() => {
        timer = undefined;
        const valueToRender = pending;
        pending = undefined;
        if (valueToRender !== undefined) render(valueToRender);
      }, delayMs);
    },
    flush(value) {
      if (value !== undefined) pending = value;
      cancelTimer();
      const valueToRender = pending;
      pending = undefined;
      if (valueToRender !== undefined) render(valueToRender);
    },
    cancel() {
      cancelTimer();
      pending = undefined;
    },
  };
}
