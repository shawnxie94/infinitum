"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import {
  createModelApiConfig,
  createPromptConfig,
  deleteModelApiConfig,
  deletePromptConfig,
  fetchModelApiConfigModels,
  getModelApiConfig,
  testModelApiConfig,
  updateModelApiConfig,
  updatePromptConfig,
} from "@/components/admin/ai-settings-panel.api";
import { DailyReportTemplateEditor } from "@/components/admin/daily-report-template-editor";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  IconCopy,
  IconEdit,
  IconEye,
  IconList,
  IconLink,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@/components/ui/icons";
import { IconButton } from "@/components/ui/icon-button";
import { ModalShell } from "@/components/ui/modal-shell";
import { SectionToggleButton } from "@/components/ui/section-toggle-button";
import { SelectableButton } from "@/components/ui/selectable-button";
import { SelectField } from "@/components/ui/select-field";
import { StatusBanner } from "@/components/ui/status-banner";
import { StatusTag } from "@/components/ui/status-tag";
import { TextArea } from "@/components/ui/text-area";
import { TextInput } from "@/components/ui/text-input";
import { useToast } from "@/components/ui/toast";
import {
  PROMPT_TYPE_OPTIONS,
  getPromptTypeLabel,
} from "@/lib/settings/ai-config";
import {
  compileDailyReportTemplatePrompt,
  DAILY_REPORT_SYSTEM_ROLE_PROMPT,
  DEFAULT_DAILY_REPORT_TEMPLATE,
  DEFAULT_DAILY_REPORT_TEMPLATE_JSON,
  parseDailyReportTemplateJson,
  stringifyDailyReportTemplate,
} from "@/lib/daily-report/template";
import type {
  AdminModelApiConfig,
  AdminPromptConfig,
  AdminSettingsSnapshot,
  PromptConfigType,
} from "@/lib/settings/types";
import { cx } from "@/lib/ui/cx";

type AiSettingsPanelMode = "model-api" | "prompt";

type AiSettingsPanelProps = {
  initialSettings: AdminSettingsSnapshot;
  mode: AiSettingsPanelMode;
  initialPromptType?: PromptConfigType;
};

type HeaderEntry = { key: string; value: string };

type ModelFormState = {
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeyMode: "replace" | "clear" | "keep";
  modelName: string;
  ingestionItemConcurrency: string;
  customHeaders: HeaderEntry[];
  isEnabled: boolean;
  isDefault: boolean;
};

type PromptFormState = {
  name: string;
  type: PromptConfigType;
  prompt: string;
  systemPrompt: string;
  templateJson: string;
  temperature: string;
  maxTokens: string;
  topP: string;
  modelApiConfigId: string;
  isEnabled: boolean;
  isDefault: boolean;
};

type DeleteModalState =
  | { kind: "model"; id: string; name: string }
  | { kind: "prompt"; id: string; name: string }
  | null;

const surfaceCardClassName =
  "w-full min-w-0 rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-6 shadow-sm";
const itemCardClassName = "rounded-lg border border-[color:var(--line)] p-4 transition hover:shadow-md";
const labelClassName = "block text-sm text-[var(--text-2)]";
const codeClassName = "rounded bg-[var(--bg-muted)] px-2 py-1 text-xs";
const checkboxInputClassName =
  "h-4 w-4 rounded border-[color:var(--line)] text-[var(--accent)] focus:ring-[rgba(59,130,246,0.35)]";

const PROMPT_PLACEHOLDERS_BY_TYPE: Record<PromptConfigType, string[]> = {
  item_understanding: ["{{title}}", "{{sourceName}}", "{{translateTitle}}", "{{maxEvents}}", "{{inputText}}"],
  cluster_summary: ["{{title}}", "{{inputText}}"],
  cluster_match: ["{{title}}", "{{inputText}}", "{{candidatesJson}}"],
  cluster_merge: ["{{clustersJson}}"],
  daily_report: ["{{date}}", "{{timezone}}", "{{articlesJson}}", "{{recentTopicsJson}}"],
};

function toNullableNumber(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function buildEmptyModelForm(): ModelFormState {
  return {
    name: "",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    apiKeyMode: "replace",
    modelName: "gpt-4.1-mini",
    ingestionItemConcurrency: "3",
    customHeaders: [],
    isEnabled: true,
    isDefault: false,
  };
}

function buildCustomHeadersPayload(entries: HeaderEntry[]) {
  return Object.fromEntries(
    entries
      .filter((header) => header.key.trim())
      .map((header) => [header.key.trim(), header.value]),
  );
}

function maskHeaderValue(value: string) {
  return value ? "••••••••" : "空值";
}

function buildEmptyPromptForm(type: PromptConfigType): PromptFormState {
  const templateJson = type === "daily_report" ? DEFAULT_DAILY_REPORT_TEMPLATE_JSON : "";

  return {
    name: "",
    type,
    prompt: "",
    systemPrompt: type === "daily_report" ? compileDailyReportTemplatePrompt(DEFAULT_DAILY_REPORT_TEMPLATE) : "",
    templateJson,
    temperature: "",
    maxTokens: "",
    topP: "",
    modelApiConfigId: "",
    isEnabled: true,
    isDefault: false,
  };
}

function getPreviewSystemPrompt(config: AdminPromptConfig) {
  if (config.type !== "daily_report") {
    return config.systemPrompt || "未设置（必填）";
  }

  if (config.templateJson?.trim()) {
    try {
      const template = parseDailyReportTemplateJson(config.templateJson);
      if (template) return compileDailyReportTemplatePrompt(template);
    } catch {
      return config.systemPrompt || DAILY_REPORT_SYSTEM_ROLE_PROMPT;
    }
  }

  return config.systemPrompt || DAILY_REPORT_SYSTEM_ROLE_PROMPT;
}

async function writeClipboardText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy copy path below.
  }

  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.top = "-9999px";
  textArea.style.opacity = "0";

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textArea);
  }
}

function updatePromptTypeUrl(promptType: PromptConfigType) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  if (promptType === "item_understanding") {
    url.searchParams.delete("promptType");
  } else {
    url.searchParams.set("promptType", promptType);
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export function AiSettingsPanel({ initialSettings, mode, initialPromptType = "item_understanding" }: AiSettingsPanelProps) {
  const { showToast } = useToast();
  const [modelConfigs, setModelConfigs] = useState(initialSettings.modelApiConfigs);
  const [promptConfigs, setPromptConfigs] = useState(initialSettings.promptConfigs);
  const [selectedPromptType, setSelectedPromptType] = useState<PromptConfigType>(initialPromptType);

  const [showModelModal, setShowModelModal] = useState(false);
  const [editingModelConfig, setEditingModelConfig] = useState<AdminModelApiConfig | null>(null);
  const [editingModelApiKeyRaw, setEditingModelApiKeyRaw] = useState("");
  const [modelForm, setModelForm] = useState<ModelFormState>(buildEmptyModelForm);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelOptionsLoading, setModelOptionsLoading] = useState(false);
  const [modelOptionsError, setModelOptionsError] = useState("");
  const [modelNameManual, setModelNameManual] = useState(false);
  const [showModelTestModal, setShowModelTestModal] = useState(false);
  const [testingModelConfig, setTestingModelConfig] = useState<AdminModelApiConfig | null>(null);
  const [testPrompt, setTestPrompt] = useState("请回复：OK");
  const [testResult, setTestResult] = useState("");
  const [testRawResponse, setTestRawResponse] = useState("");
  const [testError, setTestError] = useState("");
  const [testLoading, setTestLoading] = useState(false);

  const [showPromptModal, setShowPromptModal] = useState(false);
  const [promptModalMode, setPromptModalMode] = useState<"create" | "edit" | "duplicate">("create");
  const [editingPromptConfig, setEditingPromptConfig] = useState<AdminPromptConfig | null>(null);
  const [promptForm, setPromptForm] = useState<PromptFormState>(buildEmptyPromptForm("item_understanding"));
  const [showPromptAdvanced, setShowPromptAdvanced] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [showPromptPreview, setShowPromptPreview] = useState<AdminPromptConfig | null>(null);
  const [deleteModalState, setDeleteModalState] = useState<DeleteModalState>(null);

  const filteredPromptConfigs = useMemo(() => {
    return promptConfigs.filter((config) => config.type === selectedPromptType);
  }, [promptConfigs, selectedPromptType]);

  const promptModelOptions = useMemo(() => {
    return modelConfigs
      .map((config) => ({
        value: config.id,
        label:
          `${config.name}${config.modelName !== config.name ? ` (${config.modelName})` : ""}` +
          (!config.isEnabled ? " · 已禁用" : ""),
      }))
      .sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"));
  }, [modelConfigs]);

  const defaultModelConfigName = useMemo(() => {
    return modelConfigs.find((config) => config.isDefault)?.name ?? "默认模型";
  }, [modelConfigs]);

  const promptSelectOptions = useMemo(
    () => [{ value: "", label: `${defaultModelConfigName}（默认）` }, ...promptModelOptions],
    [defaultModelConfigName, promptModelOptions],
  );

  const copyText = async (value: string, message = "已复制。") => {
    if (!value) {
      showToast("没有可复制的内容。", "error");
      return;
    }

    const copied = await writeClipboardText(value);
    showToast(copied ? message : "复制失败，请手动复制。", copied ? "success" : "error");
  };

  const openCreateModelModal = () => {
    setEditingModelConfig(null);
    setEditingModelApiKeyRaw("");
    setModelForm(buildEmptyModelForm());
    setModelOptions([]);
    setModelOptionsError("");
    setModelNameManual(false);
    setShowModelModal(true);
  };

  const openEditModelModal = async (config: AdminModelApiConfig) => {
    setEditingModelConfig(config);
    setEditingModelApiKeyRaw("");
    setModelForm({
      name: config.name,
      baseUrl: config.baseUrl,
      apiKey: config.apiKeyMasked || "",
      apiKeyMode: "keep",
      modelName: config.modelName,
      ingestionItemConcurrency: String(config.ingestionItemConcurrency),
      customHeaders: Object.entries(config.customHeaders ?? {}).map(([key, value]) => ({
        key,
        value,
      })),
      isEnabled: config.isEnabled,
      isDefault: config.isDefault,
    });
    setModelOptions([]);
    setModelOptionsError("");
    setModelNameManual(true);
    setShowModelModal(true);

    try {
      const detail = await getModelApiConfig(config.id);
      setEditingModelApiKeyRaw(detail.apiKeyRaw || "");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "读取模型配置详情失败", "error");
    }
  };

  const handleFetchModelOptions = async () => {
    if (!modelForm.baseUrl.trim()) {
      setModelOptionsError("请先填写 API 地址。");
      return;
    }

    setModelOptionsLoading(true);
    setModelOptionsError("");

    try {
      const payload = await fetchModelApiConfigModels({
        baseUrl: modelForm.baseUrl,
        apiKey:
          editingModelConfig && modelForm.apiKeyMode === "keep"
            ? ""
            : modelForm.apiKey,
        configId: editingModelConfig?.id,
        apiKeyMode: modelForm.apiKeyMode,
        customHeaders: buildCustomHeadersPayload(modelForm.customHeaders),
      });

      if (!payload.success) {
        setModelOptions([]);
        setModelOptionsError(payload.message ?? "获取模型失败");
        return;
      }

      setModelOptions(payload.models);
      if (payload.models.length === 0) {
        setModelOptionsError("没有可选模型，请手动输入模型名称。");
      }
    } catch (error) {
      setModelOptions([]);
      setModelOptionsError(error instanceof Error ? error.message : "获取模型失败");
    } finally {
      setModelOptionsLoading(false);
    }
  };

  const handleSaveModelConfig = async () => {
    const ingestionItemConcurrency = toNullableNumber(modelForm.ingestionItemConcurrency);

    if (Number.isNaN(ingestionItemConcurrency)) {
      showToast("请输入合法的数值字段。", "error");
      return;
    }

    setModelSaving(true);
    try {
      const customHeaders = buildCustomHeadersPayload(modelForm.customHeaders);

      const payload = {
        name: modelForm.name,
        baseUrl: modelForm.baseUrl,
        apiKey:
          editingModelConfig && modelForm.apiKeyMode === "keep"
            ? ""
            : modelForm.apiKey,
        apiKeyMode: modelForm.apiKeyMode,
        modelName: modelForm.modelName,
        ingestionItemConcurrency: Number(ingestionItemConcurrency),
        customHeaders,
        isEnabled: modelForm.isEnabled,
        isDefault: modelForm.isDefault,
      };

      const result = editingModelConfig
        ? await updateModelApiConfig(editingModelConfig.id, payload)
        : await createModelApiConfig(payload);

      setModelConfigs((current) => {
        const next = editingModelConfig
          ? current.map((config) => (config.id === result.config.id ? result.config : config))
          : [result.config, ...current];

        return next.map((config) =>
          result.config.isDefault
            ? { ...config, isDefault: config.id === result.config.id }
            : config,
        );
      });
      setPromptConfigs((current) =>
        current.map((config) =>
          config.modelApiConfigId === result.config.id
            ? { ...config, modelApiConfigName: result.config.name }
            : config,
        ),
      );
      setShowModelModal(false);
      showToast(editingModelConfig ? "模型配置已更新。" : "模型配置已创建。", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "保存失败", "error");
    } finally {
      setModelSaving(false);
    }
  };

  const handleDeleteModelConfig = async (configId: string) => {
    try {
      await deleteModelApiConfig(configId);
      setModelConfigs((current) => current.filter((item) => item.id !== configId));
      setPromptConfigs((current) =>
        current.map((item) =>
          item.modelApiConfigId === configId
            ? {
                ...item,
                modelApiConfigId: null,
                modelApiConfigName: null,
              }
            : item,
        ),
      );
      showToast("模型配置已删除。", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "删除失败", "error");
    }
  };

  const openModelTestModal = (config: AdminModelApiConfig) => {
    setTestingModelConfig(config);
    setTestPrompt("请回复：OK");
    setTestResult("");
    setTestRawResponse("");
    setTestError("");
    setShowModelTestModal(true);
  };

  const handleRunModelTest = async () => {
    if (!testingModelConfig) {
      return;
    }

    setTestLoading(true);
    setTestError("");
    setTestResult("");
    setTestRawResponse("");
    try {
      const result = await testModelApiConfig(testingModelConfig.id, testPrompt);
      if (!result.success) {
        setTestError(result.message || "调用失败");
      }
      setTestResult(result.content || "");
      setTestRawResponse(result.rawResponse || "");
    } catch (error) {
      setTestError(error instanceof Error ? error.message : "调用失败");
    } finally {
      setTestLoading(false);
    }
  };

  const openCreatePromptModal = () => {
    setEditingPromptConfig(null);
    setPromptModalMode("create");
    setPromptForm(buildEmptyPromptForm(selectedPromptType));
    setShowPromptAdvanced(false);
    setShowPromptModal(true);
  };

  const openEditPromptModal = (config: AdminPromptConfig) => {
    setEditingPromptConfig(config);
    setPromptModalMode("edit");
    setPromptForm({
      name: config.name,
      type: config.type,
      prompt: config.prompt,
      systemPrompt: config.systemPrompt ?? "",
      templateJson: config.templateJson ?? "",
      temperature: config.temperature == null ? "" : String(config.temperature),
      maxTokens: config.maxTokens == null ? "" : String(config.maxTokens),
      topP: config.topP == null ? "" : String(config.topP),
      // If using default model, set to empty string so "使用默认" is selected
      modelApiConfigId: config.isUsingDefaultModel ? "" : config.modelApiConfigId ?? "",
      isEnabled: config.isEnabled,
      isDefault: config.isDefault,
    });
    setShowPromptAdvanced(false);
    setShowPromptModal(true);
  };

  const openDuplicatePromptModal = (config: AdminPromptConfig) => {
    setEditingPromptConfig(null);
    setPromptModalMode("duplicate");
    setPromptForm({
      name: `${config.name} 副本`,
      type: config.type,
      prompt: config.prompt,
      systemPrompt: config.systemPrompt ?? "",
      templateJson: config.templateJson ?? "",
      temperature: config.temperature == null ? "" : String(config.temperature),
      maxTokens: config.maxTokens == null ? "" : String(config.maxTokens),
      topP: config.topP == null ? "" : String(config.topP),
      // If original uses default model, also use empty string (default)
      modelApiConfigId: config.isUsingDefaultModel ? "" : config.modelApiConfigId ?? "",
      isEnabled: config.isEnabled,
      isDefault: false,
    });
    setShowPromptAdvanced(false);
    setShowPromptModal(true);
  };

  const handleSavePromptConfig = async () => {
    const temperature = toNullableNumber(promptForm.temperature);
    const maxTokens = toNullableNumber(promptForm.maxTokens);
    const topP = toNullableNumber(promptForm.topP);

    if (
      Number.isNaN(temperature) ||
      Number.isNaN(maxTokens) ||
      Number.isNaN(topP)
    ) {
      showToast("请输入合法的数值字段。", "error");
      return;
    }

    setPromptSaving(true);
    try {
      let systemPrompt = promptForm.systemPrompt;
      let templateJson: string | null = null;

      if (promptForm.type === "daily_report" && promptForm.templateJson.trim()) {
        const template = parseDailyReportTemplateJson(promptForm.templateJson);
        if (!template) {
          showToast("请先配置日报模板。", "error");
          return;
        }
        templateJson = stringifyDailyReportTemplate(template);
        systemPrompt = compileDailyReportTemplatePrompt(template);
      }

      const payload = {
        name: promptForm.name,
        type: promptForm.type,
        prompt: promptForm.prompt,
        systemPrompt,
        templateJson,
        temperature,
        maxTokens,
        topP,
        modelApiConfigId: promptForm.modelApiConfigId || null,
        isEnabled: promptForm.isEnabled,
        isDefault: promptForm.isDefault,
      };

      const result = editingPromptConfig
        ? await updatePromptConfig(editingPromptConfig.id, payload)
        : await createPromptConfig(payload);

      setPromptConfigs((current) => {
        const next = editingPromptConfig
          ? current.map((config) => (config.id === result.config.id ? result.config : config))
          : [result.config, ...current];

        return next.map((config) =>
          result.config.isDefault && config.type === result.config.type
            ? { ...config, isDefault: config.id === result.config.id }
            : config,
        );
      });
      setShowPromptModal(false);
      showToast(editingPromptConfig ? "提示词配置已更新。" : "提示词配置已创建。", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "保存失败", "error");
    } finally {
      setPromptSaving(false);
    }
  };

  const handleDeletePromptConfig = async (configId: string) => {
    try {
      await deletePromptConfig(configId);
      setPromptConfigs((current) => current.filter((item) => item.id !== configId));
      showToast("提示词配置已删除。", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "删除失败", "error");
    }
  };

  if (mode === "model-api") {
    return (
      <section aria-label="模型 API 配置" className="space-y-4">
        <section className="w-full min-w-0 space-y-6">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold text-[var(--text-1)]">模型API配置</h2>
            </div>
            <Button onClick={openCreateModelModal} variant="primary">
              + 创建配置
            </Button>
          </div>

          {modelConfigs.length === 0 ? (
            <EmptyState
              action={
                <Button onClick={openCreateModelModal} variant="primary">
                  创建配置
                </Button>
              }
            >
              暂无模型配置
            </EmptyState>
          ) : (
            <div className="space-y-4">
              {[...modelConfigs]
                .sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
                .map((config) => (
                  <div key={config.id} className={itemCardClassName}>
                    <div className="mb-3 flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <h3 className="font-semibold text-[var(--text-1)]">{config.name}</h3>
                          {config.isDefault ? <StatusTag tone="info">默认</StatusTag> : null}
                          <StatusTag tone={config.isEnabled ? "success" : "neutral"}>
                            {config.isEnabled ? "启用" : "禁用"}
                          </StatusTag>
                        </div>

                        <div className="space-y-1 text-sm text-[var(--text-2)]">
                          <div>
                            <span className="font-medium">API地址：</span>
                            <code className={codeClassName}>{config.baseUrl}</code>
                          </div>
                          <div>
                            <span className="font-medium">模型名称：</span>
                            <code className={codeClassName}>{config.modelName}</code>
                          </div>
                          <div>
                            <span className="font-medium">抓取并发：</span>
                            <span>{config.ingestionItemConcurrency}</span>
                          </div>
                          <div>
                            <span className="font-medium">API密钥：</span>
                            <code className={codeClassName}>{config.apiKeyMasked || "未配置"}</code>
                          </div>
                          {Object.keys(config.customHeaders ?? {}).length > 0 ? (
                            <div>
                              <span className="font-medium">自定义请求头：</span>
                              {Object.entries(config.customHeaders ?? {}).map(([k, v]) => (
                                <code key={k} className={codeClassName}>
                                  {k}: {maskHeaderValue(v)}
                                </code>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex gap-1">
                        <IconButton
                          onClick={() => openModelTestModal(config)}
                          size="sm"
                          title="测试连接"
                          variant="secondary"
                        >
                          <IconLink className="h-4 w-4" />
                        </IconButton>
                        <IconButton
                          onClick={() => openEditModelModal(config)}
                          size="sm"
                          title="编辑"
                          variant="secondary"
                        >
                          <IconEdit className="h-4 w-4" />
                        </IconButton>
                        <IconButton
                          onClick={() =>
                            !config.isDefault &&
                            setDeleteModalState({
                              kind: "model",
                              id: config.id,
                              name: config.name,
                            })
                          }
                          size="sm"
                          title={config.isDefault ? "默认配置不可删除" : "删除"}
                          variant="secondary"
                          disabled={config.isDefault}
                        >
                          <IconTrash className="h-4 w-4" />
                        </IconButton>
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </section>

        <ModalShell
          isOpen={showModelModal}
          onClose={() => setShowModelModal(false)}
          title={editingModelConfig ? "编辑模型API配置" : "创建新模型API配置"}
          widthClassName="max-w-2xl"
          panelClassName="max-h-[90vh] overflow-y-auto"
          headerClassName="border-b border-[color:var(--line)] p-6"
          bodyClassName="space-y-5 p-6"
          footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
          footer={
            <div className="flex justify-end gap-2">
              <Button onClick={() => setShowModelModal(false)} variant="secondary">
                取消
              </Button>
              <Button
                onClick={handleSaveModelConfig}
                variant="primary"
                loading={modelSaving}
                disabled={modelSaving}
              >
                {editingModelConfig ? "保存" : "创建"}
              </Button>
            </div>
          }
        >
          <FormBlock label="配置名称" required>
            <TextInput
              value={modelForm.name}
              onChange={(event) =>
                setModelForm((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="默认模型配置"
            />
          </FormBlock>

          <FormBlock label="API地址（Base URL）" required>
            <TextInput
              value={modelForm.baseUrl}
              onChange={(event) =>
                setModelForm((current) => ({ ...current, baseUrl: event.target.value }))
              }
              placeholder="https://api.openai.com/v1"
            />
          </FormBlock>

          <FormBlock label="API密钥" required>
            <div className="flex flex-wrap items-center gap-2">
              <TextInput
                type={
                  editingModelConfig && modelForm.apiKeyMode === "keep"
                    ? "text"
                    : "password"
                }
                value={modelForm.apiKey}
                onFocus={() => {
                  if (
                    editingModelConfig &&
                    modelForm.apiKeyMode === "keep" &&
                    modelForm.apiKey === editingModelConfig.apiKeyMasked
                  ) {
                    setModelForm((current) => ({
                      ...current,
                      apiKey: "",
                    }));
                  }
                }}
                onBlur={() => {
                  if (
                    editingModelConfig &&
                    modelForm.apiKeyMode === "keep" &&
                    !modelForm.apiKey.trim()
                  ) {
                    setModelForm((current) => ({
                      ...current,
                      apiKey: editingModelConfig.apiKeyMasked || "",
                    }));
                  }
                }}
                onChange={(event) =>
                  setModelForm((current) => {
                    const nextValue = event.target.value;

                    if (editingModelConfig) {
                      if (!nextValue.trim()) {
                        return {
                          ...current,
                          apiKey: editingModelConfig.apiKeyMasked || "",
                          apiKeyMode: "keep",
                        };
                      }

                      return {
                        ...current,
                        apiKey: nextValue,
                        apiKeyMode:
                          nextValue === editingModelConfig.apiKeyMasked
                            ? "keep"
                            : "replace",
                      };
                    }

                    return {
                      ...current,
                      apiKey: nextValue,
                      apiKeyMode: "replace",
                    };
                  })
                }
                placeholder={
                  editingModelConfig ? "输入新 Key 将覆盖当前配置" : "sk-..."
                }
                className="flex-1"
              />
              {modelForm.apiKey ? (
                <IconButton
                  onClick={() =>
                    copyText(
                      editingModelConfig && modelForm.apiKeyMode === "keep"
                        ? editingModelApiKeyRaw
                        : modelForm.apiKey,
                      "API密钥已复制。",
                    )
                  }
                  title="复制"
                  variant="secondary"
                  size="md"
                  disabled={
                    Boolean(editingModelConfig) &&
                    modelForm.apiKeyMode === "keep" &&
                    !editingModelApiKeyRaw
                  }
                >
                  <IconCopy className="h-4 w-4" />
                </IconButton>
              ) : null}
            </div>
          </FormBlock>

          <FormBlock label="模型名称" required>
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  {modelNameManual ? (
                    <TextInput
                      className="w-full"
                      value={modelForm.modelName}
                      onChange={(event) =>
                        setModelForm((current) => ({
                          ...current,
                          modelName: event.target.value,
                        }))
                      }
                      placeholder="手动输入模型名称"
                    />
                  ) : (
                    <SelectField
                      value={modelForm.modelName}
                      onChange={(value) =>
                        setModelForm((current) => ({
                          ...current,
                          modelName: String(value),
                        }))
                      }
                      className="w-full"
                      placeholder="请选择模型"
                      loading={modelOptionsLoading}
                      options={modelOptions.map((item) => ({ value: item, label: item }))}
                    />
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <IconButton
                    onClick={() => setModelNameManual((current) => !current)}
                    title={modelNameManual ? "使用下拉选择" : "手动输入"}
                    variant="secondary"
                    size="md"
                  >
                    {modelNameManual ? (
                      <IconList className="h-4 w-4" />
                    ) : (
                      <IconEdit className="h-4 w-4" />
                    )}
                  </IconButton>
                  <IconButton
                    onClick={handleFetchModelOptions}
                    title="拉取模型"
                    variant="secondary"
                    size="md"
                    disabled={modelOptionsLoading}
                  >
                    <IconRefresh className={cx("h-4 w-4", modelOptionsLoading ? "animate-spin" : "")} />
                  </IconButton>
                </div>
              </div>
            </div>
            {modelOptionsError ? <p className="mt-2 text-xs text-[var(--danger-ink)]">{modelOptionsError}</p> : null}
          </FormBlock>

          <FormBlock label="抓取并发数" required>
            <TextInput
              aria-label="抓取并发数"
              type="number"
              min="1"
              max="10"
              value={modelForm.ingestionItemConcurrency}
              onChange={(event) =>
                setModelForm((current) => ({
                  ...current,
                  ingestionItemConcurrency: event.target.value,
                }))
              }
              placeholder="1 - 10"
            />
            <p className="text-xs text-[var(--text-3)]">
              当前配置被设为默认模型时，将使用这里的并发数作为抓取分析并发。
            </p>
          </FormBlock>

          <div className="space-y-2">
            <span className={labelClassName}>自定义请求头</span>
            <div className="space-y-2">
              {modelForm.customHeaders.map((entry, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <TextInput
                    aria-label={`请求头名称 ${index + 1}`}
                    placeholder="Header 名称"
                    value={entry.key}
                    onChange={(event) =>
                      setModelForm((current) => {
                        const next = [...current.customHeaders];
                        next[index] = { ...next[index], key: event.target.value };
                        return { ...current, customHeaders: next };
                      })
                    }
                    className="flex-1"
                  />
                  <TextInput
                    aria-label={`请求头值 ${index + 1}`}
                    placeholder="Header 值"
                    value={entry.value}
                    onChange={(event) =>
                      setModelForm((current) => {
                        const next = [...current.customHeaders];
                        next[index] = { ...next[index], value: event.target.value };
                        return { ...current, customHeaders: next };
                      })
                    }
                    className="flex-1"
                  />
                  <IconButton
                    onClick={() =>
                      setModelForm((current) => ({
                        ...current,
                        customHeaders: current.customHeaders.filter((_, i) => i !== index),
                      }))
                    }
                    variant="secondary"
                    size="sm"
                    title="删除请求头"
                    className="h-9 w-9"
                  >
                    <IconTrash className="h-4 w-4" />
                  </IconButton>
                </div>
              ))}
              <Button
                onClick={() =>
                  setModelForm((current) => ({
                    ...current,
                    customHeaders: [...current.customHeaders, { key: "", value: "" }],
                  }))
                }
                variant="secondary"
                size="sm"
                className="gap-1"
              >
                <IconPlus className="h-4 w-4" />
                添加请求头
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <label className="flex flex-wrap items-center gap-2">
              <input
                className={checkboxInputClassName}
                checked={modelForm.isEnabled}
                type="checkbox"
                onChange={(event) =>
                  setModelForm((current) => ({ ...current, isEnabled: event.target.checked }))
                }
              />
              <span className="text-sm text-[var(--text-2)]">启用此配置</span>
            </label>
            <label className="flex flex-wrap items-center gap-2">
              <input
                className={checkboxInputClassName}
                checked={modelForm.isDefault}
                type="checkbox"
                onChange={(event) =>
                  setModelForm((current) => ({ ...current, isDefault: event.target.checked }))
                }
              />
              <span className="text-sm text-[var(--text-2)]">设为默认配置</span>
            </label>
          </div>
        </ModalShell>

        <ModalShell
          isOpen={showModelTestModal}
          onClose={() => setShowModelTestModal(false)}
          title="模型连接测试"
          widthClassName="max-w-2xl"
          panelClassName="max-h-[90vh] overflow-y-auto"
          headerClassName="border-b border-[color:var(--line)] p-6"
          bodyClassName="space-y-4 p-6"
          footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
          footer={
            <div className="flex justify-end gap-2">
              <Button onClick={() => setShowModelTestModal(false)} variant="secondary">
                关闭
              </Button>
              <Button
                onClick={handleRunModelTest}
                variant="primary"
                loading={testLoading}
                disabled={testLoading}
              >
                开始测试
              </Button>
            </div>
          }
        >
          <FormBlock label="测试提示词">
            <TextArea
              className="min-h-[8rem] resize-y"
              rows={5}
              value={testPrompt}
              onChange={(event) => setTestPrompt(event.target.value)}
            />
          </FormBlock>
          {testError ? (
            <StatusBanner tone="error" className="rounded-sm px-4 py-3">
              {testError}
            </StatusBanner>
          ) : null}
          {testResult ? (
            <PreviewBlock
              title="解析结果"
              content={testResult}
              onCopy={() => copyText(testResult)}
            />
          ) : null}
          {testRawResponse ? (
            <PreviewBlock
              title="原始响应"
              content={testRawResponse}
              onCopy={() => copyText(testRawResponse)}
            />
          ) : null}
        </ModalShell>

        <ModalShell
          isOpen={Boolean(deleteModalState)}
          onClose={() => setDeleteModalState(null)}
          title="删除模型配置"
          widthClassName="max-w-md"
          headerClassName="border-b border-[color:var(--line)] p-6"
          bodyClassName="p-6"
          footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
          footer={
            <div className="flex justify-end gap-2">
              <Button onClick={() => setDeleteModalState(null)} variant="secondary">
                取消
              </Button>
              <Button
                onClick={async () => {
                  if (!deleteModalState || deleteModalState.kind !== "model") {
                    return;
                  }
                  const { id } = deleteModalState;
                  setDeleteModalState(null);
                  await handleDeleteModelConfig(id);
                }}
                variant="danger"
              >
                删除
              </Button>
            </div>
          }
        >
          <p className="text-sm leading-6 text-[var(--text-2)]">
            {deleteModalState?.kind === "model"
              ? `确定要删除「${deleteModalState.name}」吗？删除后不可恢复。`
              : ""}
          </p>
        </ModalShell>
      </section>
    );
  }

  return (
    <section aria-label="提示词配置" className="space-y-4">
      <section className="w-full min-w-0 space-y-6">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-[var(--text-1)]">提示词配置</h2>
          </div>
          <Button onClick={openCreatePromptModal} variant="primary">
            + 创建配置
          </Button>
        </div>

        <div className="mb-6 overflow-x-auto pb-1">
          <div className="flex min-w-max gap-2">
          {PROMPT_TYPE_OPTIONS.map((option) => (
            <SelectableButton
              key={option.value}
              onClick={() => {
                setSelectedPromptType(option.value);
                updatePromptTypeUrl(option.value);
              }}
              active={selectedPromptType === option.value}
              className="shrink-0 whitespace-nowrap"
              variant="pill"
            >
              {option.label}
            </SelectableButton>
          ))}
          </div>
        </div>

        {filteredPromptConfigs.length === 0 ? (
          <EmptyState
            action={
              <Button onClick={openCreatePromptModal} variant="primary">
                创建配置
              </Button>
            }
          >
            暂无{getPromptTypeLabel(selectedPromptType)}配置
          </EmptyState>
        ) : (
          <div className="space-y-4">
            {[...filteredPromptConfigs]
              .sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
              .map((config) => (
                <div key={config.id} className={itemCardClassName}>
                  <div className="mb-3 flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold text-[var(--text-1)]">{config.name}</h3>
                        {config.isDefault ? <StatusTag tone="info">默认</StatusTag> : null}
                        <StatusTag tone={config.isEnabled ? "success" : "neutral"}>
                          {config.isEnabled ? "启用" : "禁用"}
                        </StatusTag>
                      </div>

                      <div className="space-y-1 text-sm text-[var(--text-2)]">
                        {config.modelApiConfigName && !config.isUsingDefaultModel ? (
                          <div>
                            <span className="font-medium">关联模型API：</span>
                            <span>{config.modelApiConfigName}</span>
                          </div>
                        ) : null}
                        {config.type === "daily_report" ? (
                          <div>
                            <span className="font-medium">系统角色：</span>
                            <code className="mt-1 block max-h-20 overflow-y-auto rounded bg-[var(--bg-muted)] px-2 py-1 text-xs">
                              {DAILY_REPORT_SYSTEM_ROLE_PROMPT}
                            </code>
                          </div>
                        ) : config.systemPrompt ? (
                          <div>
                            <span className="font-medium">系统提示词：</span>
                            <code className="mt-1 block max-h-20 overflow-y-auto rounded bg-[var(--bg-muted)] px-2 py-1 text-xs">
                              {config.systemPrompt.length > 100
                                ? `${config.systemPrompt.slice(0, 100)}...`
                                : config.systemPrompt}
                            </code>
                          </div>
                        ) : null}
                        <div>
                          <span className="font-medium">提示词模板：</span>
                          <code className="mt-1 block max-h-20 overflow-y-auto rounded bg-[var(--bg-muted)] px-2 py-1 text-xs">
                            {config.prompt.length > 120 ? `${config.prompt.slice(0, 120)}...` : config.prompt}
                          </code>
                        </div>
                      </div>
                    </div>

                    <div className="flex gap-1">
                      <IconButton
                        onClick={() => setShowPromptPreview(config)}
                        size="sm"
                        title="预览"
                        variant="secondary"
                      >
                        <IconEye className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        onClick={() => openDuplicatePromptModal(config)}
                        size="sm"
                        title="复制"
                        variant="secondary"
                      >
                        <IconCopy className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        onClick={() => openEditPromptModal(config)}
                        size="sm"
                        title="编辑"
                        variant="secondary"
                      >
                        <IconEdit className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        onClick={() =>
                          !config.isDefault &&
                          setDeleteModalState({
                            kind: "prompt",
                            id: config.id,
                            name: config.name,
                          })
                        }
                        size="sm"
                        title={config.isDefault ? "默认配置不可删除" : "删除"}
                        variant="secondary"
                        disabled={config.isDefault}
                      >
                        <IconTrash className="h-4 w-4" />
                      </IconButton>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>

      <ModalShell
        isOpen={showPromptModal}
        onClose={() => setShowPromptModal(false)}
        title={
          promptModalMode === "edit"
            ? "编辑提示词配置"
            : promptModalMode === "duplicate"
              ? "复制提示词配置"
              : "创建新提示词配置"
        }
        widthClassName="max-w-2xl"
        panelClassName="max-h-[90vh] overflow-y-auto"
        headerClassName="border-b border-[color:var(--line)] p-6"
        bodyClassName="space-y-4 p-6"
        footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setShowPromptModal(false)} variant="secondary">
              取消
            </Button>
            <Button
              onClick={handleSavePromptConfig}
              variant="primary"
              loading={promptSaving}
              disabled={promptSaving}
            >
              {promptModalMode === "edit" ? "保存" : "创建"}
            </Button>
          </div>
        }
      >
        <FormBlock label="配置名称" required>
          <TextInput
            value={promptForm.name}
            onChange={(event) =>
              setPromptForm((current) => ({ ...current, name: event.target.value }))
            }
            placeholder="默认内容分析提示词"
          />
        </FormBlock>

        <FormBlock label={promptForm.type === "daily_report" ? "系统角色" : "系统提示词"} required>
          <TextArea
            className="min-h-[5rem] resize-y"
            rows={promptForm.type === "daily_report" ? 3 : 4}
            value={promptForm.type === "daily_report" ? DAILY_REPORT_SYSTEM_ROLE_PROMPT : promptForm.systemPrompt}
            readOnly={promptForm.type === "daily_report"}
            onChange={(event) =>
              setPromptForm((current) => ({
                ...current,
                systemPrompt: event.target.value,
              }))
            }
          />
        </FormBlock>

        {promptForm.type === "daily_report" ? (
          <div className="space-y-2">
            <span className={labelClassName}>
              日报输出结构<span className="text-[var(--danger-ink)]"> *</span>
            </span>
            <DailyReportTemplateEditor
              key={`${promptModalMode}-${editingPromptConfig?.id ?? "new"}`}
              value={promptForm.templateJson}
              onChange={(next) =>
                setPromptForm((current) => ({
                  ...current,
                  templateJson: next.templateJson,
                  systemPrompt: next.systemPrompt,
                }))
              }
              onError={(message) => showToast(message, "error")}
            />
          </div>
        ) : null}

        <FormBlock label="提示词模板" required>
          <TextArea
            className="min-h-[8rem] resize-y"
            rows={6}
            value={promptForm.prompt}
            onChange={(event) =>
              setPromptForm((current) => ({
                ...current,
                prompt: event.target.value,
              }))
            }
          />
          <p className="text-xs text-[var(--text-3)]">
            可使用占位符：{" "}
            {PROMPT_PLACEHOLDERS_BY_TYPE[promptForm.type].join(" / ")}
          </p>
        </FormBlock>

        <FormBlock label="关联模型API配置（可选）">
          <SelectField
            value={promptForm.modelApiConfigId}
            onChange={(value) =>
              setPromptForm((current) => ({
                ...current,
                modelApiConfigId: String(value ?? ""),
              }))
            }
            className="w-full"
            options={promptSelectOptions}
          />
        </FormBlock>

        <div className="rounded-lg border border-[color:var(--line)]">
          <SectionToggleButton
            label="高级设置（可选）"
            expanded={showPromptAdvanced}
            onToggle={() => setShowPromptAdvanced((current) => !current)}
            expandedIndicator="收起"
            collapsedIndicator="展开"
          />
          {showPromptAdvanced ? (
            <div className="space-y-4 border-t border-[color:var(--line)] p-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormBlock label="温度">
                  <TextInput
                    type="number"
                    step="0.1"
                    value={promptForm.temperature}
                    onChange={(event) =>
                      setPromptForm((current) => ({
                        ...current,
                        temperature: event.target.value,
                      }))
                    }
                  />
                </FormBlock>
                <FormBlock label="最大 Tokens">
                  <TextInput
                    type="number"
                    value={promptForm.maxTokens}
                    onChange={(event) =>
                      setPromptForm((current) => ({
                        ...current,
                        maxTokens: event.target.value,
                      }))
                    }
                  />
                </FormBlock>
                <FormBlock label="Top P">
                  <TextInput
                    type="number"
                    step="0.1"
                    value={promptForm.topP}
                    onChange={(event) =>
                      setPromptForm((current) => ({
                        ...current,
                        topP: event.target.value,
                      }))
                    }
                  />
                </FormBlock>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-4">
          <label className="flex flex-wrap items-center gap-2">
            <input
              className={checkboxInputClassName}
              checked={promptForm.isEnabled}
              type="checkbox"
              onChange={(event) =>
                setPromptForm((current) => ({ ...current, isEnabled: event.target.checked }))
              }
            />
            <span className="text-sm text-[var(--text-2)]">启用此配置</span>
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <input
              className={checkboxInputClassName}
              checked={promptForm.isDefault}
              type="checkbox"
              onChange={(event) =>
                setPromptForm((current) => ({ ...current, isDefault: event.target.checked }))
              }
            />
            <span className="text-sm text-[var(--text-2)]">设为默认配置</span>
          </label>
        </div>
      </ModalShell>

      <ModalShell
        isOpen={Boolean(showPromptPreview)}
        onClose={() => setShowPromptPreview(null)}
        title={showPromptPreview ? `提示词预览 - ${showPromptPreview.name}` : "提示词预览"}
        widthClassName="max-w-2xl"
        panelClassName="max-h-[90vh] overflow-y-auto"
        headerClassName="border-b border-[color:var(--line)] p-6"
        bodyClassName="space-y-4 p-6"
        footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
        footer={
          showPromptPreview ? (
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  openDuplicatePromptModal(showPromptPreview);
                  setShowPromptPreview(null);
                }}
                variant="secondary"
              >
                复制为新配置
              </Button>
              <Button
                onClick={() => {
                  openEditPromptModal(showPromptPreview);
                  setShowPromptPreview(null);
                }}
                variant="primary"
              >
                编辑此配置
              </Button>
              <Button onClick={() => setShowPromptPreview(null)} variant="secondary">
                关闭
              </Button>
            </div>
          ) : null
        }
      >
        {showPromptPreview ? (
          <>
            <div className="flex flex-wrap gap-2">
              <StatusTag tone="info">
                {getPromptTypeLabel(showPromptPreview.type)}
              </StatusTag>
              {showPromptPreview.modelApiConfigName ? (
                <StatusTag tone="info">
                  模型: {showPromptPreview.modelApiConfigName}
                  {showPromptPreview.isUsingDefaultModel ? " (默认)" : ""}
                </StatusTag>
              ) : null}
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-[var(--text-2)]">系统提示词</label>
              <pre className="w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg border border-[color:var(--line)] bg-[var(--bg-muted)] p-4 text-sm font-mono text-[var(--text-1)]">
                {getPreviewSystemPrompt(showPromptPreview)}
              </pre>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-[var(--text-2)]">提示词</label>
              <pre className="w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg border border-[color:var(--line)] bg-[var(--bg-muted)] p-4 text-sm font-mono text-[var(--text-1)]">
                {showPromptPreview.prompt}
              </pre>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-[color:var(--line)] bg-[var(--bg-muted)] p-3 text-sm text-[var(--text-2)]">
                <div className="text-xs text-[var(--text-3)]">温度</div>
                <div>{showPromptPreview.temperature ?? "默认"}</div>
              </div>
              <div className="rounded-lg border border-[color:var(--line)] bg-[var(--bg-muted)] p-3 text-sm text-[var(--text-2)]">
                <div className="text-xs text-[var(--text-3)]">最大 Tokens</div>
                <div>{showPromptPreview.maxTokens ?? "默认"}</div>
              </div>
              <div className="rounded-lg border border-[color:var(--line)] bg-[var(--bg-muted)] p-3 text-sm text-[var(--text-2)]">
                <div className="text-xs text-[var(--text-3)]">Top P</div>
                <div>{showPromptPreview.topP ?? "默认"}</div>
              </div>
            </div>
          </>
        ) : null}
      </ModalShell>

      <ModalShell
        isOpen={Boolean(deleteModalState)}
        onClose={() => setDeleteModalState(null)}
        title="删除提示词配置"
        widthClassName="max-w-md"
        headerClassName="border-b border-[color:var(--line)] p-6"
        bodyClassName="p-6"
        footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDeleteModalState(null)} variant="secondary">
              取消
            </Button>
            <Button
              onClick={async () => {
                if (!deleteModalState) {
                  return;
                }

                const { kind, id } = deleteModalState;
                setDeleteModalState(null);
                if (kind === "model") {
                  return;
                }
                await handleDeletePromptConfig(id);
              }}
              variant="danger"
            >
              删除
            </Button>
          </div>
        }
        >
        <p className="text-sm leading-6 text-[var(--text-2)]">
          {deleteModalState?.kind === "prompt"
              ? `确定要删除「${deleteModalState.name}」吗？删除后不可恢复。`
            : ""}
        </p>
      </ModalShell>
    </section>
  );
}

function FormBlock({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className={labelClassName}>
        {label}
        {required ? <span className="text-[var(--danger-ink)]"> *</span> : null}
      </span>
      {children}
    </label>
  );
}

function PreviewBlock({
  title,
  content,
  onCopy,
}: {
  title: string;
  content: string;
  onCopy: () => void;
}) {
  return (
    <section className={cx(surfaceCardClassName, "space-y-3 p-4")}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--foreground)]">{title}</h3>
        <IconButton onClick={onCopy} title="复制" variant="secondary" size="sm">
          <IconCopy className="h-4 w-4" />
        </IconButton>
      </div>
      <pre className="overflow-auto whitespace-pre-wrap rounded-[0.9rem] bg-[var(--surface-muted)] px-3 py-3 text-xs leading-6 text-[var(--foreground)]">
        {content}
      </pre>
    </section>
  );
}
