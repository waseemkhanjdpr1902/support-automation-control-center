import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

type SecretCheck =
  | { ok: true; mode: "verified" | "not_configured" }
  | { ok: false; response: NextResponse };

export function jsonOk<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export function jsonError(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ error: message, details }, { status });
}

export function handleRouteError(error: unknown) {
  if (error instanceof ZodError) {
    return jsonError("Invalid request payload.", 422, error.flatten());
  }

  if (error instanceof Error) {
    return jsonError(error.message, 500);
  }

  return jsonError("Unexpected server error.", 500);
}

function safeCompare(value: string, expected: string) {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);

  if (valueBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(valueBuffer, expectedBuffer);
}

export function assertWebhookSecret(request: Request): SecretCheck {
  const expected = process.env.N8N_WEBHOOK_SECRET;

  if (!expected) {
    return { ok: true, mode: "not_configured" };
  }

  const headerSecret = request.headers.get("x-n8n-webhook-secret");
  const bearerSecret = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const provided = headerSecret || bearerSecret;

  if (!provided || !safeCompare(provided, expected)) {
    return { ok: false, response: jsonError("Invalid webhook secret.", 401) };
  }

  return { ok: true, mode: "verified" };
}

export function assertReviewerAccess(
  role: "team_leader" | "manager",
  code?: string,
) {
  const expected =
    role === "manager"
      ? process.env.MANAGER_REVIEW_CODE
      : process.env.TEAM_LEADER_REVIEW_CODE;

  if (!expected) {
    return jsonError(`Review access is not configured for ${role.replace("_", " ")}.`, 503);
  }

  if (!code || !safeCompare(code, expected)) {
    return jsonError("Invalid reviewer access code.", 401);
  }

  return null;
}
