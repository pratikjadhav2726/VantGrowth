/**
 * Signal Ingest — Phase 1 S5
 *
 * Allows founders to manually submit competitive / community / product
 * signals that flow into the Intel Director pipeline.
 */

"use client";

import {
  type SignalGradeApiResponse,
  ingestSignal,
  postSignalGrade,
} from "@/lib/api-client";
import { useState } from "react";

const DEV_TENANT_ID =
  process.env.NEXT_PUBLIC_GROWTHOS_DEV_TENANT_ID ??
  "00000000-0000-0000-0001-000000000001";

const SIGNAL_TYPES = [
  { value: "competitive", label: "Competitive" },
  { value: "community", label: "Community" },
  { value: "icp", label: "ICP / Buyer" },
  { value: "product", label: "Product" },
  { value: "market", label: "Market" },
  { value: "internal", label: "Internal" },
] as const;

type SignalType = (typeof SIGNAL_TYPES)[number]["value"];

export default function SignalsPage() {
  const [signalType, setSignalType] = useState<SignalType>("competitive");
  const [source, setSource] = useState("");
  const [externalId, setExternalId] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [result, setResult] = useState<{
    inserted: boolean;
    signalId: string;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [gradeStatus, setGradeStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [gradeResult, setGradeResult] = useState<SignalGradeApiResponse | null>(
    null,
  );

  const handlePreviewGrade = async () => {
    if (!source.trim()) return;
    setGradeStatus("loading");
    setGradeResult(null);
    setErrorMessage(null);

    try {
      const res = await postSignalGrade(DEV_TENANT_ID, {
        signalType,
        source: source.trim(),
        payload: note.trim() ? { note: note.trim() } : {},
      });
      setGradeResult(res);
      setGradeStatus("ready");
    } catch (err) {
      setGradeStatus("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to grade signal.",
      );
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!source.trim()) return;

    setStatus("loading");
    setResult(null);
    setErrorMessage(null);

    try {
      const res = await ingestSignal(DEV_TENANT_ID, {
        signalType,
        source: source.trim(),
        ...(externalId.trim() ? { externalId: externalId.trim() } : {}),
        payload: note.trim() ? { note: note.trim() } : {},
      });
      setResult({ inserted: res.inserted, signalId: res.signalId });
      setStatus("success");
      setGradeStatus("idle");
      setGradeResult(null);
      setSource("");
      setNote("");
      setExternalId("");
    } catch (err) {
      setStatus("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to ingest signal.",
      );
    }
  };

  return (
    <div className="max-w-2xl">
      {/* ── Page header ─────────────────────────────────────────────── */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">
          Signal Ingest
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Submit competitive intelligence, community mentions, or market signals
          to the Intel Director pipeline.
        </p>
      </div>

      {/* ── Ingest form ─────────────────────────────────────────────── */}
      <form
        onSubmit={handleSubmit}
        className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm"
      >
        <div className="space-y-5">
          {/* Signal type */}
          <fieldset>
            <legend className="block text-sm font-medium text-gray-700">
              Signal type
            </legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {SIGNAL_TYPES.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSignalType(value)}
                  aria-pressed={signalType === value}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                    signalType === value
                      ? "bg-brand-600 text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          {/* Source */}
          <div>
            <label
              htmlFor="source"
              className="block text-sm font-medium text-gray-700"
            >
              Source <span className="text-red-400">*</span>
            </label>
            <input
              id="source"
              type="text"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="e.g. twitter, g2, linkedin, intercom"
              required
              className="mt-1.5 w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          {/* External ID */}
          <div>
            <label
              htmlFor="externalId"
              className="block text-sm font-medium text-gray-700"
            >
              External ID{" "}
              <span className="text-xs font-normal text-gray-400">
                (optional — used for deduplication)
              </span>
            </label>
            <input
              id="externalId"
              type="text"
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              placeholder="e.g. tweet-1847362947382"
              className="mt-1.5 w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          {/* Note */}
          <div>
            <label
              htmlFor="note"
              className="block text-sm font-medium text-gray-700"
            >
              Note{" "}
              <span className="text-xs font-normal text-gray-400">
                (optional — added to payload)
              </span>
            </label>
            <textarea
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Describe the signal: what happened, why it matters..."
              className="mt-1.5 w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none"
            />
          </div>
        </div>

        {/* Submit */}
        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            disabled={gradeStatus === "loading" || !source.trim()}
            onClick={handlePreviewGrade}
            className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-gray-300 focus:ring-offset-2"
          >
            {gradeStatus === "loading" ? "Grading…" : "Preview signal grade"}
          </button>
          <button
            type="submit"
            disabled={status === "loading" || !source.trim()}
            className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
          >
            {status === "loading" ? (
              <>
                <svg
                  className="h-4 w-4 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <title>Loading</title>
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Ingesting…
              </>
            ) : (
              "Ingest signal"
            )}
          </button>
        </div>

        {/* Grade preview */}
        {gradeStatus === "ready" && gradeResult && (
          <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-4">
            {gradeResult.graded && gradeResult.grade ? (
              <>
                <p className="text-sm font-medium text-blue-900">
                  Signal grade: {Math.round(gradeResult.grade.relevance * 100)}{" "}
                  / 100 · {gradeResult.grade.urgency}
                </p>
                <p className="mt-1 text-xs text-blue-700">
                  Topic: {gradeResult.grade.topicCategory}
                </p>
                {gradeResult.grade.actionRecommendations.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-xs text-blue-700">
                    {gradeResult.grade.actionRecommendations.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-sm text-blue-800">
                No grade could be derived from the current signal payload.
              </p>
            )}
          </div>
        )}

        {/* Status messages */}
        {status === "success" && result && (
          <div className="mt-4 rounded-md bg-green-50 p-4">
            <p className="text-sm font-medium text-green-800">
              {result.inserted
                ? "✓ Signal ingested"
                : "Signal already exists (duplicate)"}
            </p>
            <p className="mt-0.5 font-mono text-xs text-green-600">
              ID: {result.signalId}
            </p>
          </div>
        )}

        {status === "error" && errorMessage && (
          <div className="mt-4 rounded-md bg-red-50 p-4">
            <p className="text-sm text-red-700">{errorMessage}</p>
          </div>
        )}
      </form>

      {/* ── Pipeline info ────────────────────────────────────────────── */}
      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
        <h3 className="text-sm font-semibold text-gray-900">Signal pipeline</h3>
        <div className="mt-3 flex items-center gap-2 text-xs text-gray-500">
          {[
            "Signal ingest",
            "signal_events (Postgres)",
            "IntelDirectorWorker",
            "intel_brief.v1 (NATS)",
            "ContentStrategistWorker",
            "blog_draft.v1",
            "Approval queue",
          ].map((step, i, arr) => (
            <span key={step} className="flex items-center gap-2">
              <span className="rounded-full bg-gray-100 px-2 py-0.5 font-medium text-gray-600">
                {step}
              </span>
              {i < arr.length - 1 && <span className="text-gray-300">→</span>}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
