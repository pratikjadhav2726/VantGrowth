import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Timing-safe string comparison — always runs in constant time relative to `a`
 * even when lengths differ, preventing length-based timing attacks.
 */
const safeCompare = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // burn constant time
    return false;
  }
  return timingSafeEqual(bufA, bufB);
};

export interface ApiAuthConfig {
  /**
   * The expected service token. When null the middleware is permissive —
   * all requests pass through. Set GROWTHOS_API_SERVICE_TOKEN in production.
   */
  serviceToken: string | null;
}

/**
 * Hono middleware that enforces `Authorization: Bearer <token>` on the routes
 * it is mounted on.
 *
 * Permissive (no-op) when `serviceToken` is null so that unit tests and local
 * dev environments work without configuration.
 */
export const createApiTokenMiddleware =
  (config: ApiAuthConfig): MiddlewareHandler =>
  async (c, next) => {
    if (!config.serviceToken) {
      return next();
    }

    const auth = c.req.header("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      return c.json({ error: "Authorization required" }, 401);
    }

    const provided = auth.slice("Bearer ".length);
    if (!safeCompare(provided, config.serviceToken)) {
      return c.json({ error: "Invalid token" }, 401);
    }

    return next();
  };
