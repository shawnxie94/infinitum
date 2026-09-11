import type { Metadata } from "next";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import localFont from "next/font/local";

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

const brandFont = localFont({
  src: "./fonts/LXGWWenKaiMono.ttf",
  weight: "400",
  style: "normal",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
  variable: "--font-brand",
});

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
    <html className={brandFont.variable} lang="zh-CN">
      <body>
        <AntdRegistry>
          <ToastProvider>{children}</ToastProvider>
        </AntdRegistry>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(buildOrganizationJsonLd()) }}
        />
      </body>
    </html>
  );
}
