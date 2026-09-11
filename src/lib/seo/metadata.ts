import type { Metadata } from "next";

import { resolveOriginFromHeaders } from "@/lib/http/public-origin";

export const SITE_NAME = "Infinitum";

// 首页页签标题后缀，可通过环境变量 SITE_HOME_TITLE 自定义（docker-compose 注入，重启生效）。
// 后续可作为后台设置项，届时以 DB 配置为准。
export const SITE_HOME_TITLE =
  (process.env.SITE_HOME_TITLE ?? "").trim() || "资讯聚合平台";

export const SITE_DEFAULT_TITLE = `${SITE_NAME} - ${SITE_HOME_TITLE}`;
export const SITE_DEFAULT_DESCRIPTION = "Infinitum 聚合、分析与整理来自多个来源的技术资讯，提供高密度信息流、主题聚类和 AI 日报。";

export const SEO_KEYWORDS = [
  "Infinitum",
  "资讯聚合",
  "技术资讯",
  "AI 日报",
  "RSS 聚合",
  "内容聚类",
];

export const PUBLIC_ROBOTS: Metadata["robots"] = {
  index: true,
  follow: true,
  googleBot: {
    index: true,
    follow: true,
    "max-image-preview": "large",
    "max-snippet": -1,
    "max-video-preview": -1,
  },
};

export const PRIVATE_ROBOTS: Metadata["robots"] = {
  index: false,
  follow: false,
  googleBot: {
    index: false,
    follow: false,
  },
};

export function getSiteOrigin(headers?: Headers) {
  return resolveOriginFromHeaders(headers ?? null);
}

export function getSiteUrl(path = "/", headers?: Headers) {
  return new URL(path, getSiteOrigin(headers)).toString();
}

export function getMetadataBase(headers?: Headers) {
  return new URL(getSiteOrigin(headers));
}

export function stripInlineMarkdown(value: string) {
  return value
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function toSeoDescription(value: string | null | undefined, fallback = SITE_DEFAULT_DESCRIPTION, maxLength = 160) {
  const normalized = stripInlineMarkdown(value ?? "");
  const source = normalized || fallback;

  if (source.length <= maxLength) {
    return source;
  }

  return `${source.slice(0, maxLength - 1).trimEnd()}…`;
}

export function serializeJsonLd(data: unknown) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function buildWebSiteJsonLd() {
  const origin = getSiteOrigin();

  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: origin,
    inLanguage: "zh-CN",
    description: SITE_DEFAULT_DESCRIPTION,
    potentialAction: {
      "@type": "SearchAction",
      target: `${origin}/?title={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  };
}


export const ORGANIZATION_LOGO_URL = "/brand-mark.svg";
export const ORGANIZATION_SAME_AS: string[] = [];

export function buildOrganizationJsonLd() {
  const origin = getSiteOrigin();

  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${origin}#organization`,
    name: SITE_NAME,
    url: origin,
    logo: {
      "@type": "ImageObject",
      url: `${origin}${ORGANIZATION_LOGO_URL}`,
    },
    sameAs: ORGANIZATION_SAME_AS,
  };
}

export function buildBreadcrumbListJsonLd(
  items: { name: string; path: string }[],
) {
  const origin = getSiteOrigin();

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.path.startsWith("http")
        ? item.path
        : `${origin}${item.path.startsWith("/") ? "" : "/"}${item.path}`,
    })),
  };
}

export const LLMS_SUMMARY =
  `${SITE_NAME} 是一个由 AI 驱动的资讯聚合平台，汇集、翻译、聚类并整理来自多个来源的技术资讯，每日生成 AI 日报。` +
  " 主要入口：首页资讯流、AI 日报、RSS 订阅。";

export const LLMS_FULL_ENTRY_LIMIT = 30;
export const LLMS_FULL_HEADING = `# ${SITE_NAME} - AI 资讯聚合平台`;

