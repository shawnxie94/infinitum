"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchOrcaRouterModels } from "@/components/admin/ai-settings-panel.api";
import { InputModalitySelect } from "@/components/admin/orcarouter-auth-panel";
import { IconRefresh } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { SelectField } from "@/components/ui/select-field";
import type { OrcaRouterModelOption } from "@/lib/settings/types";

export type OrcaRouterModelFieldProps = {
  configId: string | null;
  /** Currently selected model id. */
  value: string;
  onChange: (modelId: string) => void;
  /** The entry point's required input modality: `text`, or `image` for multimodal. */
  inputModality: string;
  onInputModalityChange: (modality: string) => void;
};

/**
 * Model selector bound to the live OrcaRouter catalog.
 *
 * When OrcaRouter is the provider the model is always chosen from the real
 * catalog — never typed freely — and the option list is filtered by the entry
 * point's capability. Multimodal filtering is fail-closed: switching to
 * `文本 + 图片` re-queries `?capability=chat` with `input_modalities=image`, and
 * a text-only model that is no longer compatible is cleared rather than kept.
 */
export function OrcaRouterModelField({
  configId,
  value,
  onChange,
  inputModality,
  onInputModalityChange,
}: OrcaRouterModelFieldProps) {
  const [options, setOptions] = useState<OrcaRouterModelOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [degraded, setDegraded] = useState(false);
  const [source, setSource] = useState<"live" | "seed">("seed");

  // Latest values, so `load` can stay stable: a changing `onChange` identity
  // must not retrigger the catalog request on every render.
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  valueRef.current = value;
  onChangeRef.current = onChange;

  const load = useCallback(async () => {
    if (!configId) {
      setOptions([]);
      setError("请先保存配置，再选择模型。");
      return;
    }

    // Derived here so the callback's dependencies stay accurate: changing the
    // input modality must re-query the catalog with the new modality filter.
    const requiredInputModalities = inputModality === "image" ? ["image"] : [];

    setLoading(true);
    setError("");

    try {
      const payload = await fetchOrcaRouterModels({
        configId,
        capability: "chat",
        requiredInputModalities: requiredInputModalities.length > 0 ? requiredInputModalities : undefined,
      });

      setOptions(payload.models);
      setSource(payload.source);
      setDegraded(payload.degraded);

      if (payload.degraded) {
        setError(payload.error ?? "模型目录暂不可用，已使用已验证的回退列表。");
      } else if (payload.models.length === 0) {
        setError("没有兼容当前能力的模型。");
      }

      // A live catalog is authoritative: a model that no longer matches the
      // current capability filter is cleared instead of silently retained.
      if (valueRef.current && !payload.models.some((model) => model.id === valueRef.current)) {
        onChangeRef.current("");
        setError((current) => current || "已选模型不再兼容当前输入模态，请重新选择。");
      }
    } catch (caught) {
      setOptions([]);
      setDegraded(true);
      setError(caught instanceof Error ? caught.message : "获取模型失败");
    } finally {
      setLoading(false);
    }
  }, [configId, inputModality]);

  useEffect(() => {
    void load();
    // Recalculates whenever the provider, config, or required modality changes.
  }, [load]);

  return (
    <div className="space-y-2" data-testid="orcarouter-model-field">
      <SelectField
        aria-label="模型名称"
        value={value || undefined}
        onChange={(next) => onChange(String(next))}
        className="w-full"
        showSearch
        optionFilterProp="label"
        placeholder="请选择模型"
        loading={loading}
        notFoundContent={loading ? "加载中…" : "没有兼容的模型"}
        options={options.map((model) => ({
          value: model.id,
          label: model.name ? `${model.id} · ${model.name}` : model.id,
        }))}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[180px] flex-1">
          <InputModalitySelect
            ariaLabel="输入模态"
            value={inputModality}
            onChange={onInputModalityChange}
          />
        </div>
        <IconButton
          onClick={() => {
            void load();
          }}
          title="刷新模型列表"
          variant="secondary"
          size="md"
          disabled={loading}
        >
          <IconRefresh className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </IconButton>
        <span className="text-xs text-[var(--muted)]">
          {source === "live" ? `实时目录 · ${options.length} 个模型` : `回退目录 · ${options.length} 个模型`}
        </span>
      </div>

      {error ? (
        <p
          className={`text-xs ${degraded ? "text-[var(--warning-ink)]" : "text-[var(--danger-ink)]"}`}
          data-testid="orcarouter-model-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
