"use client";

import {
  ApiError,
  type MotionScoringFields,
  postMotionScore,
} from "@/lib/api-client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

const SLIDER_FIELDS: Array<{ key: keyof MotionScoringFields; label: string }> =
  [
    { key: "productComplexity", label: "Product complexity" },
    { key: "trialability", label: "Trialability" },
    { key: "acvBand", label: "ACV band (fit)" },
    { key: "founderContentCapacity", label: "Founder content capacity" },
    { key: "categorySearchDemand", label: "Category search demand" },
    { key: "communityDensity", label: "Community density" },
    { key: "telemetryReadiness", label: "Telemetry readiness" },
    { key: "budgetReadiness", label: "Budget readiness" },
  ];

const DEFAULT_FIELDS: MotionScoringFields = {
  productComplexity: 0.7,
  trialability: 0.6,
  acvBand: 0.5,
  salesCycleWeeks: 6,
  founderContentCapacity: 0.8,
  categorySearchDemand: 0.9,
  communityDensity: 0.7,
  telemetryReadiness: 0.6,
  budgetReadiness: 0.5,
};

export function MotionScoreForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fields, setFields] = useState<MotionScoringFields>(DEFAULT_FIELDS);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const update =
    (key: keyof MotionScoringFields) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = Number(e.target.value);
      if (key === "salesCycleWeeks") {
        setFields((f) => ({ ...f, salesCycleWeeks: Math.max(0, raw) }));
      } else {
        setFields((f) => ({
          ...f,
          [key]: Math.min(1, Math.max(0, raw / 100)),
        }));
      }
    };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const res = await postMotionScore(tenantId, fields);
        setMessage(
          `Recorded run ${res.scoreId.slice(0, 8)}… · primary: ${res.primaryMotions.join(", ")} · stack updated: ${res.stackUpdated ? "yes" : "no"}`,
        );
        router.refresh();
      } catch (err) {
        setError(
          err instanceof ApiError
            ? `${err.status}: ${err.message}`
            : "Request failed",
        );
      }
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      className="mt-4 space-y-4 rounded-lg border border-gray-200 bg-white p-6"
    >
      <fieldset>
        <legend className="text-sm font-semibold text-gray-900">
          GTM inputs (0–100)
        </legend>
        <p className="mt-1 text-xs text-gray-500">
          Sliders map to the deterministic motion scorer. Results persist to{" "}
          <code className="rounded bg-gray-100 px-1">motion_scores</code>.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {SLIDER_FIELDS.map(({ key, label }) => (
            <label key={key} className="block text-xs text-gray-700">
              <span className="mb-1 block font-medium">{label}</span>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round((fields[key] as number) * 100)}
                  onChange={update(key)}
                  className="flex-1"
                />
                <span className="w-8 tabular-nums text-gray-600">
                  {Math.round((fields[key] as number) * 100)}
                </span>
              </div>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block text-xs text-gray-700">
        <span className="mb-1 block font-medium">Sales cycle (weeks)</span>
        <input
          type="number"
          min={0}
          max={104}
          step={1}
          value={fields.salesCycleWeeks}
          onChange={update("salesCycleWeeks")}
          className="w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {pending ? "Scoring…" : "Run motion scoring"}
        </button>
        <button
          type="button"
          className="text-sm text-gray-500 underline"
          onClick={() => setFields(DEFAULT_FIELDS)}
        >
          Reset defaults
        </button>
      </div>

      {message && <p className="text-sm text-green-700">{message}</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </form>
  );
}
