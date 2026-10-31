import { redirect } from "next/navigation";

import { getAdminSession } from "@/lib/admin/session";
import { OutsideApp } from "@/components/outside/outside-app";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "财经版",
  robots: { index: false, follow: false },
};

export default async function OutsidePage() {
  const session = await getAdminSession();

  if (!session.isAdmin) {
    redirect("/login?redirect=/outside");
  }

  return <OutsideApp />;
}
