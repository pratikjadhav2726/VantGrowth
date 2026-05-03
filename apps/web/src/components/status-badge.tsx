import { clsx } from "clsx";

type Variant = "pending" | "approved" | "rejected" | "processing" | "neutral";

const variants: Record<Variant, string> = {
  pending: "bg-amber-50 text-amber-700 ring-amber-200",
  approved: "bg-green-50 text-green-700 ring-green-200",
  rejected: "bg-red-50 text-red-700 ring-red-200",
  processing: "bg-blue-50 text-blue-700 ring-blue-200",
  neutral: "bg-gray-100 text-gray-600 ring-gray-200",
};

export function StatusBadge({
  variant,
  label,
}: {
  variant: Variant;
  label: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        variants[variant],
      )}
    >
      {label}
    </span>
  );
}
