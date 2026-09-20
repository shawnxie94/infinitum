"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelOrcaRouterConnect,
  completeOrcaRouterConnect,
  startOrcaRouterConnect,
} from "@/components/admin/ai-settings-panel.api";
import { Button } from "@/components/ui/button";
import { IconCopy } from "@/components/ui/icons";
import { SelectField } from "@/components/ui/select-field";
import { StatusTag } from "@/components/ui/status-tag";
import { TextInput } from "@/components/ui/text-input";
import type { OrcaRouterConnectSessionView } from "@/lib/settings/types";

const CONNECT_ENDPOINT = "/api/admin/settings/orcarouter/connect";

type AuthChoice = "api-key" | "pkce";

export type OrcaRouterAuthPanelProps = {
  /** The persisted model API config. Connect needs a row to store the key on. */
  configId: string | null;
  /** Current credential lifecycle state of the config. */
  authMethod: AuthChoice;
  needsReauth: boolean;
  hasApiKey: boolean;
  oauthAccountId: string;
  oauthScope: string;
  /** API-key entry binding — the same field the generic form already uses. */
  apiKeyValue: string;
  onApiKeyChange: (value: string) => void;
  /** Called after a successful connect so the parent can refresh its state. */
  onConnected: (accountId: string | null, scope: string | null) => void;
};

function idleSession(): OrcaRouterConnectSessionView {
  return {
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
 * The two OrcaRouter authentication choices, shown side by side.
 *
 *  - `OrcaRouter - API`  paste an `sk-orca-…` key (works with no browser).
 *  - `OrcaRouter - Auth` sign in with an OrcaRouter account (OAuth 2.0 + PKCE,
 *    Flow B out-of-band code, because a self-hosted install has no predictable
 *    address a redirect could return to).
 *
 * Both produce one durable OrcaRouter API key. The verifier stays server-side
 * and is never part of any response rendered here.
 */
export function OrcaRouterAuthPanel({
  configId,
  authMethod,
  needsReauth,
  hasApiKey,
  oauthAccountId,
  oauthScope,
  apiKeyValue,
  onApiKeyChange,
  onConnected,
}: OrcaRouterAuthPanelProps) {
  const [session, setSession] = useState<OrcaRouterConnectSessionView>(idleSession);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");

  /** Monotonic generation. Stale responses may never touch current state. */
  const generationRef = useRef(0);
  const configIdRef = useRef<string | null>(configId);
  configIdRef.current = configId;

  const cancelServerSide = useCallback((keepalive: boolean) => {
    const id = configIdRef.current;
    if (!id) {
      return;
    }

    // `pagehide` teardown must never throw: an exception here would mask the
    // state clearing that already happened synchronously above.
    void Promise.resolve(
      fetch(CONNECT_ENDPOINT, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configId: id }),
        keepalive,
      }),
    ).catch(() => {
      // Cancellation is best-effort on teardown paths.
    });
  }, []);

  /**
   * `pagehide` needs its own handling: a back-forward-cache restore keeps the
   * component mounted, so an invalidated request's guarded `finally` would
   * refuse to clear state and leave the panel permanently busy.
   */
  useEffect(() => {
    const handlePageHide = () => {
      generationRef.current += 1;
      setBusy(false);
      setMessage("");
      setCode("");
      setSession(idleSession());
      cancelServerSide(true);
    };

    const handleUnmount = () => {
      generationRef.current += 1;
      cancelServerSide(false);
    };

    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      handleUnmount();
    };
  }, [cancelServerSide]);

  const handleStart = async () => {
    if (!configId) {
      setMessage("请先保存配置，再使用 OrcaRouter 账号登录。");
      return;
    }

    generationRef.current += 1;
    const generation = generationRef.current;

    setBusy(true);
    setMessage("");
    setCode("");

    try {
      const payload = await startOrcaRouterConnect({
        configId,
        callbackMode: "out-of-band",
      });

      if (generationRef.current !== generation) {
        return;
      }

      setSession(payload.session);
      setMessage("已在浏览器打开授权页，请把页面上显示的授权码粘贴到下方。");
    } catch (error) {
      if (generationRef.current !== generation) {
        return;
      }
      setMessage(error instanceof Error ? error.message : "发起授权失败。");
    } finally {
      if (generationRef.current === generation) {
        setBusy(false);
      }
    }
  };

  const handleComplete = async () => {
    if (!configId || !code.trim()) {
      return;
    }

    generationRef.current += 1;
    const generation = generationRef.current;
    const attemptGeneration = session.generation;

    setBusy(true);
    setMessage("");

    try {
      const payload = await completeOrcaRouterConnect({
        configId,
        generation: attemptGeneration,
        code: code.trim(),
      });

      if (generationRef.current !== generation) {
        return;
      }

      setSession(payload.session);

      if (payload.success) {
        setCode("");
        setMessage("已连接 OrcaRouter 账号，密钥已保存。");
        onConnected(payload.session.accountId, payload.session.grantedScope);
      } else {
        setMessage(payload.error ?? payload.session.error ?? "授权失败。");
      }
    } catch (error) {
      if (generationRef.current !== generation) {
        return;
      }
      setMessage(error instanceof Error ? error.message : "授权失败。");
    } finally {
      if (generationRef.current === generation) {
        setBusy(false);
      }
    }
  };

  const handleCancel = async () => {
    generationRef.current += 1;
    setBusy(false);
    setCode("");
    setMessage("");
    setSession(idleSession());

    if (configId) {
      try {
        const payload = await cancelOrcaRouterConnect(configId);
        setSession(payload.session);
      } catch {
        // The lock is released server-side on the next start regardless.
      }
    }
  };

  const pending = session.status === "pending" && Boolean(session.authorizeUrl);

  return (
    <div className="space-y-3" data-testid="orcarouter-auth-methods">
      <div className="flex flex-wrap items-center gap-2">
        <StatusTag tone={needsReauth ? "danger" : authMethod === "pkce" ? "info" : "neutral"}>
          {needsReauth
            ? "需要重新登录"
            : authMethod === "pkce"
              ? "OrcaRouter - Auth"
              : "OrcaRouter - API"}
        </StatusTag>
        {oauthAccountId && !needsReauth ? (
          <span className="text-xs text-[var(--muted)]">账号 {oauthAccountId}</span>
        ) : null}
        {oauthScope && !needsReauth ? (
          <span className="text-xs text-[var(--muted)]">scope {oauthScope}</span>
        ) : null}
      </div>

      {needsReauth ? (
        <p className="text-xs text-[var(--danger-ink)]">
          该账号的密钥已被撤销。请重新登录，或在下方填入新的 API Key。
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2 rounded-sm border border-[color:var(--line)] p-3">
          <div className="text-xs font-medium text-[var(--foreground)]">API Key</div>
          <TextInput
            aria-label="OrcaRouter API Key"
            type="password"
            autoComplete="off"
            value={apiKeyValue}
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder={hasApiKey ? "已保存，留空则保持不变" : "sk-orca-…"}
          />
          <p className="text-xs text-[var(--muted)]">
            无浏览器环境可直接使用。也可通过 <code>ORCAROUTER_API_KEY</code> 提供。
          </p>
        </div>

        <div className="space-y-2 rounded-sm border border-[color:var(--line)] p-3">
          <div className="text-xs font-medium text-[var(--foreground)]">
            使用 OrcaRouter 账号登录
          </div>

          {pending ? (
            <div className="space-y-2">
              <TextInput
                aria-label="OrcaRouter 授权页地址"
                readOnly
                value={session.authorizeUrl}
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(session.authorizeUrl);
                  }}
                >
                  <IconCopy className="h-4 w-4" />
                  复制授权链接
                </Button>
              </div>
              <TextInput
                aria-label="OrcaRouter 授权码"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="粘贴授权页显示的授权码"
              />
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <Button
              variant={pending ? "primary" : "secondary"}
              size="sm"
              loading={busy}
              disabled={busy || !configId}
              onClick={() => {
                void (pending ? handleComplete() : handleStart());
              }}
            >
              {pending ? "完成连接" : "Connect with OrcaRouter"}
            </Button>
            {pending || session.status !== "idle" ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy && pending}
                onClick={() => {
                  void handleCancel();
                }}
              >
                取消
              </Button>
            ) : null}
          </div>

          {!configId ? (
            <p className="text-xs text-[var(--muted)]">请先保存配置后再登录。</p>
          ) : null}
        </div>
      </div>

      {message ? <p className="text-xs text-[var(--muted)]">{message}</p> : null}
      {session.error && !message ? (
        <p className="text-xs text-[var(--danger-ink)]">{session.error}</p>
      ) : null}
    </div>
  );
}

/** Modal-free select used by tests and by the model form to pick a modality. */
export function InputModalitySelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <SelectField
      aria-label={ariaLabel}
      value={value}
      onChange={(next) => onChange(String(next))}
      className="w-full"
      options={[
        { value: "text", label: "文本" },
        { value: "image", label: "文本 + 图片" },
      ]}
    />
  );
}
