/**
 * In-memory `Storage` implementation for tests.
 *
 * jsdom hands back Node's experimental localStorage in this setup (no
 * `clear()`, and it leaks between test files), so tests install their own.
 */
export class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

/** Install a fresh in-memory localStorage on the given global object. */
export function installMemoryStorage(target: Record<string, unknown>) {
  const storage = new MemoryStorage();
  Object.defineProperty(target, "localStorage", {
    value: storage,
    writable: true,
    configurable: true,
  });
  return storage;
}
