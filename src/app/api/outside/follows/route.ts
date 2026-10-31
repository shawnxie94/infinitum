import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import {
  followSource,
  listFollowedSourceIds,
  listSourceCatalog,
  listSourceCatalogChannels,
  unfollowSource,
} from "@/lib/sources/follows";

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const originKind = searchParams.get("originKind") === "preset" ? "preset" : null;
    const catalog = await listSourceCatalog({
      originKind,
      channel: searchParams.get("channel"),
      search: searchParams.get("search"),
    });

    // 渠道筛选项始终使用完整渠道集，保证单渠道下还能切到其他渠道。
    const allChannels = listSourceCatalogChannels(await listSourceCatalog({ originKind }));

    return Response.json({
      sources: catalog,
      channels: allChannels,
      followedSourceIds: await listFollowedSourceIds(),
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = (await request.json()) as { sourceId?: string; action?: string };
    const sourceId = body.sourceId?.trim();
    if (!sourceId) {
      return Response.json({ error: "缺少 sourceId。" }, { status: 400 });
    }

    if (body.action === "unfollow") {
      await unfollowSource(sourceId);
    } else {
      await followSource(sourceId);
    }

    return Response.json({ ok: true, followedSourceIds: await listFollowedSourceIds() });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
