import type { Context } from "hono";
import { ZodError } from "zod";
import { HttpError } from "./http-errors.js";

export const mapErrorToResponse = (error: unknown, c: Context): Response => {
  if (error instanceof ZodError) {
    return c.json(
      {
        error: "Request validation failed",
        details: error.issues
      },
      400
    );
  }

  if (error instanceof HttpError) {
    return c.json(
      {
        error: error.message,
        details: error.details
      },
      error.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503
    );
  }

  return c.json(
    {
      error: "Internal server error"
    },
    500
  );
};
