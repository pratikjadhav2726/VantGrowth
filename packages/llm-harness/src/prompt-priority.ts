export const PROMPT_PRIORITY_STACK = [
  "system",
  "tool",
  "developer",
  "repo",
  "user",
  "history",
] as const;

export type PromptPrioritySource = (typeof PROMPT_PRIORITY_STACK)[number];

const PRIORITY_INDEX = new Map<PromptPrioritySource, number>(
  PROMPT_PRIORITY_STACK.map((source, index) => [source, index]),
);

export interface PromptInstruction {
  source: PromptPrioritySource;
  key: string;
  value: string;
}

export interface ResolvedPromptInstruction extends PromptInstruction {
  overriddenBy?: PromptInstruction;
}

export const comparePromptPriority = (
  left: PromptPrioritySource,
  right: PromptPrioritySource,
): number => {
  const leftIndex = PRIORITY_INDEX.get(left);
  const rightIndex = PRIORITY_INDEX.get(right);
  if (leftIndex === undefined || rightIndex === undefined) {
    throw new Error("Unknown prompt priority source");
  }
  return rightIndex - leftIndex;
};

export const resolvePromptInstructions = (
  instructions: PromptInstruction[],
): ResolvedPromptInstruction[] => {
  const winners = new Map<string, PromptInstruction>();

  for (const instruction of instructions) {
    const current = winners.get(instruction.key);
    if (
      !current ||
      comparePromptPriority(instruction.source, current.source) > 0
    ) {
      winners.set(instruction.key, instruction);
    }
  }

  return instructions.map((instruction) => {
    const winner = winners.get(instruction.key);
    if (!winner || winner === instruction) return instruction;
    return { ...instruction, overriddenBy: winner };
  });
};
