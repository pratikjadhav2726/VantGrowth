"use client";

import { useMemo, useState } from "react";

interface CompanyStepFormProps {
  defaults: Record<string, string>;
  submitAction: (formData: FormData) => Promise<void>;
}

const MIN_ICP_LENGTH = 10;

const isValidWebsiteUrl = (value: string): boolean => {
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

export function CompanyStepForm({
  defaults,
  submitAction,
}: CompanyStepFormProps) {
  const [companyName, setCompanyName] = useState(defaults.companyName ?? "");
  const [website, setWebsite] = useState(defaults.website ?? "");
  const [icpDescription, setIcpDescription] = useState(
    defaults.icpDescription ?? "",
  );

  const companyNameError =
    companyName.trim().length === 0 ? "Company name is required" : null;
  const websiteError = isValidWebsiteUrl(website)
    ? null
    : "Enter a valid URL, or leave blank";
  const icpError =
    icpDescription.trim().length < MIN_ICP_LENGTH
      ? `Add a bit more detail on your ICP (at least ${MIN_ICP_LENGTH} characters)`
      : null;

  const isFormValid = useMemo(
    () => !companyNameError && !websiteError && !icpError,
    [companyNameError, websiteError, icpError],
  );

  return (
    <form action={submitAction} className="space-y-5">
      <div>
        <label
          className="block text-sm font-medium text-gray-700 mb-1.5"
          htmlFor="companyName"
        >
          Company name <span className="text-red-500">*</span>
        </label>
        <input
          id="companyName"
          name="companyName"
          type="text"
          required
          value={companyName}
          onChange={(event) => setCompanyName(event.target.value)}
          placeholder="Acme GTM"
          aria-describedby="company-name-error"
          className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        />
        <p
          id="company-name-error"
          className="mt-1 text-xs text-red-600"
          aria-live="polite"
        >
          {companyNameError ?? ""}
        </p>
      </div>

      <div>
        <label
          className="block text-sm font-medium text-gray-700 mb-1.5"
          htmlFor="website"
        >
          Website
        </label>
        <input
          id="website"
          name="website"
          type="url"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
          placeholder="https://acme.com"
          aria-describedby="website-error"
          className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        />
        <p
          id="website-error"
          className="mt-1 text-xs text-red-600"
          aria-live="polite"
        >
          {websiteError ?? ""}
        </p>
      </div>

      <div>
        <label
          className="block text-sm font-medium text-gray-700 mb-1.5"
          htmlFor="icpDescription"
        >
          Ideal customer profile (ICP) <span className="text-red-500">*</span>
        </label>
        <textarea
          id="icpDescription"
          name="icpDescription"
          required
          minLength={MIN_ICP_LENGTH}
          rows={3}
          value={icpDescription}
          onChange={(event) => setIcpDescription(event.target.value)}
          placeholder="e.g. Series A-B SaaS companies with 20-200 employees, Head of Marketing as buyer, $500K-$5M ACV deals"
          aria-describedby="icp-hint icp-error"
          className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 resize-none"
        />
        <p id="icp-hint" className="mt-1 text-xs text-gray-500">
          At least 10 characters.
        </p>
        <p
          id="icp-error"
          className="mt-1 text-xs text-red-600"
          aria-live="polite"
        >
          {icpError ?? ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            className="block text-sm font-medium text-gray-700 mb-1.5"
            htmlFor="headcount"
          >
            Team size
          </label>
          <select
            id="headcount"
            name="headcount"
            defaultValue={defaults.headcount ?? "11-50"}
            className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          >
            <option value="1-10">1-10</option>
            <option value="11-50">11-50</option>
            <option value="51-200">51-200</option>
            <option value="201-500">201-500</option>
            <option value="500+">500+</option>
          </select>
        </div>
        <div>
          <label
            className="block text-sm font-medium text-gray-700 mb-1.5"
            htmlFor="arr"
          >
            Current ARR
          </label>
          <select
            id="arr"
            name="arr"
            defaultValue={defaults.arr ?? "500k-2m"}
            className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          >
            <option value="pre-revenue">Pre-revenue</option>
            <option value="0-500k">$0-$500K</option>
            <option value="500k-2m">$500K-$2M</option>
            <option value="2m-10m">$2M-$10M</option>
            <option value="10m+">$10M+</option>
          </select>
        </div>
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
