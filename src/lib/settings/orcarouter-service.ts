/**
 * OrcaRouter settings service.
 *
 * This is the single place where the two authentication choices are resolved
 * into a credential and where the live model catalog is fetched. The browser
 * never receives the API key: discovery runs here, server-side, and the client
 * only gets minimal model metadata.
 */

import { prisma } from "@/lib/db";
import {
  decideReauth,
  nextCredentialGeneration,
  resolveOrcaRouterCredential,
  type OrcaRouterCredentialResult,
  type OrcaRouterCredentialSource,
  type OrcaRouterStoredCredential,
} from "@/lib/ai/orcarouter/credentials";
import {
  discoverOrcaRouterModels,
  type OrcaRouterCapability,
  type OrcaRouterCatalogResult,
} from "@/lib/ai/orcarouter/catalog";
import { resolveOrcaRouterOrigins } from "@/lib/ai/orcarouter/origins";
import { ConnectSessions } from "@/lib/ai/orcarouter/connect-sessions";
import type { OrcaRouterConnectSessionView } from "@/lib/settings/types";
import { normalizeText } from "@/lib/utils/text";
import { ensureRuntimeConfigSeeded } from "@/lib/settings/core";

/** Process-wide connect locks. One pending authorization per model API config. */
export const orcaRouterConnectSessions = new ConnectSessions();

function toStoredCredential(config: {
  apiKey: string;
  authMethod?: string | null;
  oauthAccountId?: string | null;
  oauthScope?: string | null;
  credentialGeneration?: number | null;
  needsReauth?: boolean | null;
}): OrcaRouterStoredCredential {
  return {
    authMethod: config.authMethod === "pkce" ? "pkce" : "api-key",
    apiKey: config.apiKey ?? "",
    accountId: config.oauthAccountId ?? "",
    scope: config.oauthScope ?? "",
    needsReauth: Boolean(config.needsReauth),
    credentialGeneration: config.credentialGeneration ?? 1,
  };
}

async function requireModelApiConfig(configId: string) {
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: false });

  const config = await prisma.modelApiConfig.findUnique({ where: { id: configId } });
  if (!config) {
    throw new Error("模型配置不存在。");
  }
  return config;
}

/**
 * Resolves the credential for a config through its selected adapter, so
 * downstream code never branches on API-key vs PKCE.
 */
export async function resolveConfigCredential(
  configId: string,
): Promise<OrcaRouterCredentialResult | null> {
  const config = await requireModelApiConfig(configId);

  return resolveOrcaRouterCredential({
    stored: toStoredCredential(config),
    envApiKey: process.env.ORCAROUTER_API_KEY ?? "",
  });
}

export async function listOrcaRouterModels(input: {
  configId: string;
  capability: OrcaRouterCapability;
  requiredInputModalities?: string[];
}): Promise<OrcaRouterCatalogResult & { credentialSource: OrcaRouterCredentialSource | null }> {
  const config = await requireModelApiConfig(input.configId);
  const origins = resolveOrcaRouterOrigins(process.env);

  const credential = resolveOrcaRouterCredential({
    stored: toStoredCredential(config),
    envApiKey: process.env.ORCAROUTER_API_KEY ?? "",
  });

  if (!credential) {
    // No credential: return the verified seed so a fresh install is still
    // usable, but mark it degraded rather than offering free-text entry.
    const catalog = await discoverOrcaRouterModels({
      apiBase: origins.apiBase,
      apiKey: "",
      capability: input.capability,
      requiredInputModalities: input.requiredInputModalities,
    });
    return { ...catalog, credentialSource: null };
  }

  const catalog = await discoverOrcaRouterModels({
    apiBase: origins.apiBase,
    apiKey: credential.apiKey,
    capability: input.capability,
    requiredInputModalities: input.requiredInputModalities,
  });

  // A revoked key surfaces as an auth failure from the catalog endpoint. The
  // credential is marked for reauthentication rather than silently retried.
  if (catalog.degraded && catalog.error?.includes("401")) {
    await markOrcaRouterNeedsReauth(config.id, {
      accountId: credential.accountId,
      generation: config.credentialGeneration ?? 1,
    });
  }

  return { ...catalog, credentialSource: credential.source };
}

export function startOrcaRouterConnect(input: {
  configId: string;
  callbackMode?: "loopback" | "out-of-band";
  callbackUrl?: string;
}): OrcaRouterConnectSessionView {
  const session = orcaRouterConnectSessions.start({
    configId: input.configId,
    callbackMode: input.callbackMode,
    callbackUrl: input.callbackUrl,
    scope: "api",
  });

  // The authorize URL is safe to hand to the browser: it carries only the S256
  // challenge and the opaque state, never the verifier.
  return orcaRouterConnectSessions.toPublicSession(session);
}

export function cancelOrcaRouterConnect(configId: string): OrcaRouterConnectSessionView {
  orcaRouterConnectSessions.cancel(configId);
  const session = orcaRouterConnectSessions.get(configId);
  return session
    ? orcaRouterConnectSessions.toPublicSession(session)
    : {
        attemptId: "",
        generation: 0,
        status: "idle",
        authorizeUrl: "",
        requestedScope: "api",
        callbackMode: "out-of-band",
        accountId: null,
        grantedScope: null,
        error: null,
      };
}

/**
 * Completes the connect flow and persists the durable key. The key is written
 * only after a successful exchange — the previous secret is never deleted
 * before a replacement exists.
 */
export async function completeOrcaRouterConnect(input: {
  configId: string;
  generation: number;
  code: string;
}): Promise<{ ok: boolean; session: OrcaRouterConnectSessionView; error: string | null }> {
  await requireModelApiConfig(input.configId);

  const result = await orcaRouterConnectSessions.complete({
    configId: input.configId,
    generation: input.generation,
    code: input.code,
    persist: async (credential) => {
      const current = await prisma.modelApiConfig.findUnique({ where: { id: input.configId } });
      if (!current) {
        throw new Error("模型配置不存在。");
      }

      await prisma.modelApiConfig.update({
        where: { id: input.configId },
        data: {
          apiKey: credential.apiKey,
          authMethod: "pkce",
          oauthAccountId: credential.accountId ?? "",
          oauthScope: credential.scope ?? "",
          credentialGeneration: nextCredentialGeneration(current.credentialGeneration ?? 1),
          needsReauth: false,
        },
      });
    },
  });

  const session = result.session ?? orcaRouterConnectSessions.get(input.configId);
  const view: OrcaRouterConnectSessionView = session
    ? orcaRouterConnectSessions.toPublicSession(session)
    : {
        attemptId: "",
        generation: 0,
        status: "idle",
        authorizeUrl: "",
        requestedScope: "api",
        callbackMode: "out-of-band",
        accountId: null,
        grantedScope: null,
        error: null,
      };

  return { ok: result.ok, session: view, error: result.error ?? null };
}

/**
 * API-key choice: stores a pasted key and returns the config to the API-key
 * adapter. Independent of the connect flow.
 */
export async function saveOrcaRouterApiKey(input: {
  configId: string;
  apiKey: string;
  apiKeyMode: "replace" | "clear" | "keep";
}): Promise<void> {
  const current = await requireModelApiConfig(input.configId);

  const nextApiKey =
    input.apiKeyMode === "clear"
      ? ""
      : input.apiKeyMode === "keep"
        ? current.apiKey
        : normalizeText(input.apiKey);

  await prisma.modelApiConfig.update({
    where: { id: input.configId },
    data: {
      apiKey: nextApiKey,
      authMethod: "api-key",
      credentialGeneration: nextCredentialGeneration(current.credentialGeneration ?? 1),
      needsReauth: false,
    },
  });
}

/**
 * Terminal `401` handling. Only the exact account + generation that made the
 * rejected request is marked; a late failure cannot poison a fresh login.
 */
export async function markOrcaRouterNeedsReauth(
  configId: string,
  rejected: { accountId: string | null; generation: number },
): Promise<boolean> {
  const current = await requireModelApiConfig(configId);

  const decision = decideReauth({
    rejectedAccountId: rejected.accountId,
    rejectedGeneration: rejected.generation,
    current: toStoredCredential(current),
  });

  if (!decision.shouldMark) {
    return false;
  }

  await prisma.modelApiConfig.update({
    where: { id: configId },
    data: { needsReauth: true },
  });

  return true;
}
