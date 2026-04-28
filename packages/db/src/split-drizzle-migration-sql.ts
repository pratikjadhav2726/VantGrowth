/**
 * Splits a Drizzle Kit–generated migration file into executable chunks.
 * Drizzle inserts `--> statement-breakpoint` between statements (sometimes
 * immediately after `;` on the same line).
 */
export function splitDrizzleMigrationSql(sql: string): string[] {
  return sql
    .split(/-->\s*statement-breakpoint\s*\r?\n?/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}
