import { describe, expect, it } from "vitest";

import { buildAggregationParsingInput } from "@/lib/ingestion/model-input";
import { buildItemUnderstandingInput } from "@/lib/ingestion/content-input";

describe("ingestion model input", () => {
  it("preserves decoded article links for aggregation parsing", () => {
    const input = `
      <p>
        <a href="https://tracking.tldrnewsletter.com/CL0/https:%2F%2Fgaultier.github.io%2Fblog%2FI_sped_up_my_test_suite%3Futm_source=tldrdev/1/0100019ed55cf7e3/test">
          I sped up my test suite
        </a>
      </p>
      <a href="https://tracking.tldrnewsletter.com/CL0/https:%2F%2Ftldr.tech%2Fdev%3Futm_source=tldrdev/1/test">Sign Up</a>
      <script>window.secret=true</script>
    `;

    const output = buildAggregationParsingInput(input);

    expect(output).toContain("I sped up my test suite");
    expect(output).toContain("link: https://gaultier.github.io/blog/I_sped_up_my_test_suite?utm_source=tldrdev");
    expect(output).not.toContain("tracking.tldrnewsletter.com");
    expect(output).not.toContain("window.secret");
    expect(output).not.toContain("link: https://tldr.tech/dev");
  });

  it("builds one understanding input from the best available source", () => {
    const input = buildItemUnderstandingInput({
      fullText: "<p>完整正文 <a href=\"https://example.com/source\">原始来源</a></p>",
      rssContent: "RSS 内容",
      rssExcerpt: "RSS 摘要",
      originalTitle: "标题",
    });

    expect(input).toContain("完整正文");
    expect(input).toContain("link: https://example.com/source");
    expect(input).not.toContain("RSS 内容");
  });
});
