import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import {
  cancelOrcaRouterConnect,
  completeOrcaRouterConnect,
  startOrcaRouterConnect,
} from "@/lib/settings/service";

/**
 * OrcaRouter OAuth 2.0 + PKCE connect flow (Flow B, out-of-band code).
 *
 * Infinitum is self-hosted and its install address differs on every
 * deployment, so there is no predictable address a redirect could return to.
 * The consent screen displays a code which the admin pastes back here; the
 * verifier never leaves this process and is never returned to the browser.
 *
 * POST   starts (or supersedes) an attempt.
 * PUT    completes an attempt — the user pasted the code.
 * DELETE cancels the attempt and releases the server-side login lock.
 */
const startSchema = z.object({
  configId: z.string().min(1),
  callbackMode: z.enum(["loopback", "out-of-band"]).optional(),
  callbackUrl: z.string().optional(),
});

const completeSchema = z.object({
  configId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  code: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = startSchema.parse(await request.json());

    return Response.json({ success: true, session: startOrcaRouterConnect(body) });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    await requireAdmin();
    const body = completeSchema.parse(await request.json());

    const result = await completeOrcaRouterConnect(body);

    // A failed exchange is a normal, terminal outcome the panel renders from
    // `session.error`; it is not a transport-level error, so no top-level
    // `error` field is set here (that field means "the request itself failed").
    return Response.json({ success: result.ok, session: result.session });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await requireAdmin();
    const body = startSchema.pick({ configId: true }).parse(await request.json());

    return Response.json({ success: true, session: cancelOrcaRouterConnect(body.configId) });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
