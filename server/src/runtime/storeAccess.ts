// Private store collections — documents that must never be readable or writable through the generic
// `/store/:c[/:id]` routes (app.ts and the runtime router), nor over the Remote relay.
//
// Why: the generic store routes have no origin guard (Axis reads and writes its `config` through them),
// CORS reflects every origin, and the server listens on all interfaces. The `cloud` collection holds the
// Supabase auth sessions (access AND refresh token of the signed-in account, and the anonymous upload
// session): readable over HTTP, any web page the user opens — or anyone on the LAN — could take them;
// writable, a page could plant a session of its own. No client needs them over HTTP: the cloud client
// reads its store directly, in the server and in Browser Direct alike.
//
// The answer is a constant `403 { error: 'forbidden-collection' }` for every method and id, whether or not
// anything is stored: it says what happened (a policy refusal, not a missing document — an unknown
// collection lists as `{ docs: [] }`, so a 404 here would be the odd one out), and it reveals nothing
// about the contents.
//
// The check folds case and the fs backend's file-name sanitising (store/<collection>.json, with every
// character outside [A-Za-z0-9_.-] replaced): on a case-insensitive file system (Windows, macOS)
// `/store/CLOUD` reads the same file as `/store/cloud`.
//
// Pure, browser-safe: no imports.

/** Collections the generic store routes refuse. */
export const PRIVATE_STORE_COLLECTIONS: readonly string[] = ['cloud'];

/** Collections the generic store routes may READ but never write or delete: state a dedicated API owns.
 *  `cacheContributions` holds the handles to this install's editor-cache uploads (services/cacheContribution.ts);
 *  a page that could delete or plant them could make an upload undeletable or point a withdraw elsewhere.
 *  `cloudVerdicts` holds this install's device checks of shared definition rows (services/cloudProfiles.ts); a page
 *  that could plant a `failed` verdict could hide an honest row from the offer. */
export const WRITE_PROTECTED_STORE_COLLECTIONS: readonly string[] = ['cacheContributions', 'cloudVerdicts'];

/** The error code a refused collection gets (HTTP 403). */
export const FORBIDDEN_COLLECTION = 'forbidden-collection';

/** The 403 body. */
export const FORBIDDEN_COLLECTION_BODY = { error: FORBIDDEN_COLLECTION } as const;

/** The file key the fs backend would use for a collection name, case-folded. */
function collectionKey(collection: string): string {
  return collection.replace(/[^\w.-]/g, '_').toLowerCase();
}

/** Is `collection` (a decoded route parameter) one of the private collections? */
export function isPrivateCollection(collection: string): boolean {
  if (typeof collection !== 'string') return false;
  const key = collectionKey(collection);
  return PRIVATE_STORE_COLLECTIONS.some((c) => collectionKey(c) === key);
}

/** Is `collection` one the generic routes must not WRITE (PUT/DELETE)? The private ones, plus the write-protected. */
export function isWriteProtectedCollection(collection: string): boolean {
  if (typeof collection !== 'string') return false;
  if (isPrivateCollection(collection)) return true;
  const key = collectionKey(collection);
  return WRITE_PROTECTED_STORE_COLLECTIONS.some((c) => collectionKey(c) === key);
}

/** Does a request path (`/store/<collection>[/<id>]`, query allowed, possibly percent-encoded) address a
 *  private collection? For the Remote allowlist, which sees the raw path. */
export function isPrivateStorePath(path: string): boolean {
  const p = (path.split('?')[0] ?? '').replace(/\/+$/, '');
  const segs = p.split('/').filter(Boolean);
  if (segs.length < 2 || segs[0]!.toLowerCase() !== 'store') return false;
  let c = segs[1]!;
  try { c = decodeURIComponent(c); } catch { return true; } // undecodable: refuse rather than guess
  return isPrivateCollection(c);
}
