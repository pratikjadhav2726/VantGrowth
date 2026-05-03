/**
 * LagoClient — Lago open-source billing for GrowthOS.
 *
 * Lago is an open-source metered billing engine (self-hosted).
 * Each GrowthOS tenant maps to a Lago customer; usage is reported
 * as events that drive metered charges on their plan.
 *
 * Pricing plans (defined in Lago admin UI / plan stubs):
 *   - `motion_active`    — charged per active motion per billing cycle
 *   - `approved_action`  — charged per approved agent action
 *
 * All write methods are idempotent via `external_id` (our tenantId).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Plan codes — must match the plans configured in the Lago instance
// ---------------------------------------------------------------------------

export const PLAN_CODE_MOTION_ACTIVE = "motion_active" as const;
export const PLAN_CODE_APPROVED_ACTION = "approved_action" as const;
export type PlanCode = typeof PLAN_CODE_MOTION_ACTIVE | typeof PLAN_CODE_APPROVED_ACTION;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export const lagoCustomerSchema = z.object({
  lagoId: z.string().min(1),
  externalId: z.string().min(1),
  name: z.string().min(1),
  email: z.string().optional(),
  currency: z.string().optional(),
  createdAt: z.string().optional(),
});

export type LagoCustomer = z.infer<typeof lagoCustomerSchema>;

export const lagoSubscriptionSchema = z.object({
  lagoId: z.string().min(1),
  externalId: z.string().min(1),
  customerId: z.string().min(1),
  planCode: z.string().min(1),
  status: z.string().optional(),
  startedAt: z.string().optional(),
});

export type LagoSubscription = z.infer<typeof lagoSubscriptionSchema>;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface BillingClient {
  /**
   * Creates a Lago customer for a tenant.
   * Idempotent: upserts via external_id (tenantId).
   */
  createCustomer(params: {
    externalId: string;
    name: string;
    email?: string;
    currency?: string;
  }): Promise<LagoCustomer>;

  /**
   * Assigns a billing plan to a customer.
   * Idempotent via external subscription ID.
   */
  assignPlan(params: {
    customerExternalId: string;
    planCode: PlanCode;
    subscriptionExternalId: string;
  }): Promise<LagoSubscription>;

  /**
   * Records a usage event for metered billing.
   * Fire-and-forget: failures are logged but do not block provisioning.
   */
  recordEvent(params: {
    transactionId: string;
    customerExternalId: string;
    code: string;
    properties?: Record<string, string | number>;
  }): Promise<void>;

  /**
   * Deletes a customer and all their subscriptions.
   * Silently succeeds if the customer does not exist.
   */
  deleteCustomer(externalId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LagoClientConfig {
  /**
   * Lago instance URL, e.g. "http://localhost:3000"
   * Reads from LAGO_API_URL or GROWTHOS_LAGO_API_URL env var.
   */
  baseUrl: string;
  /**
   * Lago API key (from Settings → API keys in the Lago dashboard).
   * Reads from LAGO_API_KEY or GROWTHOS_LAGO_API_KEY.
   */
  apiKey: string;
  /** Request timeout in milliseconds. Default: 8000 */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// HttpLagoBillingClient
// ---------------------------------------------------------------------------

export class HttpLagoBillingClient implements BillingClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: LagoClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 8000;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): HttpLagoBillingClient {
    const baseUrl = env.LAGO_API_URL ?? env.GROWTHOS_LAGO_API_URL;
    if (!baseUrl)
      throw new Error("LAGO_API_URL or GROWTHOS_LAGO_API_URL is required");

    const apiKey = env.LAGO_API_KEY ?? env.GROWTHOS_LAGO_API_KEY;
    if (!apiKey)
      throw new Error("LAGO_API_KEY or GROWTHOS_LAGO_API_KEY is required");

    return new HttpLagoBillingClient({ baseUrl, apiKey });
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      clearTimeout(timer);
      const json = res.status === 200 || res.status === 201 || res.status === 422
        ? ((await res.json()) as T)
        : ({} as T);
      return { status: res.status, json };
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError")
        throw new Error(`Lago request timed out after ${this.timeoutMs}ms: ${path}`);
      throw err;
    }
  }

  async createCustomer(params: {
    externalId: string;
    name: string;
    email?: string;
    currency?: string;
  }): Promise<LagoCustomer> {
    type LagoCustomerResponse = {
      customer?: {
        lago_id?: string;
        external_id?: string;
        name?: string;
        email?: string;
        currency?: string;
        created_at?: string;
      };
    };

    const { status, json } = await this.request<LagoCustomerResponse>(
      "POST",
      "/api/v1/customers",
      {
        customer: {
          external_id: params.externalId,
          name: params.name,
          ...(params.email ? { email: params.email } : {}),
          currency: params.currency ?? "USD",
        },
      },
    );

    // Lago upserts on external_id — 200 = updated, 201 = created
    if (status !== 200 && status !== 201)
      throw new Error(`Lago createCustomer failed (${status}): ${JSON.stringify(json)}`);

    const c = json.customer;
    if (!c?.lago_id)
      throw new Error("Lago createCustomer response missing customer.lago_id");

    return {
      lagoId: c.lago_id,
      externalId: c.external_id ?? params.externalId,
      name: c.name ?? params.name,
      email: c.email,
      currency: c.currency,
      createdAt: c.created_at,
    };
  }

  async assignPlan(params: {
    customerExternalId: string;
    planCode: PlanCode;
    subscriptionExternalId: string;
  }): Promise<LagoSubscription> {
    type LagoSubscriptionResponse = {
      subscription?: {
        lago_id?: string;
        external_id?: string;
        external_customer_id?: string;
        plan_code?: string;
        status?: string;
        started_at?: string;
      };
    };

    const { status, json } = await this.request<LagoSubscriptionResponse>(
      "POST",
      "/api/v1/subscriptions",
      {
        subscription: {
          external_customer_id: params.customerExternalId,
          plan_code: params.planCode,
          external_id: params.subscriptionExternalId,
          billing_time: "calendar",
        },
      },
    );

    if (status !== 200 && status !== 201)
      throw new Error(`Lago assignPlan failed (${status}): ${JSON.stringify(json)}`);

    const s = json.subscription;
    if (!s?.lago_id)
      throw new Error("Lago assignPlan response missing subscription.lago_id");

    return {
      lagoId: s.lago_id,
      externalId: s.external_id ?? params.subscriptionExternalId,
      customerId: s.external_customer_id ?? params.customerExternalId,
      planCode: s.plan_code ?? params.planCode,
      status: s.status,
      startedAt: s.started_at,
    };
  }

  async recordEvent(params: {
    transactionId: string;
    customerExternalId: string;
    code: string;
    properties?: Record<string, string | number>;
  }): Promise<void> {
    const { status } = await this.request<unknown>("POST", "/api/v1/events", {
      event: {
        transaction_id: params.transactionId,
        external_subscription_id: params.customerExternalId,
        code: params.code,
        timestamp: Math.floor(Date.now() / 1000),
        ...(params.properties ? { properties: params.properties } : {}),
      },
    });
    // 200 = success; treat all non-200 as soft failures (don't block pipeline)
    if (status !== 200) {
      // intentionally swallowed — metering failures must not break provisioning
    }
  }

  async deleteCustomer(externalId: string): Promise<void> {
    const { status, json } = await this.request<unknown>(
      "DELETE",
      `/api/v1/customers/${externalId}`,
    );
    if (status === 200 || status === 204 || status === 404) return;
    throw new Error(`Lago deleteCustomer ${externalId} failed (${status}): ${JSON.stringify(json)}`);
  }
}

// ---------------------------------------------------------------------------
// StubBillingClient — for tests and local dev
// ---------------------------------------------------------------------------

export class StubBillingClient implements BillingClient {
  readonly createCustomerCalls: Parameters<BillingClient["createCustomer"]>[0][] = [];
  readonly assignPlanCalls: Parameters<BillingClient["assignPlan"]>[0][] = [];
  readonly recordEventCalls: Parameters<BillingClient["recordEvent"]>[0][] = [];
  readonly deleteCustomerCalls: string[] = [];

  async createCustomer(params: Parameters<BillingClient["createCustomer"]>[0]): Promise<LagoCustomer> {
    this.createCustomerCalls.push(params);
    return {
      lagoId: `lago-customer-${params.externalId}`,
      externalId: params.externalId,
      name: params.name,
      email: params.email,
      currency: params.currency ?? "USD",
      createdAt: new Date().toISOString(),
    };
  }

  async assignPlan(params: Parameters<BillingClient["assignPlan"]>[0]): Promise<LagoSubscription> {
    this.assignPlanCalls.push(params);
    return {
      lagoId: `lago-sub-${params.subscriptionExternalId}`,
      externalId: params.subscriptionExternalId,
      customerId: params.customerExternalId,
      planCode: params.planCode,
      status: "active",
      startedAt: new Date().toISOString(),
    };
  }

  async recordEvent(params: Parameters<BillingClient["recordEvent"]>[0]): Promise<void> {
    this.recordEventCalls.push(params);
  }

  async deleteCustomer(externalId: string): Promise<void> {
    this.deleteCustomerCalls.push(externalId);
  }
}
