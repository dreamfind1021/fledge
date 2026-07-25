// vitest 全域 setup（只影響測試，正式執行環境不經過這裡）
//
// Node 25 會在 globalThis 放一個沒有任何方法的 localStorage 空殼（未帶 --localstorage-file），
// 它蓋掉了 jsdom 的 Storage：`typeof localStorage !== "undefined"` 為真但 getItem 不存在，
// 於是任何讀寫 localStorage 的模組（i18n.ts、Sidebar 收合狀態…）一 import 就 TypeError。
// 這裡在偵測到空殼時換上最小可用的 in-memory Storage，讓測試能真的驗證持久化行為。

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  } as Storage;
}

const existing = globalThis.localStorage as Storage | undefined;
if (typeof existing?.getItem !== "function") {
  const storage = createMemoryStorage();
  const descriptor = { value: storage, configurable: true, writable: true };
  Object.defineProperty(globalThis, "localStorage", descriptor);
  if (typeof window !== "undefined" && window !== (globalThis as unknown)) {
    Object.defineProperty(window, "localStorage", descriptor);
  }
}
