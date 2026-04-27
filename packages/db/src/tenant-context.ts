import { tenantIdSchema } from "./contracts.js";

export interface TenantContext {
  tenantId: string;
  actorId?: string;
  actorKind?: "user" | "agent" | "system";
}

export const tenantScopedSubject = (tenantId: string, subject: string): string => {
  const parsedTenantId = tenantIdSchema.parse(tenantId);
  if (!subject || subject.startsWith(".") || subject.endsWith(".")) {
    throw new Error("Subject must be a non-empty dot-delimited suffix.");
  }

  return `t.${parsedTenantId}.${subject}`;
};

export const createTenantSettingsSql = (context: TenantContext): { sql: string; params: unknown[] } => {
  const tenantId = tenantIdSchema.parse(context.tenantId);
  return {
    sql: [
      "SELECT",
      "set_config('app.tenant_id', $1, true),",
      "set_config('app.actor_id', $2, true),",
      "set_config('app.actor_kind', $3, true)"
    ].join(" "),
    params: [tenantId, context.actorId ?? "", context.actorKind ?? "system"]
  };
};
