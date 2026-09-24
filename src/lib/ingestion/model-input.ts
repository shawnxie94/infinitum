import { stripHtmlTags } from "@/lib/feed/presentation";

const MODEL_INPUT_MAX_CHARS = 32_000;
const MODEL_INPUT_TRUNCATED_NOTICE = "\n\n[内容过长，已截断用于摘要。]";
const HTML_BLOCK_PATTERN = /<(script|style|noscript|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const HTML_ANCHOR_PATTERN = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF_ATTRIBUTE_PATTERN = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/i;
const LOW_SIGNAL_ANCHOR_TEXT_PATTERN = /^(?:sign up|subscribe|unsubscribe|privacy policy|terms|view in browser|read online|advertise|sponsor|share|tweet|follow|login|log in)$/i;

function trimModelInput(inputText: string, truncatedNotice: string): string {
  if (!inputText) {
    return "";
  }

  if (inputText.length <= MODEL_INPUT_MAX_CHARS) {
    return inputText;
  }

  const maxBodyLength = MODEL_INPUT_MAX_CHARS - truncatedNotice.length;
  return `${inputText.slice(0, maxBodyLength).trimEnd()}${truncatedNotice}`;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "quot") return "\"";
    if (normalized === "apos") return "'";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "nbsp") return " ";

    if (normalized.startsWith("#x")) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    if (normalized.startsWith("#")) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return match;
  });
}

function extractHref(attributes: string): string | null {
  const match = attributes.match(HREF_ATTRIBUTE_PATTERN);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function unwrapTldrTrackingUrl(url: URL): URL {
  if (url.hostname !== "tracking.tldrnewsletter.com") {
    return url;
  }

  const match = url.pathname.match(/^\/CL0\/([^/]+)/);
  if (!match?.[1]) {
    return url;
  }

  try {
    return new URL(decodeURIComponent(match[1]));
  } catch {
    return url;
  }
}

function normalizeHttpUrl(rawHref: string | null): string | null {
  if (!rawHref) {
    return null;
  }

  const decodedHref = decodeHtmlEntities(rawHref).trim();
  if (!decodedHref || decodedHref.startsWith("#")) {
    return null;
  }

  try {
    const parsed = unwrapTldrTrackingUrl(new URL(
      decodedHref.startsWith("//") ? `https:${decodedHref}` : decodedHref,
    ));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function stripHtmlNoise(inputText: string): string {
  return inputText
    .replace(HTML_COMMENT_PATTERN, " ")
    .replace(HTML_BLOCK_PATTERN, " ");
}

function preserveAnchorLinks(inputText: string): string {
  return inputText.replace(HTML_ANCHOR_PATTERN, (anchor, attributes: string, body: string) => {
    const anchorText = stripHtmlTags(body);
    const normalizedHref = normalizeHttpUrl(extractHref(attributes));

    if (!anchorText || !normalizedHref || LOW_SIGNAL_ANCHOR_TEXT_PATTERN.test(anchorText)) {
      return anchorText || " ";
    }

    return `${anchorText} (link: ${normalizedHref})`;
  });
}

export function buildAggregationParsingInput(inputText: string): string {
  const cleaned = stripHtmlTags(preserveAnchorLinks(stripHtmlNoise(inputText)));
  return trimModelInput(cleaned, MODEL_INPUT_TRUNCATED_NOTICE);
}
