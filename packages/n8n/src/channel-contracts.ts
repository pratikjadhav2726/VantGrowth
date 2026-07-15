import { z } from "zod";

export const n8nCanonicalSignalTypeValues = [
  "competitive",
  "community",
  "icp",
  "product",
  "market",
  "internal",
] as const;

export const growthosIntegrationChannelValues = [
  "reddit",
  "linkedin",
  "email",
  "crm",
  "analytics",
  "cms",
  "search",
  "support",
  "community",
  "custom",
] as const;

export const growthosIntegrationChannelSchema = z.enum(
  growthosIntegrationChannelValues,
);

export type GrowthosIntegrationChannel = z.infer<
  typeof growthosIntegrationChannelSchema
>;

export const n8nActionTypeValues = [
  "reddit.post.submit",
  "reddit.comment.submit",
  "linkedin.post.create",
  "linkedin.dm.send",
  "email.send",
  "crm.note.create",
  "cms.post.publish",
  "analytics.event.record",
  "custom.execute",
] as const;

export const n8nActionTypeSchema = z.enum(n8nActionTypeValues);
export type N8nActionType = z.infer<typeof n8nActionTypeSchema>;

export const n8nTraceContextSchema = z.object({
  runId: z.string().min(1).max(255).optional(),
  issueId: z.string().min(1).max(255).optional(),
  workflowId: z.string().min(1).max(255).optional(),
  executionId: z.string().min(1).max(255).optional(),
});

export const n8nEvidenceRefSchema = z.object({
  type: z
    .enum(["url", "object", "crm_record", "screenshot", "transcript"])
    .default("url"),
  uri: z.string().min(1).max(2000),
  label: z.string().min(1).max(255).optional(),
});

export const n8nCanonicalSignalPayloadSchema = z.object({
  channel: growthosIntegrationChannelSchema,
  sourceRecordId: z.string().min(1).max(255),
  sourceUrl: z.string().url().optional(),
  actor: z
    .object({
      id: z.string().min(1).max(255).optional(),
      name: z.string().min(1).max(255).optional(),
      handle: z.string().min(1).max(255).optional(),
      company: z.string().min(1).max(255).optional(),
    })
    .optional(),
  subject: z.string().min(1).max(500).optional(),
  text: z.string().max(10_000).optional(),
  engagement: z
    .object({
      kind: z.string().min(1).max(100),
      score: z.number().min(0).max(1).optional(),
      counts: z.record(z.number().nonnegative()).optional(),
    })
    .optional(),
  evidence: z.array(n8nEvidenceRefSchema).default([]),
  trace: n8nTraceContextSchema.optional(),
  metadata: z.record(z.unknown()).default({}),
});

export type N8nCanonicalSignalPayload = z.infer<
  typeof n8nCanonicalSignalPayloadSchema
>;

const dispatchBasePayloadSchema = z.object({
  channel: growthosIntegrationChannelSchema,
  dryRun: z.boolean().default(false),
  trace: n8nTraceContextSchema.optional(),
  metadata: z.record(z.unknown()).default({}),
});

export const redditPostSubmitPayloadSchema = dispatchBasePayloadSchema.extend({
  channel: z.literal("reddit"),
  subreddit: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  text: z.string().max(10_000).optional(),
  url: z.string().url().optional(),
});

export const redditCommentSubmitPayloadSchema =
  dispatchBasePayloadSchema.extend({
    channel: z.literal("reddit"),
    subreddit: z.string().min(1).max(100).optional(),
    parentId: z.string().min(1).max(255),
    text: z.string().min(1).max(10_000),
    sourceUrl: z.string().url().optional(),
  });

export const linkedinPostCreatePayloadSchema = dispatchBasePayloadSchema.extend(
  {
    channel: z.literal("linkedin"),
    postAs: z.enum(["person", "organization"]),
    ownerId: z.string().min(1).max(255),
    text: z.string().min(1).max(3000),
    mediaUrls: z.array(z.string().url()).default([]),
  },
);

export const linkedinDmSendPayloadSchema = dispatchBasePayloadSchema.extend({
  channel: z.literal("linkedin"),
  recipientId: z.string().min(1).max(255),
  text: z.string().min(1).max(3000),
});

export const emailSendPayloadSchema = dispatchBasePayloadSchema.extend({
  channel: z.literal("email"),
  to: z.array(z.string().email()).min(1),
  subject: z.string().min(1).max(300),
  text: z.string().min(1).max(20_000),
  html: z.string().max(50_000).optional(),
});

export const n8nDispatchActionSchema = z.discriminatedUnion("actionType", [
  z.object({
    actionType: z.literal("reddit.post.submit"),
    payload: redditPostSubmitPayloadSchema,
  }),
  z.object({
    actionType: z.literal("reddit.comment.submit"),
    payload: redditCommentSubmitPayloadSchema,
  }),
  z.object({
    actionType: z.literal("linkedin.post.create"),
    payload: linkedinPostCreatePayloadSchema,
  }),
  z.object({
    actionType: z.literal("linkedin.dm.send"),
    payload: linkedinDmSendPayloadSchema,
  }),
  z.object({
    actionType: z.literal("email.send"),
    payload: emailSendPayloadSchema,
  }),
  z.object({
    actionType: z.literal("crm.note.create"),
    payload: dispatchBasePayloadSchema.extend({
      channel: z.literal("crm"),
      recordId: z.string().min(1).max(255),
      note: z.string().min(1).max(20_000),
    }),
  }),
  z.object({
    actionType: z.literal("cms.post.publish"),
    payload: dispatchBasePayloadSchema.extend({
      channel: z.literal("cms"),
      title: z.string().min(1).max(300),
      bodyMarkdown: z.string().min(1),
      slug: z.string().min(1).max(255).optional(),
    }),
  }),
  z.object({
    actionType: z.literal("analytics.event.record"),
    payload: dispatchBasePayloadSchema.extend({
      channel: z.literal("analytics"),
      eventName: z.string().min(1).max(255),
      properties: z.record(z.unknown()).default({}),
    }),
  }),
  z.object({
    actionType: z.literal("custom.execute"),
    payload: dispatchBasePayloadSchema.extend({
      channel: z.literal("custom"),
      operation: z.string().min(1).max(255),
      input: z.record(z.unknown()).default({}),
    }),
  }),
]);

export type N8nDispatchAction = z.infer<typeof n8nDispatchActionSchema>;

export const n8nTypedDispatchRequestSchema = z
  .object({
    tenantId: z.string().uuid(),
    actionId: z.string().min(1).max(255),
    actionType: z.string().min(1).max(100),
    approvedBy: z.string().min(1).max(255),
    idempotencyKey: z.string().min(1).max(255),
    payload: z.record(z.unknown()).default({}),
  })
  .superRefine((request, ctx) => {
    const actionTypeResult = n8nActionTypeSchema.safeParse(request.actionType);
    if (!actionTypeResult.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actionType"],
        message: "Unsupported n8n action type",
      });
      return;
    }

    const actionResult = n8nDispatchActionSchema.safeParse({
      actionType: request.actionType,
      payload: request.payload,
    });
    if (!actionResult.success) {
      for (const issue of actionResult.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ["payload", ...issue.path],
        });
      }
    }
  })
  .transform((request) => {
    const action = n8nDispatchActionSchema.parse({
      actionType: request.actionType,
      payload: request.payload,
    });

    return {
      ...request,
      actionType: action.actionType,
      payload: action.payload,
    };
  });

export type N8nTypedDispatchRequest = z.infer<
  typeof n8nTypedDispatchRequestSchema
>;

export const n8nCanonicalSignalEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(255),
  source: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._:-]+$/),
  signalType: z.enum(n8nCanonicalSignalTypeValues),
  occurredAt: z.string().datetime({ offset: true }),
  workflowId: z.string().min(1).max(255).optional(),
  executionId: z.string().min(1).max(255).optional(),
  payload: n8nCanonicalSignalPayloadSchema,
});

export type N8nCanonicalSignalEnvelope = z.infer<
  typeof n8nCanonicalSignalEnvelopeSchema
>;

export const buildCanonicalN8nSignalEnvelope = (input: {
  eventId: string;
  source: string;
  signalType: (typeof n8nCanonicalSignalTypeValues)[number];
  occurredAt: string;
  workflowId?: string;
  executionId?: string;
  payload: z.input<typeof n8nCanonicalSignalPayloadSchema>;
}) =>
  n8nCanonicalSignalEnvelopeSchema.parse({
    ...input,
    payload: n8nCanonicalSignalPayloadSchema.parse(input.payload),
  });
