"use client";

import { useEffect, useState } from "react";

/**
 * 前端动态事件类型标签：拉一次公开注册表（含停用类型，historical 保持配置 label）；
 * 未命中（未注册 key）回退存储 key 本身。
 */
export function useEventTypeLabels() {
  const [labels, setLabels] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;

    fetch("/api/event-types")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { eventTypes?: Array<{ key: string; label: string }> } | null) => {
        if (!cancelled && payload?.eventTypes) {
          setLabels(new Map(payload.eventTypes.map((type) => [type.key, type.label])));
        }
      })
      .catch(() => {
        // 展示增强失败静默回退 key。
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (key: string | null | undefined) =>
    key ? labels.get(key) ?? key : null;
}
