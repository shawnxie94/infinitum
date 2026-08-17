export async function register() {
  if (process.env.NEXT_RUNTIME !== "edge") {
    const { configureFetchProxyFromEnv } = await import("@/lib/http/proxy");
    const { ensureRuntimeConfigSeeded } = await import("@/lib/settings/core");
    configureFetchProxyFromEnv();
    await ensureRuntimeConfigSeeded();
  }
}
