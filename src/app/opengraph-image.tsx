import { ImageResponse } from "next/og";

import { getBrandMarkDataUrl } from "@/lib/brand/asset";
import { SITE_DEFAULT_DESCRIPTION, SITE_DEFAULT_TITLE, SITE_HOME_TITLE, SITE_NAME } from "@/lib/seo/metadata";

export const alt = SITE_DEFAULT_TITLE;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 86400;

export default function OpenGraphImage() {
  const brand = getBrandMarkDataUrl();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background:
            "linear-gradient(135deg, #0b0d12 0%, #1a1d29 60%, #2a2f44 100%)",
          color: "#f5f5f7",
          fontFamily: "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          {/* Brand mark: 深色实心圆 + 白色三角形 (来自 public/brand-mark-512.png) */}
          <img
            src={brand}
            width={96}
            height={96}
            alt={SITE_NAME}
            style={{ borderRadius: 22 }}
          />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 38, fontWeight: 600, opacity: 0.75 }}>
              {SITE_NAME}
            </div>
            <div style={{ fontSize: 28, fontWeight: 500, opacity: 0.5 }}>
              AI 资讯聚合
            </div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div
            style={{
              fontSize: 72,
              fontWeight: 700,
              lineHeight: 1.15,
              maxWidth: 960,
            }}
          >
            {SITE_HOME_TITLE}
          </div>
          <div
            style={{
              fontSize: 30,
              fontWeight: 400,
              opacity: 0.7,
              maxWidth: 960,
              lineHeight: 1.4,
            }}
          >
            {SITE_DEFAULT_DESCRIPTION}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 24,
            opacity: 0.5,
          }}
        >
          <span>RSS · 资讯聚合 · AI 日报</span>
          <span>by Infinitum</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
