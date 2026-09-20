import { z } from "zod";

import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import {
  createSource,
  listSourcesForAdmin,
  type AdminSourceGroupFilter,
} from "@/lib/settings/service";

const sourceSchema = z.object({
  name: z.string().min(1),
  rssUrl: z.url(),
  siteUrl: z.url(),
  enabled: z.boolean(),
  aiParsingEnabled: z.boolean().default(true),
  aggregationEnabled: z.boolean().default(true),
  aggregationDetectionEnabled: z.boolean().default(false),
  groupId: z.string().nullable().optional(),
});

function parseOptionalInt(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseEnabledFilter(value: string | null) {
  if (value === "true" || value === "enabled") {
    return true;
  }

  if (value === "false" || value === "disabled") {
    return false;
  }

  return null;
}

function parseGroupFilter(value: string | null): AdminSourceGroupFilter {
  if (value === "__ungrouped__") {
    return { kind: "ungrouped" };
  }

  if (value) {
    return { kind: "group", groupId: value };
  }

  return { kind: "all" };
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const page = parseOptionalInt(searchParams.get("page"), 1);
    const pageSize = Math.min(100, parseOptionalInt(searchParams.get("pageSize"), 20));
    const search = searchParams.get("search")?.trim() ?? "";
    const enabled = parseEnabledFilter(searchParams.get("enabled"));
    const group = parseGroupFilter(searchParams.get("groupId"));

    const result = await listSourcesForAdmin({ page, pageSize, search, enabled, group });

    return Response.json(result);
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = sourceSchema.parse(await request.json());
    const source = await createSource(body);

    return Response.json({ source }, { status: 201 });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
