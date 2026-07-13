import { buildAggregationParsingInput } from "@/lib/ingestion/model-input";

export function buildItemUnderstandingInput(input: {
  fullText?: string | null;
  rssContent?: string | null;
  rssExcerpt?: string | null;
  originalTitle: string;
}): string {
  const candidates = [
    input.fullText,
    input.rssContent,
    input.rssExcerpt,
    input.originalTitle,
  ];
  const rawText = candidates.find((value) => Boolean(value?.trim())) ?? input.originalTitle;

  return buildAggregationParsingInput(rawText?.trim() || input.originalTitle);
}
