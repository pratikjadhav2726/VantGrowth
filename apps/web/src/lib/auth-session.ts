import { cookies } from "next/headers";
import {
  SESSION_COOKIE_NAME,
  type SessionClaims,
  createSessionToken,
  sessionMaxAgeSeconds,
  verifySessionToken,
} from "./auth-token";

export const getSession = async (): Promise<SessionClaims | null> => {
  const jar = await cookies();
  return verifySessionToken(jar.get(SESSION_COOKIE_NAME)?.value);
};

export const setSessionCookie = async (
  claims: Omit<SessionClaims, "exp">,
): Promise<void> => {
  const token = await createSessionToken(claims);
  const jar = await cookies();
  jar.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: sessionMaxAgeSeconds,
  });
};

export const clearSessionCookie = async (): Promise<void> => {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE_NAME);
};
