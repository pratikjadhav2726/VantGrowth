import {
  type PaperclipClientPort,
  paperclipCompanyCreateInputSchema,
  paperclipIssueCreateInputSchema,
} from "@growthos/adapter";
import { Hono } from "hono";
import { z } from "zod";
import { ServiceUnavailableError } from "../http-errors.js";

const tenantBootstrapSchema = z.object({
  tenantExternalId: z.string().min(1),
  tenantName: z.string().min(1),
  initialAgent: z.object({
    name: z.string().min(1),
    role: z.string().min(1),
    title: z.string().min(1),
    budgetMonthlyCents: z.number().int().nonnegative(),
  }),
  seedIssue: z.object({
    title: z.string().min(1),
    description: z.string().optional(),
  }),
});

const paperclipAgentRoles = new Set([
  "ceo",
  "cto",
  "cmo",
  "cfo",
  "security",
  "engineer",
  "designer",
  "pm",
  "qa",
  "devops",
  "researcher",
  "general",
]);

const normalizePaperclipRole = (role: string): string => {
  const normalized = role.trim().toLowerCase();
  if (paperclipAgentRoles.has(normalized)) return normalized;
  if (
    /(growth|gtm|marketing|sales|brand|content|demand|revenue)/.test(normalized)
  ) {
    return "cmo";
  }
  if (/(product|project|program)/.test(normalized)) return "pm";
  if (/(research|analyst|intel|strategy)/.test(normalized)) return "researcher";
  if (/(engineer|developer|code|software|data)/.test(normalized))
    return "engineer";
  if (/(ops|infra|platform|sre)/.test(normalized)) return "devops";
  if (/(security|risk|compliance)/.test(normalized)) return "security";
  if (/(finance|billing|revops)/.test(normalized)) return "cfo";
  return "general";
};

export interface PaperclipRouteDependencies {
  paperclipClient: PaperclipClientPort | null;
}

export const createPaperclipRoutes = (
  deps: PaperclipRouteDependencies,
): Hono => {
  const route = new Hono();

  route.post("/bootstrap-tenant", async (c) => {
    if (!deps.paperclipClient) {
      throw new ServiceUnavailableError(
        "Paperclip client is not configured. Set PAPERCLIP_BASE_URL and PAPERCLIP_SERVICE_TOKEN.",
      );
    }

    const payload = tenantBootstrapSchema.parse(await c.req.json());
    const idempotencyKey =
      c.req.header("Idempotency-Key") ??
      `bootstrap:${payload.tenantExternalId}:${payload.initialAgent.name.toLowerCase()}`;

    const company = await deps.paperclipClient.createCompany(
      paperclipCompanyCreateInputSchema.parse({
        externalId: payload.tenantExternalId,
        name: payload.tenantName,
      }),
    );

    // Paperclip owns hiring governance: new agents are created as a pending
    // board approval (control plane), not activated directly. The agent starts
    // in `pending_approval` and a human resolves the hire inside Paperclip.
    const paperclipRole = normalizePaperclipRole(payload.initialAgent.role);
    const hire = await deps.paperclipClient.createAgentHire({
      companyId: company.id,
      name: payload.initialAgent.name,
      role: paperclipRole,
      title: payload.initialAgent.title,
      adapterType: "growthos_native",
      budgetMonthlyCents: payload.initialAgent.budgetMonthlyCents,
      metadata: {
        growthos_requested_role: payload.initialAgent.role,
        growthos_role_normalized: paperclipRole !== payload.initialAgent.role,
      },
    });

    // The seed issue is created unassigned — a pending-approval agent cannot be
    // assigned work yet. It lands in the backlog and can be assigned once the
    // hire is approved in Paperclip.
    const issue = await deps.paperclipClient.createIssue(
      paperclipIssueCreateInputSchema.parse({
        companyId: company.id,
        title: payload.seedIssue.title,
        description: payload.seedIssue.description,
        metadata: {
          idempotency_key: idempotencyKey,
          source: "growthos.bootstrap_tenant.v1",
        },
      }),
    );

    return c.json(
      {
        tenantId: payload.tenantExternalId,
        idempotencyKey,
        company,
        agent: hire.agent,
        approval: hire.approval ?? null,
        agentApprovalRequired: hire.agent.status === "pending_approval",
        issue,
      },
      202,
    );
  });

  return route;
};
