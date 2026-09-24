import { prisma } from "@/lib/db";

export async function checkHealth(): Promise<"ok" | "unhealthy"> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "unhealthy";
  }
}
