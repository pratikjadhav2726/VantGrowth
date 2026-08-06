import { createHash } from "node:crypto";

/**
 * Deterministic UUIDv5-shaped identifier for idempotent domain commands.
 *
 * This is intentionally local and dependency-free: callers supply a stable
 * namespace (normally tenant + source event identity), so replaying an event
 * produces the same UUID without storing an additional mapping row.
 */
export const deterministicUuid = (namespace: string): string => {
  const hash = createHash("sha256").update(namespace).digest("hex");
  const variant = (Number.parseInt(hash[16] ?? "8", 16) & 0x3) | 0x8;
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${variant.toString(16)}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
};
