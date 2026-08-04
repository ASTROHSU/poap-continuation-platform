import { ApiError } from "./validation";

const encoder = new TextEncoder();

export const EMAIL_SESSION_COOKIE = "association_email_session";
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;
export const EMAIL_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "Email address is required.", "invalid_email");
  }
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "Email address is invalid.", "invalid_email");
  }
  return email;
}

export async function hmacEmail(email: string, secret: string): Promise<string> {
  if (secret.length < 32) {
    throw new Error("EMAIL_LOOKUP_SECRET must contain at least 32 characters.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(email)));
}

export async function encryptEmail(
  email: string,
  encodedKey: string,
): Promise<{ ciphertext: string; iv: string }> {
  const rawKey = fromBase64(encodedKey);
  if (rawKey.byteLength !== 32) {
    throw new Error("EMAIL_DATA_KEY must be a base64-encoded 32-byte key.");
  }
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(email),
  );
  return { ciphertext: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv) };
}

export async function decryptEmail(
  ciphertext: string,
  encodedIv: string,
  encodedKey: string,
): Promise<string> {
  const rawKey = fromBase64(encodedKey);
  if (rawKey.byteLength !== 32) {
    throw new Error("EMAIL_DATA_KEY must be a base64-encoded 32-byte key.");
  }
  const iv = fromBase64(encodedIv);
  if (iv.byteLength !== 12) throw new Error("Encrypted Email IV must contain 12 bytes.");
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    fromBase64(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function readSessionToken(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === EMAIL_SESSION_COOKIE) return value.join("=") || null;
  }
  return null;
}

export function sessionCookie(token: string, request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${EMAIL_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${EMAIL_SESSION_TTL_SECONDS}${secure}`;
}

export function expiredSessionCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${EMAIL_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  if (origin !== new URL(request.url).origin) {
    throw new ApiError(403, "This request did not come from this site.", "invalid_origin");
  }
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toBase64Url(value: Uint8Array): string {
  return toBase64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
