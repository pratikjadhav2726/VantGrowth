export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(message, 503, details);
    this.name = "ServiceUnavailableError";
  }
}
