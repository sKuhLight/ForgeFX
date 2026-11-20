// Local storage folder routes (/local/*) — config lifecycle, path-traversal rejection, library
// write/read round-trip, decode-failure skipping, incremental Sync/ export (idempotent second run),
// and sha256-verified restore into a wiped version store. Runs the real buildApp over an isolated
// registry with a fake gen-3 driver whose decodePresetBytes is deterministic (no codec dependency);
// FORGEFX_DATA_DIR is a throwaway (helpers/env.ts), and the local root is a fresh temp dir.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceDriver, DriverCapabilities } from '../../src/drivers/types.js';
import { buildTestApp } from '../helpers/api.js';
import { assert, assertEqual } from '../helpers/mock.js';
import * as store from '../../src/store.js';
import { DATA_DIR } from '../../src/store.js';

export const LOCAL_CASE_COUNT = 13;

// gen-3-style .syx head: frame[4] = 0x11 (FM3) → decodeBytes dispatches to the driver's decoder
const presetSyx = (tag: number) => Uint8Array.from([0xf0, 0x00, 0x01, 0x74, 0x11, 0x77, tag, 0x01, 0xf7]);
const JUNK = Uint8Array.from([0x49, 0x52, 0x20, 0x64, 0x61, 0x74, 0x61]); // no 0xF0 → decode throws → skipped

const CAPS: DriverCapabilities = {
  slotModel: 'grid',
  slotCount: 512,
  gridEdit: true,
  scenes: 8,
  channels: true,
  presetDump: true,
  blockParamDecode: true,
  telemetry: { tuner: false, outputMeters: false, cpu: false },
  fcModel: false,
  fcLiveRead: false,
  modBind: false,
  cabIrs: false,
  supportsSave: true,
  selfDescribe: false
} as DriverCapabilities;

/** Minimal fake FM3 driver: grid stub + a deterministic offline decoder ("P<tag>" from byte 6). */
function makeFakeFm3(): DeviceDriver {
  return {
    modelId: 0x11,
    key: 'fm3',
    name: 'FM3',
    capabilities: CAPS,
    grid: async () => ({ model: 'fm3', name: 'TEST', crcValid: true, rows: 1, cols: 1, scenes: [], cells: [], source: 'dump' as const }),
    decodePresetBytes: (bytes: Uint8Array) => {
      if (bytes[0] !== 0xf0 || bytes.length < 8) throw new Error('not a preset');
      // tag 0x7e stands in for an unused-slot dump (the real decoder flags those `empty`)
      if (bytes[6] === 0x7e) return { name: '', number: -1, crcValid: false, empty: true, scenes: [], blocks: [] } as never;
      return { name: `P${bytes[6]}`, number: bytes[6], scenes: [], blocks: [], params: [{ big: 'payload' }] } as never;
    }
  } as DeviceDriver;
}

export async function runLocalTests(): Promise<void> {
  const { app } = await buildTestApp(0x11, makeFakeFm3());
  const root = mkdtempSync(join(tmpdir(), 'axis-local-test-'));
  const inject = (opts: Parameters<typeof app.inject>[0]) => app.inject(opts as never);

  try {
    // 1 — unconfigured state + gated routes
    let res = await inject({ method: 'GET', url: '/local/config' });
    assertEqual(res.statusCode, 200, 'GET /local/config (unset) status');
    assertEqual(res.json().configured, false, 'unset → configured:false');
    res = await inject({ method: 'POST', url: '/local/sync' });
    assertEqual(res.statusCode, 409, 'sync unconfigured → 409');

    // 2 — reject relative root
    res = await inject({ method: 'PUT', url: '/local/config', payload: { root: 'relative/path' } });
    assertEqual(res.statusCode, 400, 'relative root → 400');

    // 3 — configure: creates Presets/ + Sync/
    res = await inject({ method: 'PUT', url: '/local/config', payload: { root } });
    assertEqual(res.statusCode, 200, 'PUT /local/config status');
    assert(res.json().configured && res.json().writable, 'configured + writable');
    assert(existsSync(join(root, 'Presets')) && existsSync(join(root, 'Sync')), 'subfolders created');

    // 4 — path traversal rejected
    res = await inject({ method: 'GET', url: `/local/presets/file?path=${encodeURIComponent('../secret.syx')}` });
    assertEqual(res.statusCode, 400, 'traversal read → 400');
    res = await inject({ method: 'POST', url: '/local/presets', payload: { name: 'x', dir: '../out', bytes: [1] } });
    assertEqual(res.statusCode, 400, 'traversal write → 400');

    // 5 — export into folder + read back byte-identical
    const p7 = [...presetSyx(7)];
    res = await inject({ method: 'POST', url: '/local/presets', payload: { name: 'Test One', bytes: p7 } });
    assertEqual(res.statusCode, 200, 'export status');
    assertEqual(res.json().path, 'Test One.syx', 'export path');
    res = await inject({ method: 'GET', url: `/local/presets/file?path=${encodeURIComponent('Test One.syx')}` });
    assertEqual(res.statusCode, 200, 'file read status');
    assertEqual([...res.rawPayload].join(','), p7.join(','), 'round-trip bytes identical');

    // 6 — duplicate → 409; overwrite → ok
    res = await inject({ method: 'POST', url: '/local/presets', payload: { name: 'Test One', bytes: p7 } });
    assertEqual(res.statusCode, 409, 'duplicate export → 409');
    res = await inject({ method: 'POST', url: '/local/presets', payload: { name: 'Test One', bytes: p7, overwrite: true } });
    assertEqual(res.statusCode, 200, 'overwrite export → ok');

    // 7 — scan: decodable entries listed (params stripped), junk skipped, subdirs walked
    mkdirSync(join(root, 'Presets', 'Sub'), { recursive: true });
    writeFileSync(join(root, 'Presets', 'Sub', 'Two.syx'), presetSyx(9));
    writeFileSync(join(root, 'Presets', 'ir-file.syx'), JUNK);
    writeFileSync(join(root, 'Presets', 'Unused Slot.syx'), presetSyx(0x7e)); // an empty-slot dump
    res = await inject({ method: 'GET', url: '/local/presets' });
    assertEqual(res.statusCode, 200, 'scan status');
    const scan = res.json() as { entries: { path: string; name: string; summary: Record<string, unknown> }[]; skipped: number };
    assertEqual(scan.entries.length, 2, 'scan entries count');
    assertEqual(scan.skipped, 2, 'junk .syx and empty-slot .syx skipped');
    assert(!scan.entries.some((e) => e.path === 'Unused Slot.syx'), 'empty-slot .syx is not listed under its file name');
    const two = scan.entries.find((e) => e.path === 'Sub/Two.syx');
    assert(two, 'subdir entry found');
    assertEqual(two!.name, 'P9', 'decoded name');
    assert(!('params' in two!.summary), 'summary.params stripped');

    // 8 — second scan stable (mtime cache path)
    res = await inject({ method: 'GET', url: '/local/presets' });
    assertEqual((res.json() as { entries: unknown[] }).entries.length, 2, 'cached rescan stable');

    // 9 — Sync/ export: manual snapshot + backup group land as plain .syx + index.json
    const v1 = store.addPresetVersion({ location: 42, crc: 0x1234, name: 'Big Clean Lead', model: 'FM3', source: 'manual' }, presetSyx(1))!;
    const bk = store.createBackup('Device backup', 'FM3');
    const v2 = store.addPresetVersion({ location: 3, crc: 0x2222, name: 'Riff', model: 'FM3', source: 'backup', backupId: bk.id }, presetSyx(2))!;
    res = await inject({ method: 'POST', url: '/local/sync' });
    assertEqual(res.statusCode, 200, 'sync status');
    assertEqual(res.json().written, 2, 'sync wrote 2 versions');
    const idx = JSON.parse(readFileSync(join(root, 'Sync', 'index.json'), 'utf8'));
    assertEqual(idx.versions.length, 2, 'index has 2 versions');
    for (const v of idx.versions) assert(existsSync(join(root, 'Sync', ...v.file.split('/'))), `synced file exists: ${v.file}`);
    assert((idx.versions as { file: string }[]).some((v) => v.file.includes('backups/')), 'backup member under backups/');

    // 10 — second sync is a no-op (incremental)
    res = await inject({ method: 'POST', url: '/local/sync' });
    assertEqual(res.json().written, 0, 'second sync writes 0');
    assertEqual(res.json().skippedExisting, 2, 'second sync skips existing');

    // 11 — restore into a wiped version store, sha256-verified; tampered file skipped
    rmSync(join(DATA_DIR, 'versions'), { recursive: true, force: true });
    assert(!store.hasPresetVersion(v1.id), 'store wiped');
    const tampered = idx.versions.find((v: { id: string }) => v.id === v2.id) as { file: string };
    writeFileSync(join(root, 'Sync', ...tampered.file.split('/')), JUNK); // hash mismatch → skipped
    res = await inject({ method: 'POST', url: '/local/restore' });
    assertEqual(res.statusCode, 200, 'restore status');
    assertEqual(res.json().imported, 1, 'restore imported the intact version');
    assertEqual(res.json().skippedBad, 1, 'tampered file skipped');
    assert(store.hasPresetVersion(v1.id), 'v1 back in the store');
    assertEqual([...(store.getPresetVersionBytes(v1.id) ?? [])].join(','), [...presetSyx(1)].join(','), 'restored bytes identical');

    // 12 — exact-path write-back (save-to-disk): overwrites the very file a preset was loaded from
    const p8 = [...presetSyx(8)];
    res = await inject({ method: 'POST', url: '/local/presets', payload: { path: 'Sub/Two.syx', bytes: p8, overwrite: true } });
    assertEqual(res.statusCode, 200, 'path write-back status');
    assertEqual(res.json().path, 'Sub/Two.syx', 'path write-back kept the exact file');
    assertEqual([...readFileSync(join(root, 'Presets', 'Sub', 'Two.syx'))].join(','), p8.join(','), 'path write-back bytes');
    res = await inject({ method: 'POST', url: '/local/presets', payload: { path: '../evil.syx', bytes: p8, overwrite: true } });
    assertEqual(res.statusCode, 400, 'path traversal write-back → 400');

    // 13 — clear config
    res = await inject({ method: 'PUT', url: '/local/config', payload: { root: null } });
    assertEqual(res.json().configured, false, 'cleared → configured:false');
  } finally {
    rmSync(root, { recursive: true, force: true });
    await app.close();
  }
}
