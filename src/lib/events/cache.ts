type EventBriefingCacheEntry = {
  expiresAt: number;
  value: unknown;
};

declare global {
  var __infinitumEventBriefingCache__: Map<string, EventBriefingCacheEntry> | undefined;
  var __infinitumEventBriefingCacheInFlight__: Map<string, Promise<unknown>> | undefined;
}

const MAX_EVENT_BRIEFING_CACHE_ENTRIES = 120;
const DEFAULT_EVENT_BRIEFING_CACHE_TTL_MS = 120_000;

function getEventBriefingCacheStore() {
  globalThis.__infinitumEventBriefingCache__ ??= new Map<string, EventBriefingCacheEntry>();
  return globalThis.__infinitumEventBriefingCache__;
}

function getEventBriefingInFlightStore() {
  globalThis.__infinitumEventBriefingCacheInFlight__ ??= new Map<string, Promise<unknown>>();
  return globalThis.__infinitumEventBriefingCacheInFlight__;
}

function isEventBriefingCacheEnabled() {
  return process.env.NODE_ENV !== "test";
}

function pruneEventBriefingCacheEntries(store: Map<string, EventBriefingCacheEntry>) {
  while (store.size > MAX_EVENT_BRIEFING_CACHE_ENTRIES) {
    const oldestKey = store.keys().next().value;

    if (!oldestKey) {
      return;
    }

    store.delete(oldestKey);
  }
}

export async function withEventBriefingCache<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs = DEFAULT_EVENT_BRIEFING_CACHE_TTL_MS,
): Promise<T> {
  if (!isEventBriefingCacheEnabled()) {
    return loader();
  }

  const cacheStore = getEventBriefingCacheStore();
  const inFlightStore = getEventBriefingInFlightStore();
  const cachedEntry = cacheStore.get(key);

  if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
    cacheStore.delete(key);
    cacheStore.set(key, cachedEntry);
    return cachedEntry.value as T;
  }

  if (cachedEntry) {
    cacheStore.delete(key);
  }

  const inFlight = inFlightStore.get(key);

  if (inFlight) {
    return inFlight as Promise<T>;
  }

  const nextValue = loader()
    .then((value) => {
      cacheStore.set(key, {
        expiresAt: Date.now() + ttlMs,
        value,
      });
      pruneEventBriefingCacheEntries(cacheStore);
      return value;
    })
    .finally(() => {
      inFlightStore.delete(key);
    });

  inFlightStore.set(key, nextValue as Promise<unknown>);
  return nextValue;
}

export function invalidateEventBriefingCache() {
  getEventBriefingCacheStore().clear();
  getEventBriefingInFlightStore().clear();
}
