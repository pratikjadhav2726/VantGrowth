import { z } from "zod";

const emptyToUndefined = (v: unknown) => {
  if (v == null) return undefined;
  if (typeof v !== "string") return v;
  const t = v.trim();
  return t === "" ? undefined : t;
};

/** Form inputs may be null; coerce to string for Zod. */
const formStr = (v: unknown): string =>
  v == null ? "" : typeof v === "string" ? v : String(v);

export const companyStepSchema = z.object({
  companyName: z.preprocess(
    formStr,
    z.string().trim().min(1, "Company name is required").max(200),
  ),
  website: z.preprocess(
    emptyToUndefined,
    z.string().url("Enter a valid URL, or leave blank").max(2048).optional(),
  ),
  icpDescription: z.preprocess(
    formStr,
    z
      .string()
      .trim()
      .min(10, "Add a bit more detail on your ICP (at least 10 characters)")
      .max(8000),
  ),
  headcount: z.preprocess(
    formStr,
    z.enum(["1-10", "11-50", "51-200", "201-500", "500+"]),
  ),
  arr: z.preprocess(
    formStr,
    z.enum(["pre-revenue", "0-500k", "500k-2m", "2m-10m", "10m+"]),
  ),
});

export const brandStepSchema = z.object({
  positioning: z.preprocess(
    formStr,
    z
      .string()
      .trim()
      .min(20, "Positioning should be at least 20 characters")
      .max(2000),
  ),
  proof1: z.preprocess(emptyToUndefined, z.string().max(500).optional()),
  proof2: z.preprocess(emptyToUndefined, z.string().max(500).optional()),
  proof3: z.preprocess(emptyToUndefined, z.string().max(500).optional()),
  tone: z.preprocess(
    formStr,
    z.enum(["founder-voice", "professional", "conversational", "technical"]),
  ),
  wordsToAvoid: z.preprocess(emptyToUndefined, z.string().max(2000).optional()),
});
