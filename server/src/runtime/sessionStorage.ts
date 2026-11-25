// The Web Storage-like adapter supabase-js persists its auth sessions through, backed by the store (one doc
// per storage key in the `cloud` collection). Node has no localStorage, and Browser Direct uses the same
// store (IndexedDB) for the same reason.
//
// Removal must not leave the token behind: the store's `delDoc` keeps a tombstone WITH its data (cloud sync
// needs that for the `config` collection), so a plain delete would keep a signed-out session — access and
// refresh token — on disk and readable. `removeItem` therefore writes the tombstone with its data blanked,
// a tombstone always reads as absent, and the first use scrubs tombstones an older build left with data.
//
// Browser-safe: type-only imports.
import type { Store } from './store.js';

/** The collection the auth sessions live in. Never exposed over the generic store routes (storeAccess.ts). */
export const SESSION_COLLECTION = 'cloud';

export interface SessionStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Blank the data of every tombstone in the collection (left by builds before this adapter). Idempotent. */
export function scrubSessionTombstones(store: Store, collection = SESSION_COLLECTION): number {
  let n = 0;
  for (const d of store.docsChangedSince(collection, 0)) {
    if (d.deleted && d.data !== null && d.data !== undefined) {
      store.putDocRaw(collection, d.id, null, d.updatedAt, d.rev, true);
      n++;
    }
  }
  return n;
}

/** The adapter over `store`. A tombstone (or a non-string value) reads as absent; removal blanks the data. */
export function createStoreSessionStorage(store: Store, collection = SESSION_COLLECTION): SessionStorageAdapter {
  let scrubbed = false;
  const scrubOnce = () => {
    if (scrubbed) return;
    scrubbed = true;
    try { scrubSessionTombstones(store, collection); } catch { /* best effort; reads ignore tombstones anyway */ }
  };
  return {
    getItem: (key) => {
      scrubOnce();
      const d = store.getDoc(collection, key);
      return d && !d.deleted && typeof d.data === 'string' ? d.data : null;
    },
    setItem: (key, value) => {
      scrubOnce();
      store.putDoc(collection, key, value);
    },
    removeItem: (key) => {
      scrubOnce();
      const d = store.getDoc(collection, key);
      if (d) store.putDocRaw(collection, key, null, Date.now(), d.rev + 1, true);
    }
  };
}
