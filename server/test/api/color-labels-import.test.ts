// FM3-Edit preset-color import (replicated-purring-bachman plan) — pure byte parser
// (colorLabelsImport.ts) + disk discovery over a faked fs (editorCacheDiscovery.ts), plus the
// /fm3edit/color-labels/* endpoint shapes. No hardware, no device coupling (unlike
// editor-cache-import.test.ts) — this file/feature isn't tied to a connected device.
import '../helpers/env.js';
import { buildApp } from '../../src/app.js';
import { __createRegistryForTest } from '../../src/drivers/registry.js';
import { parseColorAssignments } from '../../src/services/colorLabelsImport.js';
import { discoverColorAssignments, type DiscoveryFs } from '../../src/services/editorCacheDiscovery.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const COLOR_LABELS_IMPORT_CASE_COUNT = 5;

// ── little-endian encoder matching the parser's byte layout ──
function encodeColorAssignments(groups: { color: number; names: string[] }[], trailer: number[] = []): Uint8Array {
  const bytes: number[] = [];
  const u16 = (v: number) => bytes.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (v: number) => bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x00010001); // version
  u32(0); // reserved
  u32(0); // reserved
  u16(0); // reserved
  u32(groups.length); // groupCount
  for (const g of groups) {
    u32(g.color);
    u32(g.names.length);
    for (const name of g.names) {
      const utf8 = Array.from(new TextEncoder().encode(name));
      u32(utf8.length);
      bytes.push(...utf8);
    }
  }
  bytes.push(...trailer);
  return new Uint8Array(bytes);
}

// ── 1. happy path parse, 6 groups, matches the real file's hex→name mapping ──
function happyPathParse(): void {
  const groups = [
    { color: 0xfffebcbc, names: ['Lead Tone', 'Crunch'] },
    { color: 0xffffd086, names: [] },
    { color: 0xfffff58a, names: ['Clean'] },
    { color: 0xffd7f184, names: [] },
    { color: 0xffbee0fb, names: [] },
    { color: 0xfff1d0fb, names: [] },
  ];
  const bytes = encodeColorAssignments(groups);
  const result = parseColorAssignments(bytes);
  assertEqual(result.groups.length, 6, 'six groups parsed');
  assertEqual(result.groups[0]!.hex, '#febcbc', 'group 0 hex (alpha byte stripped)');
  assertEqual(result.groups[0]!.names.length, 2, 'group 0 preset count');
  assertEqual(result.groups[0]!.names[0], 'Lead Tone', 'group 0 first preset name');
  assertEqual(result.groups[2]!.hex, '#fff58a', 'group 2 hex');
  assertEqual(result.groups[2]!.names[0], 'Clean', 'group 2 preset name');
}

// ── 2. trailing bytes (e.g. the real file's ASCII "_F") are ignored, not validated ──
function trailingBytesIgnored(): void {
  const bytes = encodeColorAssignments([{ color: 0xfffebcbc, names: ['Solo'] }], [0x5f, 0x46]); // "_F"
  const result = parseColorAssignments(bytes);
  assertEqual(result.groups.length, 1, 'parses despite trailing bytes');
  assertEqual(result.groups[0]!.names[0], 'Solo', 'preset name intact with trailer present');

  // Also tolerate MORE trailing bytes than the real file had — parser must not check total length.
  const bytesWithExtra = new Uint8Array([...bytes, 0, 0, 0, 0, 9, 9]);
  const result2 = parseColorAssignments(bytesWithExtra);
  assertEqual(result2.groups[0]!.names[0], 'Solo', 'still parses with extra unexpected trailing bytes');
}

// ── 3. malformed/truncated input throws a clear error (route maps this to 422) ──
function malformedThrows(): void {
  let threw = false;
  try { parseColorAssignments(new Uint8Array([1, 2, 3])); } catch { threw = true; }
  assert(threw, 'too-short buffer throws');

  threw = false;
  const full = encodeColorAssignments([{ color: 0xfffebcbc, names: ['Truncated'] }]);
  const cut = full.slice(0, full.length - 4); // chop off the last name's bytes
  try { parseColorAssignments(cut); } catch { threw = true; }
  assert(threw, 'truncated name payload throws');
}

// ── 4. disk discovery over a faked fs (glob, not hardcoded `_iii`) ──
function discovery(): void {
  const base = '/home/tester/Library/Application Support/Fractal Audio';
  const tree: Record<string, string[]> = {
    [base]: ['FM3-Edit', 'notes.txt'],
    [`${base}/FM3-Edit`]: ['color-assignments_iii.dat', 'effectDefinitions_11_12p0.cache'],
  };
  const fakeFs: DiscoveryFs = {
    existsSync: (p) => p === base,
    readdirSync: (p) => { const e = tree[p]; if (!e) throw new Error('ENOENT'); return e; },
    statSync: (p) => (p.endsWith('.dat') ? { size: 2265, mtimeMs: 1_700_000_000_000 } : (() => { throw new Error('EISDIR'); })()),
  };
  const found = discoverColorAssignments({ platform: 'darwin', home: '/home/tester', env: {}, fs: fakeFs });
  assertEqual(found.length, 1, 'one color-assignments file discovered');
  assertEqual(found[0]!.editor, 'FM3-Edit', 'editor dir name captured');
  assert(found[0]!.path.endsWith('/FM3-Edit/color-assignments_iii.dat'), 'candidate path under its editor dir');
  assertEqual(found[0]!.size, 2265, 'candidate size');
}

// ── 5. endpoint shapes: sources + import (path-based, mirroring /device/cache/import) ──
async function endpoints(): Promise<void> {
  const registry = __createRegistryForTest({ resolveConn: async () => null, openConn: () => { throw new Error('no conn'); } });
  const app = await buildApp(registry);
  try {
    const sources = await app.inject({ method: 'GET', url: '/fm3edit/color-labels/sources' });
    assertEqual(sources.statusCode, 200, 'sources 200');
    assert(Array.isArray((sources.json() as { candidates: unknown[] }).candidates), 'sources.candidates is an array');

    const bad = await app.inject({ method: 'POST', url: '/fm3edit/color-labels/import', payload: { path: '/does/not/exist.dat' } });
    assertEqual(bad.statusCode, 400, 'unreadable path → 400');
  } finally {
    await app.close();
  }
}

export async function runColorLabelsImportTests(): Promise<void> {
  happyPathParse();
  trailingBytesIgnored();
  malformedThrows();
  discovery();
  await endpoints();
}
