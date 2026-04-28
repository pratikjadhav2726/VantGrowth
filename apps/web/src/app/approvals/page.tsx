/**
 * Approval Queue — Phase 1 S5
 *
 * Lists pending blog draft events awaiting founder review.
 * Each card shows the draft metadata and Approve / Reject buttons.
 * Decisions are posted to POST /v1/approvals/decide.
 *
 * Server Component: data is fetched on the server, decisions are submitted
 * via a Server Action (App Router pattern).
 */

import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { listApprovals, submitApprovalDecision } from "@/lib/api-client";
import { revalidatePath } from "next/cache";

// ---------------------------------------------------------------------------
// Hardcoded dev tenant — in Phase 2 this comes from the session.
// ---------------------------------------------------------------------------

const DEV_TENANT_ID =
  process.env.GROWTHOS_DEV_TENANT_ID ?? "00000000-0000-0000-0001-000000000001";

// ---------------------------------------------------------------------------
// Server action: submit a decision
// ---------------------------------------------------------------------------

async function submitDecision(formData: FormData) {
  "use server";
  const issueId = formData.get("issueId") as string;
  const outputType = formData.get("outputType") as string;
  const action = formData.get("action") as "approved" | "rejected";
  const reviewerNote = (formData.get("reviewerNote") as string) || undefined;

  await submitApprovalDecision(DEV_TENANT_ID, {
    issueId,
    outputType,
    action,
    ...(reviewerNote !== undefined ? { reviewerNote } : {}),
    learnOptIn: true,
  });

  revalidatePath("/approvals");
}

// ---------------------------------------------------------------------------
// Blog draft payload shape (what arrives via blog_draft.v1 event)
// ---------------------------------------------------------------------------

interface BlogDraftPayload {
  draft_id?: string;
  brief_id?: string;
  title?: string;
  meta_description?: string;
  word_count?: number;
  reading_time_minutes?: number;
  quality_indicators?: {
    has_cta?: boolean;
    has_internal_links?: boolean;
    heading_count?: number;
  };
  status?: string;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ outputType?: string }>;
}) {
  const { outputType = "blog_draft.v1" } = await searchParams;

  let items: Awaited<ReturnType<typeof listApprovals>>["items"] = [];
  let fetchError: string | null = null;

  try {
    const response = await listApprovals(DEV_TENANT_ID, { outputType });
    items = response.items;
  } catch (err) {
    fetchError =
      err instanceof Error ? err.message : "Failed to load approval queue.";
  }

  const typeLabel: Record<string, string> = {
    "blog_draft.v1": "Blog Drafts",
    "content_brief.v1": "Content Briefs",
    "intel_brief.v1": "Intel Briefs",
  };

  return (
    <div>
      {/* ── Page header ─────────────────────────────────────────────── */}
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Approval Queue
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Review and approve AI-generated content before publishing.
          </p>
        </div>

        {/* Output type filter */}
        <div className="flex gap-2">
          {Object.entries(typeLabel).map(([type, label]) => (
            <a
              key={type}
              href={`/approvals?outputType=${type}`}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                outputType === type
                  ? "bg-brand-600 text-white"
                  : "bg-white text-gray-600 ring-1 ring-inset ring-gray-200 hover:bg-gray-50"
              }`}
            >
              {label}
            </a>
          ))}
        </div>
      </div>

      {/* ── Error state ─────────────────────────────────────────────── */}
      {fetchError && (
        <div className="mb-6 rounded-md bg-red-50 p-4 text-sm text-red-700">
          <strong>Error:</strong> {fetchError}
        </div>
      )}

      {/* ── Queue stats bar ──────────────────────────────────────────── */}
      {!fetchError && (
        <div className="mb-6 flex items-center gap-4 rounded-lg border border-gray-200 bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold text-gray-900">
              {items.length}
            </span>
            <span className="text-sm text-gray-500">
              pending {typeLabel[outputType] ?? outputType}
            </span>
          </div>
          <StatusBadge
            variant={items.length > 0 ? "pending" : "neutral"}
            label={items.length > 0 ? "Needs review" : "All clear"}
          />
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────────── */}
      {!fetchError && items.length === 0 && (
        <EmptyState
          title="No pending items"
          description="All generated content has been reviewed. New items will appear here when workers produce new drafts."
          icon={
            <svg
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden="true"
            >
              <title>All reviewed</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          }
        />
      )}

      {/* ── Draft cards ─────────────────────────────────────────────── */}
      {items.length > 0 && (
        <ul className="space-y-4">
          {items.map((item) => {
            const draft = item.payload as BlogDraftPayload;
            const issueId = draft.draft_id ?? draft.brief_id ?? item.eventId;

            return (
              <li
                key={item.eventId}
                className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
              >
                {/* Card header */}
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <StatusBadge variant="pending" label="Pending review" />
                      <span className="text-xs text-gray-400">
                        {new Date(item.enqueuedAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>

                    <h2 className="mt-2 text-base font-semibold text-gray-900 leading-snug">
                      {draft.title ?? "Untitled draft"}
                    </h2>

                    {draft.meta_description && (
                      <p className="mt-1 text-sm text-gray-500 line-clamp-2">
                        {draft.meta_description}
                      </p>
                    )}
                  </div>

                  {/* Quality indicators */}
                  {draft.quality_indicators && (
                    <div className="shrink-0 text-right">
                      <p className="text-xs text-gray-400 mb-1.5">
                        Quality signals
                      </p>
                      <div className="flex flex-col items-end gap-1">
                        <QualityChip
                          passed={draft.quality_indicators.has_cta ?? false}
                          label="Has CTA"
                        />
                        <QualityChip
                          passed={
                            draft.quality_indicators.has_internal_links ?? false
                          }
                          label="Internal links"
                        />
                        <QualityChip
                          passed={
                            (draft.quality_indicators.heading_count ?? 0) >= 3
                          }
                          label={`${draft.quality_indicators.heading_count ?? 0} headings`}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Draft stats */}
                {(draft.word_count ?? draft.reading_time_minutes) && (
                  <div className="mt-3 flex items-center gap-4 text-xs text-gray-500">
                    {draft.word_count && (
                      <span>{draft.word_count.toLocaleString()} words</span>
                    )}
                    {draft.reading_time_minutes && (
                      <span>{draft.reading_time_minutes} min read</span>
                    )}
                    {draft.brief_id && (
                      <span className="font-mono">
                        brief: {draft.brief_id.slice(-8)}
                      </span>
                    )}
                  </div>
                )}

                {/* Action form */}
                <form
                  action={submitDecision}
                  className="mt-5 flex items-end gap-3 border-t border-gray-100 pt-4"
                >
                  <input type="hidden" name="issueId" value={issueId} />
                  <input
                    type="hidden"
                    name="outputType"
                    value={item.outputType}
                  />

                  <div className="flex-1">
                    <label
                      htmlFor={`note-${item.eventId}`}
                      className="block text-xs font-medium text-gray-500 mb-1"
                    >
                      Reviewer note (optional)
                    </label>
                    <input
                      id={`note-${item.eventId}`}
                      name="reviewerNote"
                      type="text"
                      placeholder="e.g. 'Great hook, approved as-is'"
                      className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                  </div>

                  <button
                    type="submit"
                    name="action"
                    value="approved"
                    className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
                  >
                    <svg
                      className="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <title>Approve</title>
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    Approve
                  </button>

                  <button
                    type="submit"
                    name="action"
                    value="rejected"
                    className="inline-flex items-center gap-1.5 rounded-md bg-white px-4 py-2 text-sm font-medium text-gray-700 ring-1 ring-inset ring-gray-200 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                  >
                    <svg
                      className="h-4 w-4 text-red-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <title>Reject</title>
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                    Reject
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quality chip sub-component
// ---------------------------------------------------------------------------

function QualityChip({ passed, label }: { passed: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        passed
          ? "bg-green-50 text-green-700"
          : "bg-gray-100 text-gray-500 line-through"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${passed ? "bg-green-500" : "bg-gray-400"}`}
      />
      {label}
    </span>
  );
}
