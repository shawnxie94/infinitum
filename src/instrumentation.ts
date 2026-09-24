export async function register() {
  if (process.env.NEXT_RUNTIME !== "edge") {
    const { assertDeployableAdminCredentials } = await import("@/lib/admin/session");
    assertDeployableAdminCredentials();

    const { configureFetchProxyFromEnv } = await import("@/lib/http/proxy");
    const { ensureRuntimeConfigSeeded } = await import("@/lib/settings/core");
    configureFetchProxyFromEnv();
    await ensureRuntimeConfigSeeded();
  }
}
