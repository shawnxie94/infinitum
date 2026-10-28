import { getEventTypeRegistrySnapshot } from "@/lib/event-types/registry";

/**
 * 公开注册表：返回全部展示 key/label（含停用类型，enabled 标注），保证
 * 历史/停用条目仍用配置 label 展示；新输出约束仍由服务端 resolver 只取启用类型。
 */
export async function GET() {
  try {
    const snapshot = await getEventTypeRegistrySnapshot();

    return Response.json({
      fingerprint: snapshot.fingerprint,
      eventTypes: snapshot.types.map(({ key, label, description, enabled }) => ({
        key,
        label,
        description,
        enabled,
      })),
    });
  } catch {
    return Response.json({ fingerprint: null, eventTypes: [] }, { status: 200 });
  }
}
