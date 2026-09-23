import { createHash, randomBytes } from "node:crypto";

const DOMAIN = Buffer.from("paseo-rooms:route-ownership:v1\0");
export function routeTokenForSecret(secret: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  const bytes = Buffer.from(secret, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== secret)
    return null;
  return `o_${createHash("sha256").update(DOMAIN).update(bytes).digest("base64url")}`;
}
export function createRouteOwnership(): {
  token: string;
  ownershipSecret: string;
} {
  const ownershipSecret = randomBytes(32).toString("base64url");
  return { token: routeTokenForSecret(ownershipSecret)!, ownershipSecret };
}
export function verifyRouteOwnership(token: string, secret: unknown): boolean {
  return typeof secret === "string" && routeTokenForSecret(secret) === token;
}
