// On-device storage engine (MMKV).
//
// WhatsApp-style offline-first requires the cache to be readable *synchronously*
// so screens paint from disk on the very first frame (no empty flash while an
// async read resolves). MMKV reads are synchronous and don't cross the native
// async bridge, so they're dramatically faster than AsyncStorage.
//
// Two surfaces are exported:
//   • `storage`        — synchronous getters/setters. Use these to seed a
//                        component's initial useState so it renders cached data
//                        immediately (zero flash).
//   • `mmkvAsyncShim`  — an AsyncStorage-compatible async facade backed by MMKV.
//                        Modules written against AsyncStorage (e.g. chatCache)
//                        switch engines by only changing their import; every
//                        `await getItem(...)` keeps working, just far faster.
//
// Tokens/secrets deliberately stay in expo-secure-store / AsyncStorage via
// authStorage — they don't belong in the plaintext cache store.

import AsyncStorageLib from '@react-native-async-storage/async-storage';

// Minimal store contract the rest of this module depends on. MMKV satisfies it
// natively; the in-memory fallback below implements it too.
interface KVBackend {
  getString(key: string): string | undefined;
  getBoolean(key: string): boolean | undefined;
  set(key: string, value: string | boolean): void;
  delete(key: string): void;
  getAllKeys(): string[];
}

// In-memory fallback used only when the MMKV native module is unavailable
// (e.g. running in Expo Go, or before a dev-client rebuild). Non-persistent —
// the app still runs and caches within the session instead of crashing at import.
// NOTE: this only backs the *synchronous* `storage`/`mmkv` surface, which no
// screen relies on for persistence; the async `mmkvAsyncShim` (which chatCache
// and calls use) falls back to real AsyncStorage below, so offline-first data
// still persists in Expo Go.
class MemoryBackend implements KVBackend {
  private store = new Map<string, string | boolean>();
  getString(key: string) { const v = this.store.get(key); return typeof v === 'string' ? v : undefined; }
  getBoolean(key: string) { const v = this.store.get(key); return typeof v === 'boolean' ? v : undefined; }
  set(key: string, value: string | boolean) { this.store.set(key, value); }
  delete(key: string) { this.store.delete(key); }
  getAllKeys() { return Array.from(this.store.keys()); }
}

// Whether the MMKV (Nitro) native module is available in this runtime.
// `react-native-mmkv` v4 pulls in react-native-nitro-modules, a TurboModule that
// DOES NOT exist in Expo Go — and it throws at MODULE-EVALUATION time, so a static
// `import` would crash the whole bundle (storage → chatCache → _layout → every
// route) before any try/catch could run. Load it lazily via require() inside a
// guard so Expo Go degrades gracefully to AsyncStorage instead of white-screening.
export let usingMMKV = false;

export const mmkv: KVBackend = (() => {
  try {
    // Deferred require: evaluating react-native-mmkv is what touches Nitro, so the
    // throw happens HERE (catchable), not at import time (uncatchable).
    const { createMMKV } = require('react-native-mmkv');
    // MMKV v4 (Nitro) creates instances via a factory, not `new MMKV()`. Its typed
    // surface has overloaded set()/getters that don't structurally line up with our
    // minimal KVBackend, but every runtime method we use exists — cast to the
    // contract we depend on.
    const instance = createMMKV({ id: 'bubble-cache' }) as unknown as KVBackend;
    usingMMKV = true;
    return instance;
  } catch (err) {
    console.warn('[storage] MMKV native module unavailable (Expo Go / no dev client) — synchronous cache is in-memory; persistent cache falls back to AsyncStorage. Build a dev client for MMKV.', err);
    return new MemoryBackend();
  }
})();

// ── Synchronous API (use for zero-flash initial render state) ────────────────
export const storage = {
  getString(key: string): string | null {
    const v = mmkv.getString(key);
    return v === undefined ? null : v;
  },
  getObject<T = any>(key: string, fallback: T): T {
    const raw = mmkv.getString(key);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: string): void {
    mmkv.set(key, value);
  },
  setObject(key: string, value: any): void {
    mmkv.set(key, JSON.stringify(value));
  },
  remove(key: string): void {
    mmkv.delete(key);
  },
  getAllKeys(): string[] {
    return mmkv.getAllKeys();
  },
};

// ── AsyncStorage-compatible async facade ─────────────────────────────────────
// When MMKV is present it's backed by synchronous MMKV (fast, no bridge hop).
// When it's NOT (Expo Go), every method delegates to REAL AsyncStorage so the
// persistent cache (chatCache, offline queue, call screen) keeps working and
// survives reloads — it just reads/writes the same keys the app always used.
export const mmkvAsyncShim = {
  async getItem(key: string): Promise<string | null> {
    if (!usingMMKV) return AsyncStorageLib.getItem(key);
    const v = mmkv.getString(key);
    return v === undefined ? null : v;
  },
  async setItem(key: string, value: string): Promise<void> {
    if (!usingMMKV) return AsyncStorageLib.setItem(key, value);
    mmkv.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    if (!usingMMKV) return AsyncStorageLib.removeItem(key);
    mmkv.delete(key);
  },
  async getAllKeys(): Promise<string[]> {
    if (!usingMMKV) return [...(await AsyncStorageLib.getAllKeys())];
    return mmkv.getAllKeys();
  },
  async multiGet(keys: string[]): Promise<[string, string | null][]> {
    if (!usingMMKV) return (await AsyncStorageLib.multiGet(keys)).map(([k, v]) => [k, v ?? null] as [string, string | null]);
    return keys.map((k) => [k, mmkv.getString(k) ?? null] as [string, string | null]);
  },
  async multiSet(entries: [string, string][]): Promise<void> {
    if (!usingMMKV) return AsyncStorageLib.multiSet(entries);
    for (const [k, v] of entries) mmkv.set(k, v);
  },
  async multiRemove(keys: string[]): Promise<void> {
    if (!usingMMKV) return AsyncStorageLib.multiRemove(keys);
    for (const k of keys) mmkv.delete(k);
  },
};

// ── One-time migration: previous AsyncStorage build → MMKV ───────────────────
// Copies cache blobs (chats, contacts, per-chat messages, folders, drafts,
// avatars, org members, call history, and the offline send queue) so an
// upgrading user keeps everything offline. Idempotent — guarded by a flag in
// MMKV so it only runs on the first launch after the storage-engine switch.
const MIGRATION_FLAG = '__bubble_mmkv_migrated_v1__';

export async function migrateAsyncStorageToMMKV(): Promise<void> {
  try {
    // No MMKV (Expo Go): the async cache already IS AsyncStorage, so there's
    // nothing to copy — the data is exactly where mmkvAsyncShim reads it.
    if (!usingMMKV) return;
    if (mmkv.getBoolean(MIGRATION_FLAG)) return;
    const allKeys = await AsyncStorageLib.getAllKeys();
    const cacheKeys = allKeys.filter(
      (k) =>
        k.startsWith('bubble_cached_') ||
        k.startsWith('bubble_chat_') ||
        k === 'bubble_offline_message_queue',
    );
    if (cacheKeys.length > 0) {
      const entries = await AsyncStorageLib.multiGet(cacheKeys);
      for (const [k, v] of entries) if (v != null) mmkv.set(k, v);
    }
    mmkv.set(MIGRATION_FLAG, true);
  } catch (err) {
    console.warn('[storage] AsyncStorage→MMKV migration failed:', err);
  }
}
