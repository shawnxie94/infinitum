import { afterEach, describe, expect, it, vi } from "vitest";

import { createRssParser } from "@/lib/ingestion/parser";
import { parsePublishedAt } from "@/lib/ingestion/item-processor";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rss parser", () => {
  it("handles whitespace in Atom closing tags without altering content or losing invalid-date fallback", async () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <title>Newsletter</title><updated>2026-11-06T13:20:34Z</updated\n >
      <entry><title>First</title><id>1</id><published>2026-11-06T13:20:34Z</published\n >
        <updated>2026-11-06T13:20:34Z</updated><content type="html"><![CDATA[<updated>not a date</updated>]]></content></entry>
      <entry><title>Second</title><id>2</id><published>not-a-date</published\n >
        <updated>2026-11-06T13:20:34Z</updated></entry>
    </feed>`;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(xml, { status: 200 })));
    const feed = await createRssParser().parseURL("https://newsletter.example/feed");
    expect(feed.items).toHaveLength(2);
    expect(feed.items![0].content).toContain("<updated>not a date</updated>");
    expect(feed.items![0].originalPublishedDate).toBe("2026-11-06T13:20:34Z");
    expect(parsePublishedAt(feed.items![1], new Date("2026-11-09T00:00:00Z"))).toEqual({
      value: new Date("2026-11-09T00:00:00Z"), known: false,
    });
  });

  it("preserves Atom publication text and applies timezone rules deterministically", async () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Dates</title>
      <entry><title>offset</title><published>2026-11-07T01:00:00-05:00</published></entry>
      <entry><title>z</title><published>2026-11-06T20:00:00Z</published></entry>
      <entry><title>local</title><published>2026-11-07T10:00:00</published></entry>
      <entry><title>published and updated</title><published>2026-11-07T10:00:00Z</published><updated>2026-11-09T08:01:00Z</updated></entry>
      <entry><title>updated only</title><updated>2026-11-07T10:00:00Z</updated></entry>
    </feed>`;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(xml, { status: 200 })));
    const feed = await createRssParser().parseURL("https://dates.example/feed");
    const fallback = new Date("2026-11-08T00:00:00.000Z");
    const byTitle = (title: string) => feed.items!.find((item) => item.title === title)!;
    expect(parsePublishedAt(byTitle("offset"), fallback)).toEqual({ value: new Date("2026-11-07T06:00:00.000Z"), known: true });
    expect(parsePublishedAt(byTitle("z"), fallback)).toEqual({ value: new Date("2026-11-06T20:00:00.000Z"), known: true });
    expect(parsePublishedAt(byTitle("local"), fallback)).toEqual({ value: new Date("2026-11-07T02:00:00.000Z"), known: true });
    expect(parsePublishedAt(byTitle("published and updated"), fallback)).toEqual({ value: new Date("2026-11-07T10:00:00.000Z"), known: true });
    expect(parsePublishedAt(byTitle("updated only"), fallback)).toEqual({ value: fallback, known: false });
    expect(parsePublishedAt({ pubDate: "2026-11-07T10:00:00 CST" }, fallback).known).toBe(false);
    expect(parsePublishedAt({ pubDate: "invalid" }, fallback).known).toBe(false);
    expect(parsePublishedAt({}, fallback).known).toBe(false);
  });

  it("prefers RSS pubDate when updated also exists on an RSS item", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>RSS dates</title><link>https://rss.example/</link>
      <item><title>both dates</title><link>https://rss.example/both</link><pubDate>Mon, 09 Nov 2026 16:00:00 +0800</pubDate><updated>2026-11-09T08:01:00Z</updated></item>
    </channel></rss>`;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(xml, { status: 200 })));
    const feed = await createRssParser().parseURL("https://rss.example/feed");
    const item = feed.items![0]!;
    expect(item.originalPublishedDate).toBe("Mon, 09 Nov 2026 16:00:00 +0800");
    expect(parsePublishedAt(item, new Date("2026-11-10T00:00:00.000Z"))).toEqual({
      value: new Date("2026-11-09T08:00:00.000Z"),
      known: true,
    });
  });

  it("matches namespace dates to RSS items and rejects normalized invalid calendar dates", async () => {
    const xml = `<?xml version="1.0"?>
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel><title>RDF</title><link>https://rdf.example/</link></channel>
        <item rdf:about="https://rdf.example/a"><title>GMT</title><link>https://rdf.example/a</link><dc:date>Sat, 07 Nov 2026 10:00:00 GMT</dc:date></item>
        <item rdf:about="https://rdf.example/b"><title>invalid</title><link>https://rdf.example/b</link><dc:date>2026-02-31T10:00:00</dc:date></item>
        <item rdf:about="https://rdf.example/c"><title>missing</title><link>https://rdf.example/c</link></item>
      </rdf:RDF>`;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(xml, { status: 200 })));
    const feed = await createRssParser().parseURL("https://rdf.example/feed");
    const fallback = new Date("2026-11-08T00:00:00.000Z");
    expect(parsePublishedAt(feed.items!.find((item) => item.title === "GMT")!, fallback)).toEqual({ value: new Date("2026-11-07T10:00:00.000Z"), known: true });
    expect(parsePublishedAt(feed.items!.find((item) => item.title === "invalid")!, fallback)).toEqual({ value: fallback, known: false });
    expect(parsePublishedAt(feed.items!.find((item) => item.title === "missing")!, fallback)).toEqual({ value: fallback, known: false });
  });
  it("retries once after an RSS fetch failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          `<?xml version="1.0" encoding="UTF-8" ?>
          <rss version="2.0">
            <channel>
              <title>Retry Feed</title>
              <link>https://retry.example.com</link>
              <item>
                <title>Recovered item</title>
                <link>https://retry.example.com/item</link>
              </item>
            </channel>
          </rss>`,
          {
            status: 200,
            headers: {
              "content-type": "application/rss+xml",
            },
          },
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    const feed = await createRssParser().parseURL("https://retry.example.com/feed.xml");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://retry.example.com/feed.xml",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: expect.stringContaining("application/rss+xml"),
          "User-Agent": "infinitum-feed-bot/1.0",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(feed.title).toBe("Retry Feed");
    expect(feed.items?.[0]?.title).toBe("Recovered item");
  });

  it("throws the RSS fetch error after the retry also fails", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(new Response("still failing", { status: 502 }));

    vi.stubGlobal("fetch", fetchMock);

    await expect(createRssParser().parseURL("https://retry.example.com/feed.xml")).rejects.toThrow(
      "RSS fetch failed with status 502",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("repairs unquoted XML attributes before parsing", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
        <rss version=2.0 xmlns:atom=http://www.w3.org/2005/Atom>
          <channel>
            <title>Jina AI</title>
            <link>https://jina.ai</link>
            <item>
              <title>Recovered item</title>
              <link>https://jina.ai/item</link>
            </item>
          </channel>
        </rss>`,
        {
          status: 200,
          headers: {
            "content-type": "application/rss+xml",
          },
        },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const feed = await createRssParser().parseURL("https://jina.ai/feed.rss");

    expect(feed.title).toBe("Jina AI");
    expect(feed.items?.[0]?.title).toBe("Recovered item");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults rss version when a feed omits the version attribute", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
        <rss>
          <channel>
            <title>Versionless Feed</title>
            <link>https://versionless.example.com</link>
            <item>
              <title>Recovered item</title>
              <link>https://versionless.example.com/item</link>
            </item>
          </channel>
        </rss>`,
        {
          status: 200,
          headers: {
            "content-type": "application/rss+xml",
          },
        },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const feed = await createRssParser().parseURL("https://versionless.example.com/feed.xml");

    expect(feed.title).toBe("Versionless Feed");
    expect(feed.items?.[0]?.title).toBe("Recovered item");
  });

  it("reports html responses as non-feed content", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE html><html><head><title>Jina AI</title></head><body>Not RSS</body></html>`,
        {
          status: 200,
          headers: {
            "content-type": "application/rss+xml",
          },
        },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    await expect(createRssParser().parseURL("https://jina.ai/feed.rss")).rejects.toThrow(
      "RSS URL returned an HTML page instead of RSS or Atom XML.",
    );
  });
});
