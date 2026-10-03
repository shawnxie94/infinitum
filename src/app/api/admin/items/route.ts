import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { listFilteredItems } from "@/lib/feed/repository";

const MODERATION_REASONS = new Set([
  "marketing",
  "low_quality",
  "duplicate_noise",
  "rule_filter",
  "rule_blacklist",
  "stale_content",
  "other",
]);
const RANGE_DAYS = new Set([1, 3, 7]);

function getRangeStart(value: string | null) {
  const rangeDays = Number(value);
  if (!RANGE_DAYS.has(rangeDays)) {
    return null;
  }

  const now = new Date();
  return new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);
}

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const moderationStatus = searchParams.get("moderationStatus");

    if (moderationStatus && moderationStatus !== "filtered") {
      return Response.json({ items: [], total: 0, page: 1, pageSize: 20 });
    }

    const page = Math.max(1, Number(searchParams.get("page")) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(searchParams.get("pageSize")) || 20));
    const moderationReason = searchParams.get("reason")?.trim() ?? "";

    const result = await listFilteredItems(page, pageSize, {
      search: searchParams.get("search")?.trim() ?? "",
      sourceName: searchParams.get("sourceName")?.trim() ?? "",
      moderationReason: MODERATION_REASONS.has(moderationReason) ? moderationReason : "",
      updatedAtStart: getRangeStart(searchParams.get("rangeDays")),
    });

    return Response.json(result);
  } catch (error) {
    return adminErrorResponse(error);
  }
}
