import { DEFAULT_FEED_CACHE_TTL_MS } from "@/config/constants";

type FeedCacheEntry = {
  expiresAt: number;
  value: unknown;
};

declare global {
  var __infinitumFeedCache__: Map<string, FeedCacheEntry> | undefined;
  var __infinitumFeedCacheInFlight__: Map<string, Promise<unknown>> | undefined;
}

const MAX_FEED_CACHE_ENTRIES = 200;

function getFeedCacheStore() {
  globalThis.__infinitumFeedCache__ ??= new Map<string, FeedCacheEntry>();
  return globalThis.__infinitumFeedCache__;
}

function getFeedInFlightStore() {
  globalThis.__infinitumFeedCacheInFlight__ ??= new Map<string, Promise<unknown>>();
  return globalThis.__infinitumFeedCacheInFlight__;
}

function isFeedCacheEnabled() {
  return process.env.NODE_ENV !== "test";
}

function pruneFeedCacheEntries(store: Map<string, FeedCacheEntry>) {
  while (store.size > MAX_FEED_CACHE_ENTRIES) {
    const oldestKey = store.keys().next().value;

    if (!oldestKey) {
      return;
    }

    store.delete(oldestKey);
  }
}

export async function withFeedCache<T>(
  key: string,
  loader: () => Promise<T>,
  ttlMs = DEFAULT_FEED_CACHE_TTL_MS,
): Promise<T> {
  if (!isFeedCacheEnabled()) {
    return loader();
  }

  const cacheStore = getFeedCacheStore();
  const inFlightStore = getFeedInFlightStore();
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
      pruneFeedCacheEntries(cacheStore);
      return value;
    })
    .finally(() => {
      inFlightStore.delete(key);
    });

  inFlightStore.set(key, nextValue as Promise<unknown>);
  return nextValue;
}

export function invalidateFeedCache() {
  getFeedCacheStore().clear();
  getFeedInFlightStore().clear();
  const sharedGlobal = globalThis as typeof globalThis & {
    __infinitumEventBriefingCache__?: Map<string, unknown>;
    __infinitumEventBriefingCacheInFlight__?: Map<string, Promise<unknown>>;
  };
  sharedGlobal.__infinitumEventBriefingCache__?.clear();
  sharedGlobal.__infinitumEventBriefingCacheInFlight__?.clear();
}
