const recognizedErrorStatuses = new Set([400, 401, 403, 404, 409, 410, 413, 415, 422, 429, 500]);

/** Only status codes that this API deliberately exposes may cross an error boundary. */
export function isRecognizedErrorStatus(status: unknown): status is number {
  return typeof status === "number" && Number.isInteger(status) && recognizedErrorStatuses.has(status);
}

export class HttpStatusError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = isRecognizedErrorStatus(status) ? status : 400;
  }
}

/** Extract a status only from a recognized, trusted error type. */
export function errorStatus(error: unknown, fallback = 500): number {
  return error instanceof HttpStatusError ? error.status : fallback;
}
