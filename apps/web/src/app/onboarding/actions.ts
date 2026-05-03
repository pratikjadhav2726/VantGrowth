"use server";

import { patchGrowthosSettings } from "@/lib/settings-cookie";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { brandStepSchema, companyStepSchema } from "./schemas";

export interface OnboardingState {
  step: number;
  // Step 1
  companyName?: string;
  website?: string;
  icpDescription?: string;
  headcount?: string;
  arr?: string;
  // Step 2
  positioning?: string;
  proofPoints?: string[];
  tone?: string;
  wordsToAvoid?: string;
}

const COOKIE = "growthos_onboarding";

export async function getOnboardingState(): Promise<OnboardingState> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return { step: 1 };
  try {
    return JSON.parse(decodeURIComponent(raw)) as OnboardingState;
  } catch {
    return { step: 1 };
  }
}

async function saveState(state: OnboardingState) {
  const jar = await cookies();
  jar.set(COOKIE, encodeURIComponent(JSON.stringify(state)), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24, // 24h
    path: "/",
  });
}

export async function submitCompanyStep(formData: FormData) {
  const parsed = companyStepSchema.safeParse({
    companyName: formData.get("companyName"),
    website: formData.get("website"),
    icpDescription: formData.get("icpDescription"),
    headcount: formData.get("headcount"),
    arr: formData.get("arr"),
  });

  if (!parsed.success) {
    const first = parsed.error.flatten().fieldErrors;
    const msg =
      first.companyName?.[0] ??
      first.website?.[0] ??
      first.icpDescription?.[0] ??
      first.headcount?.[0] ??
      first.arr?.[0] ??
      "Check your inputs and try again.";
    redirect(`/onboarding?step=1&error=${encodeURIComponent(msg)}`);
  }

  const state = await getOnboardingState();
  const d = parsed.data;
  const updated: OnboardingState = {
    ...state,
    step: 2,
    companyName: d.companyName,
    icpDescription: d.icpDescription,
    headcount: d.headcount,
    arr: d.arr,
    ...(d.website !== undefined ? { website: d.website } : {}),
  };
  await saveState(updated);
  redirect("/onboarding?step=2");
}

export async function submitBrandStep(formData: FormData) {
  const parsed = brandStepSchema.safeParse({
    positioning: formData.get("positioning"),
    proof1: formData.get("proof1"),
    proof2: formData.get("proof2"),
    proof3: formData.get("proof3"),
    tone: formData.get("tone"),
    wordsToAvoid: formData.get("wordsToAvoid"),
  });

  if (!parsed.success) {
    const first = parsed.error.flatten().fieldErrors;
    const msg =
      first.positioning?.[0] ??
      first.tone?.[0] ??
      first.proof1?.[0] ??
      first.proof2?.[0] ??
      first.proof3?.[0] ??
      first.wordsToAvoid?.[0] ??
      "Check your inputs and try again.";
    redirect(`/onboarding?step=2&error=${encodeURIComponent(msg)}`);
  }

  const state = await getOnboardingState();
  const d = parsed.data;
  const proofPoints = [d.proof1, d.proof2, d.proof3].filter((s): s is string =>
    Boolean(s && s.length > 0),
  );

  const updated: OnboardingState = {
    ...state,
    step: 3,
    positioning: d.positioning,
    proofPoints,
    tone: d.tone,
    wordsToAvoid: d.wordsToAvoid ?? "",
  };
  await saveState(updated);
  redirect("/onboarding?step=3");
}

export async function completeOnboarding() {
  const state = await getOnboardingState();

  const companyName = state.companyName?.trim();
  const positioning = state.positioning?.trim();

  if (!companyName || !positioning) {
    redirect(
      `/onboarding?step=1&error=${encodeURIComponent("Please complete the setup steps in order.")}`,
    );
  }

  await patchGrowthosSettings({
    companyName,
    positioning,
    ...(state.website !== undefined ? { website: state.website } : {}),
    ...(state.icpDescription !== undefined
      ? { icpDescription: state.icpDescription }
      : {}),
    ...(state.headcount !== undefined ? { headcount: state.headcount } : {}),
    ...(state.arr !== undefined ? { arr: state.arr } : {}),
    ...(state.proofPoints !== undefined
      ? { proofPoints: state.proofPoints }
      : {}),
    ...(state.tone !== undefined ? { tone: state.tone } : {}),
    ...(state.wordsToAvoid !== undefined && state.wordsToAvoid !== ""
      ? { wordsToAvoid: state.wordsToAvoid }
      : {}),
    onboardingCompletedAt: new Date().toISOString(),
  });

  const jar = await cookies();
  jar.delete(COOKIE);
  redirect("/?onboarded=true");
}

export async function resetOnboarding() {
  const jar = await cookies();
  jar.delete(COOKIE);
  redirect("/onboarding");
}
