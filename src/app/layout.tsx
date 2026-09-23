import type { Metadata } from "next";

import { ToastProvider } from "@/components/ui/toast";
import {
  buildOrganizationJsonLd,
  getMetadataBase,
  PUBLIC_ROBOTS,
  SEO_KEYWORDS,
  serializeJsonLd,
  SITE_DEFAULT_DESCRIPTION,
  SITE_DEFAULT_TITLE,
  SITE_NAME,
} from "@/lib/seo/metadata";

import "./globals.css";
// 品牌字体经 scripts/subset-brand-font.mjs 切片为 unicode-range 分片（public/fonts/lxgw-wenkai-mono），
// 浏览器按页面实际字形按需下载；改字体后需重跑 npm run fonts:subset。

export const metadata: Metadata = {
  metadataBase: getMetadataBase(),
  applicationName: SITE_NAME,
  title: {
    default: SITE_DEFAULT_TITLE,
    template: `${SITE_NAME} - %s`,
  },
  description: SITE_DEFAULT_DESCRIPTION,
  keywords: SEO_KEYWORDS,
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  robots: PUBLIC_ROBOTS,
  alternates: {
    canonical: "/",
    types: {
      "application/rss+xml": [
        { title: "Infinitum 资讯聚合 RSS", url: "/api/feed/rss" },
        { title: "Infinitum AI 日报 RSS", url: "/api/daily/rss" },
      ],
    },
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    siteName: SITE_NAME,
    title: SITE_DEFAULT_TITLE,
    description: SITE_DEFAULT_DESCRIPTION,
    url: "/",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: SITE_DEFAULT_TITLE,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_DEFAULT_TITLE,
    description: SITE_DEFAULT_DESCRIPTION,
    images: ["/opengraph-image"],
  },
  category: "technology",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        {/* 字体 CSS 独立于应用 CSS 打包，以获得与分片解耦的 immutable 缓存（见 next.config headers）。 */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/fonts/lxgw/index.css" />
      </head>
      <body>
        <ToastProvider>{children}</ToastProvider>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(buildOrganizationJsonLd()) }}
        />
      </body>
    </html>
  );
}
