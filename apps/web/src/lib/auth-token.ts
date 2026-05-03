export const SESSION_COOKIE_NAME = "growthos_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours

export interface SessionClaims {
  userId: string;
  role: "admin";
  exp: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const getSessionSecret = (): string =>
  process.env.GROWTHOS_SESSION_SECRET ??
  "growthos-dev-session-secret-change-me";

const bytesToBinary = (bytes: Uint8Array): string => {
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i];
    if (value === undefined) continue;
    output += String.fromCharCode(value);
  }
  return output;
};

const binaryToBytes = (binary: string): Uint8Array => {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const base64Encode = (bytes: Uint8Array): string => {
  if (typeof btoa === "function") return btoa(bytesToBinary(bytes));
  // Node fallback
  return Buffer.from(bytes).toString("base64");
};

const base64Decode = (value: string): Uint8Array => {
  if (typeof atob === "function") return binaryToBytes(atob(value));
  // Node fallback
  return new Uint8Array(Buffer.from(value, "base64"));
};

const toBase64Url = (data: Uint8Array): string =>
  base64Encode(data)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const fromBase64Url = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  return base64Decode(padded);
};

const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined || bv === undefined) return false;
    out |= av ^ bv;
  }
  return out === 0;
};

const sign = async (message: string): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(getSessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(message),
  );
  return new Uint8Array(sig);
};

export const createSessionToken = async (
  input: Omit<SessionClaims, "exp">,
): Promise<string> => {
  const payload: SessionClaims = {
    ...input,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const payloadPart = toBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const sigPart = toBase64Url(await sign(payloadPart));
  return `${payloadPart}.${sigPart}`;
};

export const verifySessionToken = async (
  token: string | undefined,
): Promise<SessionClaims | null> => {
  if (!token) return null;
  const [payloadPart, sigPart] = token.split(".");
  if (!payloadPart || !sigPart) return null;

  const expectedSig = await sign(payloadPart);
  const providedSig = fromBase64Url(sigPart);
  if (!timingSafeEqual(expectedSig, providedSig)) return null;

  try {
    const payload = JSON.parse(
      textDecoder.decode(fromBase64Url(payloadPart)),
    ) as SessionClaims;
    if (payload.role !== "admin") return null;
    if (typeof payload.userId !== "string" || payload.userId.length < 1) {
      return null;
    }
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
};

export const sessionMaxAgeSeconds = SESSION_TTL_SECONDS;
