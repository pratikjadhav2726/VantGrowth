"use client";

import { sendFounderDigest } from "@/lib/api-client";
import { useState } from "react";

interface DigestTriggerProps {
  tenantId: string;
  recipientEmail?: string;
}

export function DigestTrigger({
  tenantId,
  recipientEmail,
}: DigestTriggerProps) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [message, setMessage] = useState<string | null>(null);

  const handleSend = async () => {
    setState("sending");
    setMessage(null);
    try {
      const result = await sendFounderDigest(
        tenantId,
        recipientEmail ? { recipientEmail } : undefined,
      );
      setState("sent");
      setMessage(
        result.sent
          ? `Digest sent (${result.digestId})`
          : `Digest generated (email delivery: ${result.reason ?? "not configured"})`,
      );
    } catch {
      setState("error");
      setMessage("Failed to generate digest. Is the API running?");
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={handleSend}
        disabled={state === "sending"}
        className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:opacity-50 transition-colors"
      >
        {state === "sending" ? (
          <svg
            className="h-4 w-4 animate-spin text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
          >
            <title>Sending</title>
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
        ) : (
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <title>Send digest</title>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
        )}
        {state === "sending" ? "Sending…" : "Send weekly digest"}
      </button>
      {message && (
        <span
          className={`text-xs ${state === "error" ? "text-red-500" : "text-gray-500"}`}
        >
          {message}
        </span>
      )}
    </div>
  );
}
