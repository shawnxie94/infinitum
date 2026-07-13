import crypto from "node:crypto";

import { buildAggregationParsingInput } from "@/lib/ingestion/model-input";

export const ITEM_UNDERSTANDING_VERSION = "1";

type ItemUnderstandingInput = {
  text: string;
  inputHash: string;
};

export function buildItemUnderstandingInput(input: {
  fullText?: string | null;
  rssContent?: string | null;
  rssExcerpt?: string | null;
  originalTitle: string;
}): ItemUnderstandingInput {
  const candidates = [
    input.fullText,
    input.rssContent,
    input.rssExcerpt,
    input.originalTitle,
  ];
  const rawText = candidates.find((value) => Boolean(value?.trim())) ?? input.originalTitle;
  const text = buildAggregationParsingInput(rawText?.trim() || input.originalTitle);
  const normalizedTitle = input.originalTitle.trim().replace(/\s+/g, " ");
  const inputHash = crypto
    .createHash("sha256")
    .update(`${ITEM_UNDERSTANDING_VERSION}\0${normalizedTitle}\0${text}`)
    .digest("hex");

  return {
    text,
    inputHash,
  };
}
