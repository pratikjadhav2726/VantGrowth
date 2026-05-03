import { z } from "zod";

export const workflowRunStateSchema = z.enum([
  "requested",
  "in_progress",
  "completed",
  "failed",
]);

export type WorkflowRunState = z.infer<typeof workflowRunStateSchema>;

export const callbackTypeSchema = z.enum(["progress", "completed", "failed"]);

export type CallbackType = z.infer<typeof callbackTypeSchema>;

const TERMINAL_STATES = new Set<WorkflowRunState>(["completed", "failed"]);

const ALLOWED_TRANSITIONS: Record<WorkflowRunState, Set<WorkflowRunState>> = {
  requested: new Set(["in_progress", "completed", "failed"]),
  in_progress: new Set(["in_progress", "completed", "failed"]),
  completed: new Set(),
  failed: new Set(),
};

export const isTerminalState = (state: WorkflowRunState): boolean =>
  TERMINAL_STATES.has(state);

export type WorkflowTransitionOk = {
  ok: true;
  toState: WorkflowRunState;
};

export type WorkflowTransitionError = {
  ok: false;
  reason: string;
  fromState: WorkflowRunState;
  toState: WorkflowRunState;
};

export type WorkflowTransitionResult =
  | WorkflowTransitionOk
  | WorkflowTransitionError;

export const validateWorkflowTransition = (
  from: WorkflowRunState,
  to: WorkflowRunState,
): WorkflowTransitionResult => {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.has(to)) {
    return {
      ok: false,
      reason: `Illegal workflow state transition: '${from}' → '${to}'. Terminal states accept no further transitions.`,
      fromState: from,
      toState: to,
    };
  }
  return { ok: true, toState: to };
};

/**
 * Maps a callback type reported by the runtime to the resulting workflow state.
 * - progress  → in_progress (workflow is executing)
 * - completed → completed   (workflow finished successfully)
 * - failed    → failed      (workflow finished with an error)
 */
export const callbackTypeToState = (
  callbackType: CallbackType,
): WorkflowRunState => {
  switch (callbackType) {
    case "progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
};

/**
 * Returns the set of states that can legally receive the given callback type
 * given a known current state. Used to validate before emitting events.
 *
 * Without a persistent state store, callers should pass the last known state
 * (defaulting to "requested" for the first callback).
 */
export const isCallbackLegalFromState = (
  currentState: WorkflowRunState,
  callbackType: CallbackType,
): boolean => {
  const targetState = callbackTypeToState(callbackType);
  return validateWorkflowTransition(currentState, targetState).ok;
};
