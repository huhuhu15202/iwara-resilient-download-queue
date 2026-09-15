import { createHmac, timingSafeEqual } from "node:crypto";

export const RESOURCE_TICKET_LIFETIME_MS = 12 * 60 * 60 * 1000;

function signature(secret, kind, taskId, expiresAt) {
  return createHmac("sha256", secret)
    .update(`${kind}\n${taskId}\n${expiresAt}`)
    .digest("base64url");
}

export function issueResourceTicket(secret, kind, taskId, now = Date.now()) {
  if (!secret || !["media", "cover"].includes(kind) || !taskId) return "";
  const expiresAt = Math.floor(now + RESOURCE_TICKET_LIFETIME_MS);
  return `${expiresAt}.${signature(secret, kind, taskId, expiresAt)}`;
}

export function verifyResourceTicket(secret, kind, taskId, ticket, now = Date.now()) {
  if (!secret || !["media", "cover"].includes(kind) || !taskId) return false;
  const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(String(ticket || ""));
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now || expiresAt > now + RESOURCE_TICKET_LIFETIME_MS) return false;
  const expected = Buffer.from(signature(secret, kind, taskId, expiresAt));
  const received = Buffer.from(match[2]);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
