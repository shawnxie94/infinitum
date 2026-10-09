import type { Metadata } from "next";

import { PRIVATE_ROBOTS, SITE_NAME } from "@/lib/seo/metadata";

export const metadata: Metadata = {
  title: "管理后台",
  robots: PRIVATE_ROBOTS,
  alternates: {
    canonical: "/admin",
  },
  openGraph: {
    title: `${SITE_NAME} - 管理后台`,
  },
};

export default function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
