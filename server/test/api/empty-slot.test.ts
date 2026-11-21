// Unused (empty) preset slots over the REAL gen-3 FM3 driver — mocked transport, NO hardware.
// An unused slot reads back as a normal full-length dump (0x77 header, 8 x 0x78 chunks, 0x79 footer)
// whose patch is entirely zero. It used to fail every dump-backed route with HTTP 503 ("Maximum call
// stack size exceeded"); it must now answer normally as an EMPTY preset: blank name, no blocks/scenes,
// crcValid:false, `empty:true`. Every case runs against BOTH the Fastify app (app.ts) and the
// Browser-Direct runtime router (runtime/router.ts) — they share the driver — and the pair is
// deep-compared. The empty dump is built synthetically here (independent hand-built frames with real
// checksums); a populated FM3 fixture proves the additive `empty` flag never leaks onto real presets.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import { buildTestApp } from '../helpers/api.js';
import { handshakeReply, isIdentifyBroadcast, dumpAnswering, assert, assertEqual } from '../helpers/mock.js';
import { createRouter } from '../../src/runtime/router.js';
import { PROFILES } from '../../src/devices.js';
import { EmptyPresetError, type DeviceDriver } from '../../src/drivers/types.js';
import { convertFromDriver, ConvertError } from '../../src/services/convert.js';
import * as store from '../../src/store.js';

// 9 endpoint probes asserted on the app AND the router (summary, summary?full, params, decode,
// /backup/preset, /preset/backup refused + populated control, populated summary + params), then app-only:
// convert + convert/export refuse an empty source (+ populated control), the connected-driver convert
// path, and the local Presets folder scan (convert and /local/* have no Browser-Direct router twin).
export const EMPTY_SLOT_CASE_COUNT = 14;

const FM3 = 0x11;
const EMPTY_SLOT = 5;
const POPULATED_SLOT = 6;
const BACKUP_SLOT = 301; // a location no other suite writes versions for
const CHUNKS = 8; // an FM3 preset dump carries 8 chunk frames

const FM3_PRESET_5 = Uint8Array.from(
  readFileSync(fileURLToPath(new URL('../fixtures/preset-convert/fm3-preset-5.syx', import.meta.url)))
);

function sysex(model: number, fn: number, payload: readonly number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** Unused-slot dump frames: slot-addressed header, 8 chunks of (2-byte discriminator + 3072 zero
 *  bytes), zero footer. Each frame carries its real XOR checksum. */
function emptyDumpFrames(slot: number): number[][] {
  const frames: number[][] = [sysex(FM3, 0x77, [(slot >> 7) & 0x7f, slot & 0x7f, 0x00, 0x40, 0x00])];
  for (let i = 0; i < CHUNKS; i++) frames.push(sysex(FM3, 0x78, [0x00, 0x08, ...new Array<number>(3072).fill(0)]));
  frames.push(sysex(FM3, 0x79, [0x00, 0x00, 0x00]));
  return frames;
}

/** Split a flat .syx byte stream into F0..F7 frames. */
function framesOf(bytes: Uint8Array): number[][] {
  const frames: number[][] = [];
  let cur: number[] | null = null;
  for (const b of bytes) {
    if (b === 0xf0) cur = [b];
    else if (cur) {
      cur.push(b);
      if (b === 0xf7) { frames.push(cur); cur = null; }
    }
  }
  return frames;
}

function deepEq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export async function runEmptySlotTests(): Promise<void> {
  const { app, registry, mock } = await buildTestApp(FM3);
  const codec = createModernFractalCodec(FM3);
  const key = (f: readonly number[]) => f.join(',');
  // stored-preset dump requests → the scripted dump for that slot (everything else: silence)
  const dumps = new Map<string, number[][]>([
    [key(codec.buildRequestPresetDump(EMPTY_SLOT)), emptyDumpFrames(EMPTY_SLOT)],
    [key(codec.buildRequestPresetDump(BACKUP_SLOT)), emptyDumpFrames(BACKUP_SLOT)],
    [key(codec.buildRequestPresetDump(POPULATED_SLOT)), dumpAnswering(codec.buildRequestPresetDump(POPULATED_SLOT), framesOf(FM3_PRESET_5))]
  ]);
  mock.reply = (req) => (isIdentifyBroadcast(req) ? [handshakeReply(FM3)] : dumps.get(key(req)) ?? []);
  const router = createRouter({ registry, store: store.defaultStore });

  /** One request against both surfaces: same status, same JSON body. Returns the (app) status + body. */
  const both = async (
    name: string,
    method: 'GET' | 'POST',
    url: string,
    body?: unknown
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {})
    });
    const routed = await router.handle(method, url, body !== undefined ? JSON.stringify(body) : undefined);
    assertEqual(routed.status, res.statusCode, `${name}: router/app status parity (app body ${res.payload.slice(0, 160)})`);
    const appJson = JSON.parse(res.payload) as Record<string, unknown>;
    const routerJson = JSON.parse(String(routed.body)) as Record<string, unknown>;
    assert(deepEq(appJson, routerJson), `${name}: router/app body parity\napp:    ${res.payload}\nrouter: ${String(routed.body)}`);
    return { status: res.statusCode, json: appJson };
  };

  try {
    const modelName = PROFILES[FM3]!.name;

    // GET /presets/:n/summary on an empty slot → 200, an empty preset (both surfaces)
    const sum = await both('empty summary', 'GET', `/presets/${EMPTY_SLOT}/summary`);
    assertEqual(sum.status, 200, 'empty slot summary answers 200 (was 503 stack overflow)');
    assert(
      deepEq(sum.json, {
        number: EMPTY_SLOT, name: '', model: modelName, crcValid: false, crc: 0, empty: true,
        scenes: [], blocks: [], models: {}, amps: []
      }),
      `empty slot summary shape: ${JSON.stringify(sum.json)}`
    );
    assertEqual(sum.json.empty, true, 'empty slot summary carries empty:true');
    assertEqual(sum.json.crcValid, false, 'empty slot summary crcValid:false');

    // ?full=1 (cache build path) carries params:[] and still answers 200
    const full = await both('empty summary full', 'GET', `/presets/${EMPTY_SLOT}/summary?full=1`);
    assertEqual(full.status, 200, 'empty slot summary?full=1 answers 200');
    assert(deepEq(full.json.params, []), `empty slot summary?full=1 params: ${JSON.stringify(full.json.params)}`);

    // GET /presets/:n/params → 200 { blocks: [] }
    const params = await both('empty params', 'GET', `/presets/${EMPTY_SLOT}/params`);
    assertEqual(params.status, 200, 'empty slot params answers 200 (was 503 stack overflow)');
    assert(deepEq(params.json, { blocks: [] }), `empty slot params body: ${JSON.stringify(params.json)}`);

    // offline decode of an empty .syx (decodePresetBytes path) answers the same empty summary
    const flat = emptyDumpFrames(EMPTY_SLOT).flat();
    const dec = await both('empty decode (bytes)', 'POST', '/preset/decode', { bytes: flat });
    assertEqual(dec.status, 200, 'POST /preset/decode of an empty dump answers 200');
    assertEqual(dec.json.empty, true, 'decoded empty dump carries empty:true');
    assert(dec.json.name === '' && deepEq(dec.json.blocks, []) && deepEq(dec.json.params, []), `decoded empty dump: ${JSON.stringify(dec.json).slice(0, 200)}`);

    // backing up an empty slot is skipped cleanly (422, nothing stored) — not an exception / 503
    const bk = await both('empty backup', 'POST', `/backup/preset/${BACKUP_SLOT}`);
    assertEqual(bk.status, 422, 'backup of an empty slot is refused as empty/invalid (422), not a 503');
    assertEqual(store.defaultStore.listPresetVersions(BACKUP_SLOT).length, 0, 'no version stored for an empty slot');

    // a populated preset through the same driver is unchanged and never carries `empty`
    const pop = await both('populated summary', 'GET', `/presets/${POPULATED_SLOT}/summary`);
    assertEqual(pop.status, 200, 'populated slot summary answers 200');
    assert(!('empty' in pop.json), 'populated summary has no `empty` key (additive flag only on empty slots)');
    assertEqual(pop.json.crcValid, true, 'populated summary crcValid:true');
    assert(typeof pop.json.name === 'string' && (pop.json.name as string).length > 0, 'populated summary has a name');
    assert(Array.isArray(pop.json.blocks) && (pop.json.blocks as unknown[]).length > 0, 'populated summary has blocks');
    const popParams = await both('populated params', 'GET', `/presets/${POPULATED_SLOT}/params`);
    assertEqual(popParams.status, 200, 'populated slot params answers 200');
    assert(Array.isArray(popParams.json.blocks) && (popParams.json.blocks as unknown[]).length > 0, 'populated params has blocks');

    // POST /preset/backup (the verbatim .syx export DeviceTools saves to disk): an all-zero dump is not a
    // restorable preset, so an empty slot is refused with 422 on BOTH surfaces — not a 200 all-zero file
    // and not the generic 503 — while a populated slot still exports its dump.
    const pbEmpty = await both('empty /preset/backup', 'POST', '/preset/backup', { location: EMPTY_SLOT });
    assertEqual(pbEmpty.status, 422, 'POST /preset/backup of an empty slot is 422');
    assert(deepEq(pbEmpty.json, { error: 'empty preset slot' }), `empty /preset/backup body: ${JSON.stringify(pbEmpty.json)}`);
    const pbPop = await both('populated /preset/backup', 'POST', '/preset/backup', { location: POPULATED_SLOT });
    assertEqual(pbPop.status, 200, 'POST /preset/backup of a populated slot is 200');
    assert(typeof pbPop.json.name === 'string' && (pbPop.json.name as string).length > 0, 'populated /preset/backup carries the preset name');
    assertEqual((pbPop.json.bytes as number[]).length, FM3_PRESET_5.length, 'populated /preset/backup carries the full dump');

    // POST /preset/convert + /preset/convert/export (app only — the converter is server-side): an empty
    // source is refused with a clear 422 instead of "converting" to an empty preset (200) that the export
    // authoring path then rejects with a misleading validation failure.
    const emptyB64 = Buffer.from(emptyDumpFrames(EMPTY_SLOT).flat()).toString('base64');
    const cv = await app.inject({ method: 'POST', url: '/preset/convert', payload: { targetDevice: 'fm9', source: { syx: emptyB64 } } });
    assertEqual(cv.statusCode, 422, `convert of an empty source is 422 (${cv.payload.slice(0, 160)})`);
    assert(deepEq(cv.json(), { error: 'source preset slot is empty' }), `convert empty body: ${cv.payload}`);
    const ex = await app.inject({ method: 'POST', url: '/preset/convert/export', payload: { targetDevice: 'fm3', source: { syx: emptyB64 } } });
    assertEqual(ex.statusCode, 422, `convert/export of an empty source is 422 (${ex.payload.slice(0, 160)})`);
    assert(deepEq(ex.json(), { error: 'source preset slot is empty' }), `convert/export empty body: ${ex.payload}`);
    const cvPop = await app.inject({
      method: 'POST',
      url: '/preset/convert',
      payload: { targetDevice: 'fm9', source: { syx: Buffer.from(FM3_PRESET_5).toString('base64') } }
    });
    assertEqual(cvPop.statusCode, 200, `convert of a populated source stays 200 (${cvPop.payload.slice(0, 160)})`);

    // connected-driver convert: an empty current slot (the driver's dump export refuses it, or a driver
    // hands back an all-zero dump) maps to the same 422 ConvertError
    const refusing = { modelId: FM3, backupPreset: async () => { throw new EmptyPresetError(); } } as unknown as DeviceDriver;
    const handingBack = {
      modelId: FM3,
      backupPreset: async () => ({ location: 5, code: null, name: '', bytes: emptyDumpFrames(EMPTY_SLOT).flat() })
    } as unknown as DeviceDriver;
    for (const [what, d] of [['driver refuses', refusing], ['driver returns a zero dump', handingBack]] as const) {
      let err: unknown;
      try { await convertFromDriver(d, 'fm9'); } catch (e) { err = e; }
      assert(err instanceof ConvertError && err.statusCode === 422 && err.message === 'source preset slot is empty', `connected convert (${what}): ${String(err)}`);
    }

    // local Presets folder (app only): an empty-slot .syx is skipped, not listed under its file name
    const localRoot = mkdtempSync(join(tmpdir(), 'axis-empty-slot-'));
    try {
      const put = await app.inject({ method: 'PUT', url: '/local/config', payload: { root: localRoot } });
      assertEqual(put.statusCode, 200, 'local config set');
      writeFileSync(join(localRoot, 'Presets', 'Unused.syx'), Uint8Array.from(emptyDumpFrames(EMPTY_SLOT).flat()));
      writeFileSync(join(localRoot, 'Presets', 'Real.syx'), FM3_PRESET_5);
      const scan = (await app.inject({ method: 'GET', url: '/local/presets' })).json() as { entries: { path: string; name: string }[]; skipped: number };
      assert(scan.entries.length === 1 && scan.entries[0]!.path === 'Real.syx', `local scan lists only the real preset: ${JSON.stringify(scan.entries.map((e) => e.path))}`);
      assertEqual(scan.skipped, 1, 'local scan skips the empty-slot .syx');
    } finally {
      await app.inject({ method: 'PUT', url: '/local/config', payload: { root: null } });
      rmSync(localRoot, { recursive: true, force: true });
    }
  } finally {
    await app.close();
  }
}
