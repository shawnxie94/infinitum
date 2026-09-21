export type SingleFlightLease = {
  kind: string;
  taskRunId: string;
  acquiredAt: number;
};

export type SingleFlightStore = {
  acquire(kind: string, taskRunId: string): Promise<boolean>;
  release(kind: string, taskRunId: string): Promise<void>;
  reconcile(kind?: string): Promise<number>;
};

/**
 * Adapter contract for DB-backed single-flight. The implementation deliberately
 * lives in the host application because the framework package must not import
 * Prisma or know the business schema.
 */
export function createSingleFlight(store: SingleFlightStore) {
  return {
    acquire: (kind: string, taskRunId: string) => store.acquire(kind, taskRunId),
    release: (kind: string, taskRunId: string) => store.release(kind, taskRunId),
    reconcile: (kind?: string) => store.reconcile(kind),
  };
}

/** In-memory implementation for unit tests and single-process tools. */
export function createMemorySingleFlight(): SingleFlightStore {
  const leases = new Map<string, SingleFlightLease>();
  return {
    async acquire(kind, taskRunId) {
      if (leases.has(kind)) return false;
      leases.set(kind, { kind, taskRunId, acquiredAt: Date.now() });
      return true;
    },
    async release(kind, taskRunId) {
      if (leases.get(kind)?.taskRunId === taskRunId) leases.delete(kind);
    },
    async reconcile(kind) {
      if (kind) {
        const existed = leases.delete(kind);
        return existed ? 1 : 0;
      }
      const count = leases.size;
      leases.clear();
      return count;
    },
  };
}
