import type {
  GoldenEvalSuiteResult,
  HarnessAblationComparison,
} from "./evals.js";

export type HarnessLayer = "control" | "agency" | "runtime" | "verification";
export type HarnessComponentStatus =
  | "implemented"
  | "partial"
  | "planned"
  | "missing";

export interface HarnessComponentRecord {
  name: string;
  layer: HarnessLayer;
  status: HarnessComponentStatus;
  version?: string;
  evidence?: string;
  gap?: string;
}

export interface HarnessCardInput {
  harnessName: string;
  owner: string;
  generatedAt: Date;
  modelPolicy: string;
  promptPriorityPolicy: string;
  components: HarnessComponentRecord[];
  goldenEval?: GoldenEvalSuiteResult;
  ablation?: HarnessAblationComparison;
  knownGaps?: string[];
}

const statusIcon: Record<HarnessComponentStatus, string> = {
  implemented: "yes",
  partial: "partial",
  planned: "planned",
  missing: "missing",
};

const formatPct = (value: number): string => `${(value * 100).toFixed(1)}%`;

export const renderHarnessCardMarkdown = (input: HarnessCardInput): string => {
  const lines: string[] = [
    `# ${input.harnessName} Harness Card`,
    "",
    `- Owner: ${input.owner}`,
    `- Generated: ${input.generatedAt.toISOString()}`,
    `- Model policy: ${input.modelPolicy}`,
    `- Prompt priority: ${input.promptPriorityPolicy}`,
    "",
    "## Component Coverage",
    "",
    "| Layer | Component | Status | Version | Evidence | Gap |",
    "|---|---|---|---|---|---|",
  ];

  for (const component of input.components) {
    lines.push(
      `| ${[
        component.layer,
        component.name,
        statusIcon[component.status],
        component.version ?? "",
        component.evidence ?? "",
        component.gap ?? "",
      ].join(" | ")} |`,
    );
  }

  if (input.goldenEval) {
    lines.push(
      "",
      "## Golden Eval",
      "",
      `- Cases: ${input.goldenEval.totalCases}`,
      `- Attempts: ${input.goldenEval.totalAttempts}`,
      `- pass@1: ${formatPct(input.goldenEval.passAt1)}`,
      `- pass^k: ${formatPct(input.goldenEval.passK)}`,
      `- Passed: ${input.goldenEval.passed ? "yes" : "no"}`,
    );
  }

  if (input.ablation) {
    lines.push(
      "",
      "## Ablation",
      "",
      `- pass@1 delta: ${formatPct(input.ablation.passAt1Delta)}`,
      `- pass^k delta: ${formatPct(input.ablation.passKDelta)}`,
      `- Clears infra-noise threshold: ${
        input.ablation.exceedsInfraNoise ? "yes" : "no"
      }`,
    );
  }

  if (input.knownGaps?.length) {
    lines.push("", "## Known Gaps", "");
    for (const gap of input.knownGaps) {
      lines.push(`- ${gap}`);
    }
  }

  return `${lines.join("\n")}\n`;
};

export const summarizeHarnessCoverage = (
  components: HarnessComponentRecord[],
): Record<
  HarnessLayer,
  { implemented: number; total: number; score: number }
> => {
  const layers: HarnessLayer[] = [
    "control",
    "agency",
    "runtime",
    "verification",
  ];
  return Object.fromEntries(
    layers.map((layer) => {
      const layerComponents = components.filter((c) => c.layer === layer);
      const implemented = layerComponents.filter(
        (c) => c.status === "implemented",
      ).length;
      const partial = layerComponents.filter(
        (c) => c.status === "partial",
      ).length;
      const total = layerComponents.length;
      const score = total === 0 ? 0 : (implemented + partial * 0.5) / total;
      return [layer, { implemented, total, score }];
    }),
  ) as Record<
    HarnessLayer,
    { implemented: number; total: number; score: number }
  >;
};
