import { Hono } from "hono";
import {
  paperclipCompanyCreateInputSchema,
  paperclipIssueCreateInputSchema,
  type PaperclipClientPort
} from "@growthos/adapter";
import { z } from "zod";
import { ServiceUnavailableError } from "../http-errors.js";

const tenantBootstrapSchema = z.object({
  tenantExternalId: z.string().min(1),
  tenantName: z.string().min(1),
  initialAgent: z.object({
    name: z.string().min(1),
    role: z.string().min(1),
    title: z.string().min(1),
    budgetMonthlyCents: z.number().int().nonnegative()
  }),
  seedIssue: z.object({
    title: z.string().min(1),
    description: z.string().optional()
  })
});

export interface PaperclipRouteDependencies {
  paperclipClient: PaperclipClientPort | null;
}

export const createPaperclipRoutes = (deps: PaperclipRouteDependencies): Hono => {
  const route = new Hono();

  route.post("/bootstrap-tenant", async (c) => {
    if (!deps.paperclipClient) {
      throw new ServiceUnavailableError(
        "Paperclip client is not configured. Set PAPERCLIP_BASE_URL and PAPERCLIP_SERVICE_TOKEN."
      );
    }

    const payload = tenantBootstrapSchema.parse(await c.req.json());
    const idempotencyKey =
      c.req.header("Idempotency-Key") ??
      `bootstrap:${payload.tenantExternalId}:${payload.initialAgent.name.toLowerCase()}`;

    const company = await deps.paperclipClient.createCompany(
      paperclipCompanyCreateInputSchema.parse({
        externalId: payload.tenantExternalId,
        name: payload.tenantName
      })
    );

    const agent = await deps.paperclipClient.createAgent({
      companyId: company.id,
      name: payload.initialAgent.name,
      role: payload.initialAgent.role,
      title: payload.initialAgent.title,
      adapterType: "growthos_native",
      budgetMonthlyCents: payload.initialAgent.budgetMonthlyCents
    });

    const issue = await deps.paperclipClient.createIssue(
      paperclipIssueCreateInputSchema.parse({
        companyId: company.id,
        title: payload.seedIssue.title,
        description: payload.seedIssue.description,
        assigneeAgentId: agent.id,
        metadata: {
          idempotency_key: idempotencyKey,
          source: "growthos.bootstrap_tenant.v1"
        }
      })
    );

    return c.json(
      {
        tenantId: payload.tenantExternalId,
        idempotencyKey,
        company,
        agent,
        issue
      },
      202
    );
  });

  return route;
};
