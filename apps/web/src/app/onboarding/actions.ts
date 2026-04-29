"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

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
  const state = await getOnboardingState();
  const updated: OnboardingState = {
    ...state,
    step: 2,
    companyName: (formData.get("companyName") as string).trim(),
    website: (formData.get("website") as string).trim(),
    icpDescription: (formData.get("icpDescription") as string).trim(),
    headcount: formData.get("headcount") as string,
    arr: formData.get("arr") as string,
  };
  await saveState(updated);
  redirect("/onboarding?step=2");
}

export async function submitBrandStep(formData: FormData) {
  const state = await getOnboardingState();
  const updated: OnboardingState = {
    ...state,
    step: 3,
    positioning: (formData.get("positioning") as string).trim(),
    proofPoints: [
      formData.get("proof1") as string,
      formData.get("proof2") as string,
      formData.get("proof3") as string,
    ].filter(Boolean),
    tone: formData.get("tone") as string,
    wordsToAvoid: (formData.get("wordsToAvoid") as string).trim(),
  };
  await saveState(updated);
  redirect("/onboarding?step=3");
}

export async function completeOnboarding() {
  const jar = await cookies();
  jar.delete(COOKIE);
  redirect("/?onboarded=true");
}

export async function resetOnboarding() {
  const jar = await cookies();
  jar.delete(COOKIE);
  redirect("/onboarding");
}
