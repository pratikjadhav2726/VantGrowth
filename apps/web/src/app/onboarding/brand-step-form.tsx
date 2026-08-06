"use client";

import { useMemo, useState } from "react";

interface BrandStepFormProps {
  defaults: Record<string, string>;
  submitAction: (formData: FormData) => Promise<void>;
}

const MIN_POSITIONING_LENGTH = 20;
const MAX_PROOF_LENGTH = 500;
const MAX_WORDS_TO_AVOID_LENGTH = 2000;

export function BrandStepForm({ defaults, submitAction }: BrandStepFormProps) {
  const [positioning, setPositioning] = useState(defaults.positioning ?? "");
  const [proof1, setProof1] = useState(defaults.proof1 ?? "");
  const [proof2, setProof2] = useState(defaults.proof2 ?? "");
  const [proof3, setProof3] = useState(defaults.proof3 ?? "");
  const [wordsToAvoid, setWordsToAvoid] = useState(defaults.wordsToAvoid ?? "");

  const trimmedLength = positioning.trim().length;
  const positioningError =
    trimmedLength > 0 && trimmedLength < MIN_POSITIONING_LENGTH
      ? `Positioning should be at least ${MIN_POSITIONING_LENGTH} characters`
      : null;
  const proof1Error =
    proof1.length > MAX_PROOF_LENGTH
      ? `Keep proof point 1 under ${MAX_PROOF_LENGTH} characters`
      : null;
  const proof2Error =
    proof2.length > MAX_PROOF_LENGTH
      ? `Keep proof point 2 under ${MAX_PROOF_LENGTH} characters`
      : null;
  const proof3Error =
    proof3.length > MAX_PROOF_LENGTH
      ? `Keep proof point 3 under ${MAX_PROOF_LENGTH} characters`
      : null;
  const wordsToAvoidError =
    wordsToAvoid.length > MAX_WORDS_TO_AVOID_LENGTH
      ? `Keep this list under ${MAX_WORDS_TO_AVOID_LENGTH} characters`
      : null;

  const isFormValid = useMemo(
    () =>
      trimmedLength >= MIN_POSITIONING_LENGTH &&
      !proof1Error &&
      !proof2Error &&
      !proof3Error &&
      !wordsToAvoidError,
    [trimmedLength, proof1Error, proof2Error, proof3Error, wordsToAvoidError],
  );

  return (
    <form action={submitAction} className="space-y-5">
      <div>
        <label
          className="block text-sm font-medium text-gray-700 mb-1.5"
          htmlFor="positioning"
        >
          One-sentence positioning <span className="text-red-500">*</span>
        </label>
        <textarea
          id="positioning"
          name="positioning"
          required
          minLength={MIN_POSITIONING_LENGTH}
          rows={2}
          value={positioning}
          onChange={(event) => setPositioning(event.target.value)}
          placeholder="e.g. GrowthOS turns founder expertise into a scalable GTM content engine that publishes every day without adding headcount."
          aria-describedby="positioning-hint positioning-error"
          className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 resize-none"
        />
        <p id="positioning-hint" className="mt-1 text-xs text-gray-500">
          At least 20 characters.
        </p>
        <p
          id="positioning-error"
          className="mt-1 text-xs text-red-600"
          aria-live="polite"
        >
          {positioningError ?? ""}
        </p>
      </div>

      <fieldset>
        <legend className="block text-sm font-medium text-gray-700 mb-1.5">
          Top 3 proof points
        </legend>
        <div className="space-y-2">
          <div>
            <input
              name="proof1"
              type="text"
              value={proof1}
              onChange={(event) => setProof1(event.target.value)}
              placeholder="e.g. Customers see 3× more content in 30 days"
              aria-describedby="proof1-error"
              className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
            <p
              id="proof1-error"
              className="mt-1 text-xs text-red-600"
              aria-live="polite"
            >
              {proof1Error ?? ""}
            </p>
          </div>
          <div>
            <input
              name="proof2"
              type="text"
              value={proof2}
              onChange={(event) => setProof2(event.target.value)}
              placeholder="e.g. Average 94% approval rate, first pass"
              aria-describedby="proof2-error"
              className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
            <p
              id="proof2-error"
              className="mt-1 text-xs text-red-600"
              aria-live="polite"
            >
              {proof2Error ?? ""}
            </p>
          </div>
          <div>
            <input
              name="proof3"
              type="text"
              value={proof3}
              onChange={(event) => setProof3(event.target.value)}
              placeholder="e.g. Deployed by 50+ series A/B companies"
              aria-describedby="proof3-error"
              className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
            <p
              id="proof3-error"
              className="mt-1 text-xs text-red-600"
              aria-live="polite"
            >
              {proof3Error ?? ""}
            </p>
          </div>
        </div>
      </fieldset>

      <div>
        <label
          className="block text-sm font-medium text-gray-700 mb-1.5"
          htmlFor="tone"
        >
          Communication tone
        </label>
        <select
          id="tone"
          name="tone"
          defaultValue={defaults.tone ?? "founder-voice"}
          className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        >
          <option value="founder-voice">
            Founder voice (direct, opinionated)
          </option>
          <option value="professional">
            Professional (structured, formal)
          </option>
          <option value="conversational">
            Conversational (warm, approachable)
          </option>
          <option value="technical">Technical (precise, detail-rich)</option>
        </select>
      </div>

      <div>
        <label
          className="block text-sm font-medium text-gray-700 mb-1.5"
          htmlFor="wordsToAvoid"
        >
          Words / phrases to avoid
        </label>
        <input
          id="wordsToAvoid"
          name="wordsToAvoid"
          type="text"
          value={wordsToAvoid}
          onChange={(event) => setWordsToAvoid(event.target.value)}
          placeholder="e.g. revolutionary, disruptive, synergy"
          aria-describedby="words-to-avoid-hint words-to-avoid-error"
          className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        />
        <p id="words-to-avoid-hint" className="mt-1 text-xs text-gray-400">
          Comma-separated list
        </p>
        <p
          id="words-to-avoid-error"
          className="mt-1 text-xs text-red-600"
          aria-live="polite"
        >
          {wordsToAvoidError ?? ""}
        </p>
      </div>

      <div className="pt-2">
        <button
          type="submit"
          disabled={!isFormValid}
          className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 transition-colors disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          Continue →
        </button>
      </div>
    </form>
  );
}
