/**
 * SignalQualityGrader — Phase 1 / S2
 *
 * Thin adapter over `@growthos/llm-harness` `gradeSignalPayload()` for
 * `IncomingSignal` records from the router.
 */

import { gradeSignalPayload } from "@growthos/llm-harness";
import type { LlmCallRunner } from "@growthos/llm-harness";
import type { IncomingSignal, SignalGrade } from "./contracts.js";

/**
 * Attempts to grade a signal via the LLM runner.
 *
 * @returns Parsed `SignalGrade` or `null` on any failure.
 */
export const gradeSignal = async (
  signal: IncomingSignal,
  runner: LlmCallRunner,
  motionContext = "inbound_content, plg",
): Promise<SignalGrade | null> =>
  gradeSignalPayload(
    {
      tenantId: signal.tenantId,
      signalType: signal.kind,
      source: signal.source,
      payload: signal.payload,
    },
    runner,
    motionContext,
  );
