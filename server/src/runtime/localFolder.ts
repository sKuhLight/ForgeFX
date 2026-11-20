// Local storage folder — SHARED logic for the user-configured root directory managed by ForgeFX with
// two subfolders:
//   Presets/  browsable .syx library (users point Axis at the collections they already carry around)
//   Sync/     plain-syx mirror of the version store (human-readable, usable by FM3-Edit/Fractal-Bot,
//             unlimited — the local alternative/complement to cloud sync)
//
// Since the browser-runtime split all filesystem work goes through a FolderAdapter (folderAdapter.ts)
// and all version-store access through an injected VersionStore, so the same scan/sync/restore logic
// runs over Node fs (fsFolderAdapter.ts, wired by localStore.ts) or a browser directory handle. Paths
// in here are RELATIVE POSIX paths inside the root; safeRel() is the traversal guard every
// externally-supplied path must pass (shared, so browsers get the same safety).
//
// Sync/ format: raw .syx files named `<loc 3-digit> - <name> - <timestamp>.syx` plus a pretty-printed
// index.json carrying the version metadata (id/hash/crc/...). Export is incremental (set-difference on
// version ids, like cloud.ts syncVersions) and NEVER deletes user files; restore re-imports missing
// versions into the version store, sha256-verified against the index.
// NO node: imports in this module — it must load in a browser.
import type { FolderAdapter, FolderEntry } from './folderAdapter.js';
import type { Backup, PresetVersion } from './storeBackend.js';

/** Offline preset decode (model-byte dispatched; throws on non-preset bytes) — wired from app.ts. */
export type DecodeFn = (bytes: Uint8Array) => Promise<Record<string, unknown>>;

/** The slice of the version store the folder logic needs (store.ts's Store satisfies it). */
export interface VersionStore {
  listBackups(): Backup[];
  listPresetVersions(location?: number): PresetVersion[];
  getPresetVersionBytes(id: string): Uint8Array | null;
  hasPresetVersion(id: string): boolean;
  importVersion(v: PresetVersion, syx: Uint8Array): void;
}

export const PRESETS_SUB = 'Presets';
export const SYNC_SUB = 'Sync';
const MAX_FILES = 10_000; // scan cap — beyond this we stop descending (reported via `truncated`)
const MAX_DEPTH = 8;
const MAX_SIZE = 2 * 1024 * 1024; // skip .syx > 2 MB (firmware images, not presets)

// ─────────────────────────── path safety ───────────────────────────
/** Normalize `rel` to a '/'-joined path strictly inside the root; null on traversal/absolute/NUL.
 *  Pure segment-stack normalization (the portable equivalent of the old resolve()-under-base check):
 *  internal `..` may pop earlier segments, but popping past the root rejects. */
export function safeRel(rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel)) return null; // absolute
  const out: string[] = [];
  for (const seg of rel.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}
/** Filesystem-safe filename fragment (Windows-safe, bounded). */
export const sanitize = (s: string): string =>
  (s || 'preset').replace(/[^\w \-().]+/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || 'preset';

export const isSyx = (name: string) => name.toLowerCase().endsWith('.syx');

/** Can we create files in the root? (write + remove a probe file) */
export async function writableProbe(ad: FolderAdapter): Promise<boolean> {
  try {
    await ad.writeFile('.axis-write-test', new Uint8Array(0));
    await ad.remove('.axis-write-test');
    return true;
  } catch { return false; }
}

// ─────────────────────────── Presets/ scan + decode cache ───────────────────────────
export interface ScanRec { size: number; mtime: number; summary: Record<string, unknown> | null; error?: string }
export type ScanCache = Record<string, ScanRec>; // keyed by adapter.key() (Node: absolute path → root moves invalidate naturally)
/** Persistence hook for the decode-summary cache (Node routes it to DATA_DIR/localScan.json via the
 *  store backend; a browser supplies its own keyed record). Best-effort — save failures are swallowed. */
export interface ScanCachePersistence { load(): ScanCache; save(cache: ScanCache): void }

export interface LocalPresetEntry { path: string; name: string; size: number; mtime: number; summary: Record<string, unknown> }

export async function scanPresets(ad: FolderAdapter, decode: DecodeFn, force: boolean, cacheStore: ScanCachePersistence): Promise<{ entries: LocalPresetEntry[]; skipped: number; truncated: boolean }> {
  const cache: ScanCache = force ? {} : cacheStore.load();
  const next: ScanCache = {};
  const entries: LocalPresetEntry[] = [];
  let skipped = 0, seen = 0, truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let items: FolderEntry[];
    try { items = await ad.list(dir); } catch { return; } // unreadable subdir → skip, not fail
    for (const it of items) {
      if (it.name.startsWith('.')) continue;
      if (seen >= MAX_FILES) { truncated = true; return; }
      const rel = `${dir}/${it.name}`;
      if (it.dir) { await walk(rel, depth + 1); continue; }
      if (!isSyx(it.name) || it.size > MAX_SIZE || it.size === 0) continue;
      seen++;
      const key = ad.key(rel);
      const hit = cache[key];
      let rec: ScanRec;
      if (hit && hit.size === it.size && hit.mtime === it.mtimeMs) {
        rec = hit; // mtime cache hit — no decode
      } else {
        try {
          const summary = { ...(await decode(await ad.readFile(rel))) };
          delete summary.params; // full per-block params bloat the index; deep search over local entries is deferred
          rec = { size: it.size, mtime: it.mtimeMs, summary };
        } catch (e) {
          rec = { size: it.size, mtime: it.mtimeMs, summary: null, error: (e as Error).message }; // IR/cab/firmware .syx → negative-cached
        }
      }
      next[key] = rec;
      // undecodable (IR/cab/firmware) or an unused-slot dump (`empty`): not a preset, so don't list it
      if (!rec.summary || rec.summary.empty === true) { skipped++; continue; }
      entries.push({
        path: rel.slice(PRESETS_SUB.length + 1),
        name: typeof rec.summary.name === 'string' && rec.summary.name ? (rec.summary.name as string) : it.name.replace(/\.syx$/i, ''),
        size: it.size,
        mtime: it.mtimeMs,
        summary: rec.summary
      });
    }
  };
  await walk(PRESETS_SUB, 0);
  try { cacheStore.save(next); } catch { /* cache is best-effort */ }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, skipped, truncated };
}

// ─────────────────────────── Sync/ mirror (plain .syx + index.json) ───────────────────────────
interface LocalIndexVersion {
  id: string; location: number; crc: number; hash: string; name: string; model: string;
  capturedAt: number; source: string; backupId: string | null; bytes: number; file: string;
}
interface LocalIndexBackup { id: string; label: string; model: string; createdAt: number; count: number; dir: string }
interface LocalIndex { v: 1; generatedAt: number; backups: LocalIndexBackup[]; versions: LocalIndexVersion[] }

const INDEX_REL = `${SYNC_SUB}/index.json`;
const loadIndex = async (ad: FolderAdapter): Promise<LocalIndex> => {
  let idx: Partial<LocalIndex> = {};
  try { idx = JSON.parse(new TextDecoder().decode(await ad.readFile(INDEX_REL))) as Partial<LocalIndex>; } catch { /* missing/corrupt → fresh */ }
  return { v: 1, generatedAt: idx.generatedAt ?? 0, backups: Array.isArray(idx.backups) ? idx.backups : [], versions: Array.isArray(idx.versions) ? idx.versions : [] };
};
/** Pretty-printed + atomic (adapter writeFile is tmp+rename) — a crash mid-write must not corrupt the index. */
const saveIndex = (ad: FolderAdapter, idx: LocalIndex) => ad.writeFile(INDEX_REL, new TextEncoder().encode(JSON.stringify(idx, null, 2)));

const loc3 = (n: number) => (n >= 0 ? String(n).padStart(3, '0') : 'buf');
const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 19).replace(/:/g, '-'); // sortable, fs-safe
const dateOnly = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export async function syncToFolder(ad: FolderAdapter, store: VersionStore): Promise<{ ok: true; written: number; skippedExisting: number; total: number; backups: number }> {
  await ad.mkdir(SYNC_SUB);
  const idx = await loadIndex(ad);
  const have = new Map(idx.versions.map((v) => [v.id, v]));
  const backups = store.listBackups();
  const bkById = new Map(backups.map((b) => [b.id, b]));

  // backup-group directories (created lazily; merged into the index)
  const bkDir = (bkId: string, model: string): string => {
    const known = idx.backups.find((b) => b.id === bkId);
    if (known) return known.dir;
    const meta = bkById.get(bkId);
    const dir = `${sanitize(model || meta?.model || 'device')}/backups/${sanitize(`${dateOnly(meta?.createdAt ?? Date.now())} ${meta?.label ?? 'Device backup'} (${bkId})`)}`;
    idx.backups.push({ id: bkId, label: meta?.label ?? '', model: meta?.model ?? model, createdAt: meta?.createdAt ?? 0, count: meta?.count ?? 0, dir });
    return dir;
  };

  let written = 0, skippedExisting = 0;
  for (const v of store.listPresetVersions()) {
    const known = have.get(v.id);
    if (known && (await ad.exists(`${SYNC_SUB}/${known.file}`))) { skippedExisting++; continue; }
    const bytes = store.getPresetVersionBytes(v.id);
    if (!bytes) continue; // blob missing locally (shouldn't happen) → skip, never fail the run
    const relDir = v.backupId ? bkDir(v.backupId, v.model) : `${sanitize(v.model || 'device')}/versions`;
    const base = v.backupId
      ? `${loc3(v.location)} - ${sanitize(v.name)}`
      : `${loc3(v.location)} - ${sanitize(v.name)} - ${stamp(v.capturedAt)}`;
    let rel = `${relDir}/${base}.syx`;
    if (!known && (await ad.exists(`${SYNC_SUB}/${rel}`))) rel = `${relDir}/${base} ~${sanitize(v.id)}.syx`; // name collision → suffix, never overwrite
    await ad.mkdir(`${SYNC_SUB}/${relDir}`);
    await ad.writeFile(`${SYNC_SUB}/${rel}`, bytes);
    if (known) known.file = rel;
    else idx.versions.push({ id: v.id, location: v.location, crc: v.crc, hash: v.hash, name: v.name, model: v.model, capturedAt: v.capturedAt, source: v.source, backupId: v.backupId ?? null, bytes: v.bytes, file: rel });
    written++;
  }
  idx.generatedAt = Date.now();
  await saveIndex(ad, idx);
  return { ok: true, written, skippedExisting, total: idx.versions.length, backups: idx.backups.length };
}

export async function restoreFromFolder(ad: FolderAdapter, store: VersionStore, sha256Hex: (b: Uint8Array) => string): Promise<{ ok: true; imported: number; skippedExisting: number; skippedBad: number }> {
  const idx = await loadIndex(ad);
  let imported = 0, skippedExisting = 0, skippedBad = 0;
  for (const v of idx.versions) {
    if (store.hasPresetVersion(v.id)) { skippedExisting++; continue; }
    const rel = v.file ? safeRel(v.file) : null;
    if (rel == null || !(await ad.exists(`${SYNC_SUB}/${rel}`))) { skippedBad++; continue; }
    let syx: Uint8Array;
    try { syx = await ad.readFile(`${SYNC_SUB}/${rel}`); } catch { skippedBad++; continue; }
    if (sha256Hex(syx) !== v.hash) { console.warn(`[forgefx] local restore: hash mismatch for ${v.file} — skipped`); skippedBad++; continue; }
    store.importVersion(
      { id: v.id, location: v.location, crc: v.crc, hash: v.hash, name: v.name, model: v.model, capturedAt: v.capturedAt, source: (v.source as 'manual' | 'auto' | 'backup') ?? 'manual', ...(v.backupId ? { backupId: v.backupId } : {}), bytes: v.bytes, stored: 0 },
      syx
    );
    imported++;
  }
  return { ok: true, imported, skippedExisting, skippedBad };
}
