export class PasswordWorkUnavailableError extends Error {
  constructor(message = "Password service busy; retry shortly") {
    super(message);
    this.name = "PasswordWorkUnavailableError";
  }
}

type Lane = "login" | "credential";
type Waiter = {
  start: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const WAIT_MS = 2_000;
const QUEUE_CAPACITY: Record<Lane, number> = {
  login: 4,
  credential: 4,
};
const queues: Record<Lane, Waiter[]> = {
  login: [],
  credential: [],
};
let active = false;

function nextWaiter(): Waiter | undefined {
  return queues.credential.shift() || queues.login.shift();
}

function release() {
  const next = nextWaiter();
  if (next) {
    clearTimeout(next.timer);
    next.start();
    return;
  }
  active = false;
}

export function runPasswordWork<T>(
  lane: Lane,
  work: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      active = true;
      let operation: Promise<T>;
      try {
        operation = work();
      } catch (error) {
        release();
        reject(error);
        return;
      }
      operation.then(
        (value) => {
          release();
          resolve(value);
        },
        (error) => {
          release();
          reject(error);
        },
      );
    };

    if (!active) {
      start();
      return;
    }
    if (queues[lane].length >= QUEUE_CAPACITY[lane]) {
      reject(new PasswordWorkUnavailableError());
      return;
    }
    const waiter = {
      start,
      reject,
      timer: setTimeout(() => {
        const index = queues[lane].indexOf(waiter);
        if (index >= 0) queues[lane].splice(index, 1);
        reject(new PasswordWorkUnavailableError());
      }, WAIT_MS),
    };
    waiter.timer.unref();
    queues[lane].push(waiter);
  });
}
