export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
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

export class UnauthorizedError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(message, 401, details);
    this.name = "UnauthorizedError";
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(message, 409, details);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(message, 404, details);
    this.name = "NotFoundError";
  }
}
