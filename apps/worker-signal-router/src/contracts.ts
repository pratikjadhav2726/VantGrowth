import { z } from "zod";

export const signalPrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);

export const incomingSignalSchema = z.object({
  tenantId: z.string().uuid(),
  signalId: z.string().min(1),
  dedupeKey: z.string().min(1),
  source: z.string().min(1),
  kind: z.string().min(1),
  payload: z.record(z.unknown())
});

export type IncomingSignal = z.infer<typeof incomingSignalSchema>;

export const routedSignalSchema = incomingSignalSchema.extend({
  priority: signalPrioritySchema,
  targetAgent: z.string().min(1),
  halfLifeMinutes: z.number().int().positive(),
  routedAt: z.date()
});

export type RoutedSignal = z.infer<typeof routedSignalSchema>;
