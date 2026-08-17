import type {
  DailyReportDetailDTO,
  DailyReportRevisionDetailDTO,
  DailyReportRevisionListItemDTO,
} from "@/lib/daily-report/types";

type ApiResult<T> = {
  ok: boolean;
  status: number;
  data: T;
};

type TaskRunPayload = {
  taskRun?: { id: string } | null;
  error?: string;
};

async function requestJsonWithMeta<T>(input: RequestInfo | URL, init?: RequestInit): Promise<ApiResult<T>> {
  const response = await fetch(input, init);
  return {
    ok: response.ok,
    status: response.status,
    data: (await response.json()) as T,
  };
}

export function requestDailyReportGeneration(date: string) {
  return requestJsonWithMeta<TaskRunPayload>("/api/admin/daily-reports/generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ date }),
  });
}

export function publishDailyReport(date: string) {
  return requestJsonWithMeta<{ error?: string }>(`/api/admin/daily-reports/${date}/publish`, {
    method: "POST",
  });
}

export function unpublishDailyReport(date: string) {
  return requestJsonWithMeta<{ error?: string }>(`/api/admin/daily-reports/${date}/unpublish`, {
    method: "POST",
  });
}

export function deleteDailyReport(date: string) {
  return requestJsonWithMeta<{ deleted?: boolean; error?: string }>(`/api/admin/daily-reports/${date}`, {
    method: "DELETE",
  });
}

export function getAdminDailyReportDetail(date: string) {
  return requestJsonWithMeta<{ report?: DailyReportDetailDTO | null; error?: string }>(
    `/api/admin/daily-reports/${date}`,
  );
}

export function getDailyReportRevisions(date: string) {
  return requestJsonWithMeta<{ revisions?: DailyReportRevisionListItemDTO[]; error?: string }>(
    `/api/admin/daily-reports/${date}/revisions`,
  );
}

export function getDailyReportRevision(date: string, revisionId: string) {
  return requestJsonWithMeta<{ revision?: DailyReportRevisionDetailDTO | null; error?: string }>(
    `/api/admin/daily-reports/${date}/revisions/${revisionId}`,
  );
}

export function restoreDailyReportRevision(date: string, revisionId: string) {
  return requestJsonWithMeta<{ revision?: unknown; error?: string }>(
    `/api/admin/daily-reports/${date}/revisions/${revisionId}/restore`,
    { method: "POST" },
  );
}
