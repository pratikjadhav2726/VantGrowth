/**
 * GET /v1/motion — returns the current motion stack overview for a tenant.
 *
 * Response:
 *   {
 *     latestScore: MotionScore | null,
 *     latestStack: MotionStack | null,
 *     recentScores: MotionScore[],   // last 7 by default
 *   }
 *
 * Used by the `apps/web` Motion Stack page to surface live data.
 */

import type { MotionStackRepository } from "@growthos/db";
import { Hono } from "hono";
import { ServiceUnavailableError } from "../http-errors.js";

export interface MotionRouteDependencies {
  motionStackRepository: MotionStackRepository | null;
}

export const createMotionRoutes = (deps: MotionRouteDependencies): Hono => {
  const route = new Hono();

  /**
   * GET /v1/motion
   *
   * Headers:
   *   X-Tenant-Id: <uuid>  (required)
   *
   * Query params:
   *   historyLimit  — number of recent score rows to return (default: 7, max: 30)
   */
  route.get("/", async (c) => {
    if (!deps.motionStackRepository) {
      throw new ServiceUnavailableError(
        "Motion stack repository is not configured. Set DATABASE_URL.",
      );
    }

    const tenantId = c.req.header("X-Tenant-Id");
    if (!tenantId) {
      return c.json({ error: "X-Tenant-Id header is required" }, 400);
    }

    const historyLimitRaw = Number(c.req.query("historyLimit") ?? "7");
    const historyLimit = Math.min(
      Math.max(1, Number.isNaN(historyLimitRaw) ? 7 : historyLimitRaw),
      30,
    );

    const overview = await deps.motionStackRepository.getOverview(
      tenantId,
      historyLimit,
    );

    return c.json(overview, 200);
  });

  return route;
};
