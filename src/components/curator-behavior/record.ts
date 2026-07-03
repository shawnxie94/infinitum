import type {
  CuratorBehaviorEntryType,
  CuratorBehaviorEventType,
  CuratorBehaviorTargetType,
} from "@/lib/curator-behavior/service";

type ClientCuratorBehaviorInput = {
  eventType: CuratorBehaviorEventType;
  targetType: CuratorBehaviorTargetType;
  targetId: string;
  entryType?: CuratorBehaviorEntryType | null;
  entryId?: string | null;
  itemId?: string | null;
  clusterId?: string | null;
  metadata?: Record<string, unknown>;
};

export function recordCuratorBehaviorClient(input: ClientCuratorBehaviorInput) {
  if (!input.targetId) {
    return;
  }

  fetch("/api/admin/curator-behavior", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).catch(() => {
    // Public visitors are expected to get ignored by the admin-only endpoint.
  });
}
