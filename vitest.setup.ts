import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

process.env.DATABASE_URL = `file:${process.cwd()}/prisma/test.db`;

Object.defineProperty(window, "scrollTo", {
  configurable: true,
  value: vi.fn(),
});

// Node 26 下 localStorage 需要 --localstorage-file 实验标志，jsdom 环境未启用时补一个内存实现
if (typeof window.localStorage === "undefined") {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  } satisfies Storage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorage,
  });
}
