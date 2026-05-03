"use server";

import { clearSessionCookie, setSessionCookie } from "@/lib/auth-session";
import { redirect } from "next/navigation";

const ADMIN_PASSWORD_ENV = "GROWTHOS_WEB_ADMIN_PASSWORD";

export const loginAction = async (formData: FormData): Promise<void> => {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  const expectedPassword =
    process.env[ADMIN_PASSWORD_ENV] ?? "growthos-dev-admin";
  if (!email || password !== expectedPassword) {
    redirect("/login?error=invalid_credentials");
  }

  await setSessionCookie({
    userId: email,
    role: "admin",
  });
  redirect("/approvals");
};

export const logoutAction = async (): Promise<void> => {
  await clearSessionCookie();
  redirect("/login");
};
