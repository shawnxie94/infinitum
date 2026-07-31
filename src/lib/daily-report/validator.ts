import {
  type DailyReportContent,
  type DailyReportItem,
  type DailyReportItemNote,
} from "@/lib/daily-report/types";
import { normalizeDailyReportHeadline } from "@/lib/daily-report/title";

function stripCodeFence(value: string) {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function safeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function stripDailyReportGeneratedLabel(value: unknown) {
  return safeText(value)
    .replace(
      /^(?:\*\*)?\s*(?:摘要|开场摘要|今日观察|趋势观察|收尾观察|重点|为什么重要|来源|受影响|影响对象|建议|建议动作|行动建议|风险级别|关键数字|数据|适用场景|价值)\s*[：:]\s*(?:\*\*)?\s*/,
      "",
    )
    .trim();
}

function normalizeIds(value: unknown, maxId: number) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value.filter((entry): entry is number => Number.isInteger(entry) && entry >= 1 && entry <= maxId),
    ),
  );
}

function isAuxiliarySectionTitle(title: string) {
  return ["其他值得关注", "补充阅读", "延伸阅读"].includes(title.trim());
}

export function parseDailyReportContent(rawContent: string, maxSourceId: number): DailyReportContent {
  const parsed = JSON.parse(stripCodeFence(rawContent)) as unknown;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("日报模型输出不是 JSON 对象。");
  }

  const input = parsed as Record<string, unknown>;
  const errors: string[] = [];
  const headline = normalizeDailyReportHeadline(input.headline);

  const requireTitle = (value: unknown, path: string) => {
    const title = stripDailyReportGeneratedLabel(value);
    if (title.length < 4) {
      errors.push(`${path}.title 太短`);
    }
    return title;
  };

  const parseNotes = (value: unknown, path: string): DailyReportItemNote[] | undefined => {
    if (value == null) return undefined;
    if (!Array.isArray(value)) {
      errors.push(`${path}.notes 必须是数组`);
      return undefined;
    }
    const notes: DailyReportItemNote[] = [];
    value.forEach((rawNote) => {
      if (!rawNote || typeof rawNote !== "object") {
        return;
      }
      const note = rawNote as Record<string, unknown>;
      const label = safeText(note.label);
      const text = stripDailyReportGeneratedLabel(note.text);
      if (label && text) notes.push({ label, text });
    });
    return notes.length > 0 ? notes : undefined;
  };

  const parseItem = (rawItem: unknown, path: string, options: { discardWhenSourceIdsMissing?: boolean } = {}): DailyReportItem | null => {
    if (!rawItem || typeof rawItem !== "object") {
      errors.push(`${path} 不是对象`);
      return null;
    }
    const item = rawItem as Record<string, unknown>;
    const sourceIds = normalizeIds(item.sourceIds, maxSourceId);
    if (sourceIds.length < 1 && options.discardWhenSourceIdsMissing) {
      return null;
    }
    const title = requireTitle(item.title, path);
    const body = stripDailyReportGeneratedLabel(item.body);
    if (sourceIds.length < 1) {
      errors.push(`${path}.sourceIds 至少需要 1 个合法来源`);
    }
    if (!title) return null;
    const normalized: DailyReportItem = {
      title,
      body,
      sourceIds,
    };
    const notes = parseNotes(item.notes, path);
    if (notes) normalized.notes = notes;
    return normalized;
  };

  const blocks: DailyReportContent["blocks"] = [];
  let totalItems = 0;

  if (Array.isArray(input.blocks)) {
    input.blocks.forEach((rawBlock, blockIndex) => {
      const path = `blocks[${blockIndex}]`;
      if (!rawBlock || typeof rawBlock !== "object") {
        errors.push(`${path} 不是对象`);
        return;
      }
      const block = rawBlock as Record<string, unknown>;
      if (block.type === "text") {
        const title = safeText(block.title);
        const body = stripDailyReportGeneratedLabel(block.body);
        if (!title) errors.push(`${path}.title 不能为空`);
        if (body.length < 30) errors.push(`${path}.body 太短`);
        if (title && body) {
          const textBlock: DailyReportContent["blocks"][number] = {
            type: "text",
            title,
            body,
          };
          blocks.push(textBlock);
        }
        return;
      }
      if (block.type === "section") {
        const title = safeText(block.title);
        if (!title) errors.push(`${path}.title 不能为空`);
        const items = Array.isArray(block.items)
          ? block.items
            .map((rawItem, itemIndex) => parseItem(rawItem, `${path}.items[${itemIndex}]`, {
              discardWhenSourceIdsMissing: isAuxiliarySectionTitle(title),
            }))
            .filter((entry): entry is DailyReportItem => Boolean(entry))
          : [];
        if (!Array.isArray(block.items)) errors.push(`${path}.items 必须是数组`);
        totalItems += items.length;
        if (title) blocks.push({ type: "section", title, items });
        return;
      }
      errors.push(`${path}.type 必须是 text 或 section`);
    });
  } else {
    errors.push("blocks 必须是数组");
  }
  if (totalItems < 1) errors.push("所有 section 合计至少需要 1 条 item");

  if (errors.length > 0) {
    throw new Error(`日报输出校验失败：${errors.slice(0, 8).join("；")}`);
  }

  return {
    ...(headline ? { headline } : {}),
    blocks,
  };
}
