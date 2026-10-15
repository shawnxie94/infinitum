import { isValidCalendarDateParts } from "@/lib/utils/calendar-date";

type EventEvidence = {
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
};

type EvidenceClause = { text: string; sentence: number; rejected: boolean };

const REJECTED_CONTEXT = /否认|未能|并未|没有|尚未|延期|推迟|取消|占位|待定|\bnever\b|\bnot\b|postpon|cancel|placeholder|\btbd\b/iu;
const COMPARISON_CONTEXT = /竞争对手|竞品|相比|对比|而非|以?应对|对标|\bcompetitor\b|\bcompared\b|\bversus\b|rather than|compete with/iu;
const PLANNED_CONTEXT = /计划|预计|打算|拟(?=于|在|推出|发布|开放|上线)|将(?=于|在|会|推出|发布|开放|上线)|\bplans?\b|\bplanned\b|\bscheduled\b|\bwill\b/iu;
const GENERIC_OBJECT = /^(?:一款|一个|全新|最新|新版|新|下一代|未命名|尚未命名|ai|人工智能)*(?:产品|服务|模型|工具|平台|功能|设备|系统)$|^(?:未命名|unknown)$/iu;

function normalize(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function contains(text: string, value: string) {
  const source = normalize(text).toLowerCase();
  const term = normalize(value).toLowerCase();
  if (!term) return false;
  const literal = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // Latin names must not match inside other Latin identifiers; adjacent Han text is normal.
  const left = /^[a-z0-9]/u.test(term) ? "(?<![a-z0-9])" : "";
  const right = /[a-z0-9]$/u.test(term) ? "(?![a-z0-9])" : "";
  return new RegExp(`${left}${literal}${right}`, "iu").test(source);
}

function sourceClauses(text: string): EvidenceClause[] {
  // Split before collapsing whitespace, so paragraphs cannot lend each other event anchors.
  return text.normalize("NFKC")
    .split(/[。！？!?;；\r\n]+|\.(?=\s|$)/u)
    .flatMap((sentence, index) => sentence.split(/[,，]/u).map((part) => ({
      text: normalize(part), sentence: index, rejected: REJECTED_CONTEXT.test(sentence),
    })))
    .filter((clause) => clause.text.length > 0);
}

function explicitDates(text: string): Set<string> {
  const result = new Set<string>();
  const add = (year: string, month: string, day: string) => {
    if (isValidCalendarDateParts({ year: Number(year), month: Number(month), day: Number(day) })) {
      result.add(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
    }
  };
  for (const match of text.matchAll(/(?<!\d)(\d{4})年(\d{1,2})月(\d{1,2})日(?!\d)/gu)) {
    add(match[1], match[2], match[3]);
  }
  for (const match of text.matchAll(/(?<!\d)(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?!\d)/gu)) {
    add(match[1], match[3], match[4]);
  }
  return result;
}

function supportsTuple(clause: EvidenceClause, event: EventEvidence) {
  if (clause.rejected) return false;
  const subject = normalize(event.eventSubject ?? "");
  const object = normalize(event.eventObject ?? "");
  const action = normalize(event.eventAction ?? "");
  if (!subject || !object || !action || GENERIC_OBJECT.test(object.replace(/\s/gu, ""))) return false;
  if (!contains(clause.text, subject) || !contains(clause.text, object)) return false;

  const comparison = clause.text.search(COMPARISON_CONTEXT);
  if (comparison >= 0 && contains(clause.text.slice(comparison), object)) return false;

  const plannedAction = PLANNED_CONTEXT.test(action);
  if (PLANNED_CONTEXT.test(clause.text) !== plannedAction && /发布|上线|推出|开放|launch|release/iu.test(action)) {
    return false;
  }
  const actionCore = action.replace(new RegExp(PLANNED_CONTEXT.source, "giu"), "").trim();
  return Boolean(actionCore && contains(clause.text, actionCore));
}

function supportsDate(clause: EvidenceClause, date: string) {
  if (clause.rejected) return false;
  const dates = explicitDates(clause.text);
  // Multiple different dates in one unresolved clause do not identify a unique event date.
  return dates.size === 1 && dates.has(date);
}

/** Conservative source consistency check, not a general semantic or factual verifier. */
export function hasEventFieldEvidence(
  sourceText: string,
  sourceTitle: string,
  event: EventEvidence,
  field: "eventDate" | "eventObject",
): boolean {
  const clauses = sourceClauses(`${sourceTitle}\n${sourceText}`);
  if (field === "eventObject") return clauses.some((clause) => supportsTuple(clause, event));

  const date = normalize(event.eventDate ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  if (!isValidCalendarDateParts({ year, month, day })) return false;
  if (clauses.some((clause) => supportsDate(clause, date) && supportsTuple(clause, event))) return true;

  return clauses.some((clause, index) => {
    const previous = clauses[index - 1];
    return previous?.sentence === clause.sentence &&
      /^(?:日期为|日期是|日期[:：])/u.test(clause.text) &&
      supportsDate(clause, date) && supportsTuple(previous, event);
  });
}
