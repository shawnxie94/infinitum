import Parser from "rss-parser";

import { RSS_FETCH_RETRY_COUNT } from "@/config/constants";
import type { ParsedFeed, ParsedFeedItem, RssParserLike } from "@/lib/ingestion/types";

const UNQUOTED_ATTRIBUTE_VALUE_ERROR = /Unquoted attribute value/i;
const HTML_INSTEAD_OF_FEED_ERROR = "RSS URL returned an HTML page instead of RSS or Atom XML.";

function splitLeadingToken(text: string): [string, string] {
  const match = text.match(/^([^\s/>]+)([\s\S]*)$/);
  return match ? [match[1], match[2]] : [text, ""];
}

function repairAttributeList(attrs: string): string {
  let repaired = "";
  let index = 0;

  while (index < attrs.length) {
    const current = attrs[index];

    if (/\s/.test(current)) {
      repaired += current;
      index += 1;
      continue;
    }

    const nameStart = index;
    while (index < attrs.length && !/[\s=>]/.test(attrs[index])) {
      index += 1;
    }

    const name = attrs.slice(nameStart, index);
    let whitespaceBeforeEquals = "";
    while (index < attrs.length && /\s/.test(attrs[index])) {
      whitespaceBeforeEquals += attrs[index];
      index += 1;
    }

    if (attrs[index] !== "=") {
      repaired += name + whitespaceBeforeEquals;
      continue;
    }

    repaired += name + whitespaceBeforeEquals + attrs[index];
    index += 1;

    let whitespaceAfterEquals = "";
    while (index < attrs.length && /\s/.test(attrs[index])) {
      whitespaceAfterEquals += attrs[index];
      index += 1;
    }

    repaired += whitespaceAfterEquals;

    if (index >= attrs.length) {
      break;
    }

    const quote = attrs[index];
    if (quote === "\"" || quote === "'") {
      repaired += attrs[index];
      index += 1;
      while (index < attrs.length) {
        const char = attrs[index];
        repaired += char;
        index += 1;
        if (char === quote) {
          break;
        }
      }
      continue;
    }

    const valueStart = index;
    while (index < attrs.length && !/[\s<>]/.test(attrs[index])) {
      index += 1;
    }

    repaired += `"${attrs.slice(valueStart, index)}"`;
  }

  return repaired;
}

function repairXmlTag(chunk: string): string {
  if (
    chunk.startsWith("<!--") ||
    chunk.startsWith("<![CDATA[") ||
    chunk.startsWith("</") ||
    chunk.startsWith("<!DOCTYPE") ||
    chunk.startsWith("<![")
  ) {
    return chunk;
  }

  if (chunk.startsWith("<?")) {
    const body = chunk.slice(2, -2);
    const [target, attrs] = splitLeadingToken(body);
    return `<?${target}${repairAttributeList(attrs)}?>`;
  }

  const selfClosing = chunk.endsWith("/>");
  const body = chunk.slice(1, selfClosing ? -2 : -1);
  const [entityName, attrs] = splitLeadingToken(body);
  return `<${entityName}${repairAttributeList(attrs)}${selfClosing ? "/>" : ">"}`;
}

function repairUnquotedAttributeValues(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>]+>/g, repairXmlTag);
}

function getLeadingDocumentMarkup(xml: string): string {
  let leading = xml.replace(/^\uFEFF/, "").trimStart();

  while (true) {
    const next = leading
      .replace(/^<\?xml[\s\S]*?\?>\s*/i, "")
      .replace(/^<!--[\s\S]*?-->\s*/i, "");

    if (next === leading) {
      return leading;
    }

    leading = next.trimStart();
  }
}

function isHtmlDocument(xml: string): boolean {
  const leading = getLeadingDocumentMarkup(xml);
  return /^<!doctype\s+html\b/i.test(leading) || /^<html\b/i.test(leading);
}

export function createRssParser(): RssParserLike {
  const parser = new Parser<Record<string, never>, ParsedFeedItem>({
    defaultRSS: 2,
  });

  const parseXml = async (xml: string): Promise<ParsedFeed> => {
    const feed = await parser.parseString(xml);

    return {
      title: typeof feed.title === "string" ? feed.title : null,
      link: typeof feed.link === "string" ? feed.link : null,
      feedUrl: typeof feed.feedUrl === "string" ? feed.feedUrl : null,
      items: feed.items,
    };
  };

  return {
    async parseURL(url: string, options?: { headers?: Record<string, string> }): Promise<ParsedFeed> {
      let response: Response | null = null;
      let lastError: unknown = null;

      for (let attempt = 0; attempt <= RSS_FETCH_RETRY_COUNT; attempt += 1) {
        try {
          response = await fetch(url, {
            headers: {
              Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7",
              "User-Agent": "infinitum-feed-bot/1.0",
              ...options?.headers,
            },
          });

          if (response.ok || response.status === 304) {
            break;
          }

          lastError = new Error(`RSS fetch failed with status ${response.status}`);
        } catch (error) {
          lastError = error;
        }
      }

      if (!response) {
        throw lastError instanceof Error ? lastError : new Error("RSS fetch failed");
      }

      if (response.status === 304) {
        return {
          notModified: true,
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
          items: [],
        };
      }

      if (!response.ok) {
        throw lastError instanceof Error ? lastError : new Error(`RSS fetch failed with status ${response.status}`);
      }

      const xml = await response.text();

      if (isHtmlDocument(xml)) {
        throw new Error(HTML_INSTEAD_OF_FEED_ERROR);
      }

      try {
        const feed = await parseXml(xml);
        return {
          ...feed,
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
        };
      } catch (error) {
        if (!UNQUOTED_ATTRIBUTE_VALUE_ERROR.test(error instanceof Error ? error.message : "")) {
          throw error;
        }

        const repairedFeed = await parseXml(repairUnquotedAttributeValues(xml));
        return {
          ...repairedFeed,
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
        };
      }
    },
  };
}
