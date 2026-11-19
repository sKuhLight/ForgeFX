// Send policy for client-supplied bytes (drivers/sendPolicy.ts), over the REAL buildApp + gen-3 FM3 driver on a
// mocked transport — every refusal must leave the transport untouched:
//   • POST /debug/raw: only ONE read/query frame (≤512 B) for a known Fractal model passes; firmware/update/
//     erase/dump/IR functions and writes → 403, non-Fractal SysEx and unknown models → 403, malformed /
//     multi-frame / oversize → 400. Re-checked centrally in DeviceRegistry.rawRequest() (before the
//     transport is even opened). The Browser-Direct router exposes no raw route (404).
//     Connected gen-3 unit: frames byte-identical to the codec read/poll builders for THAT model also pass.
//   • POST /preset/load, /version/:id/load, /version/:id/restore (app + router twin): only ONE well-formed
//     preset dump for the CONNECTED model is sent; crafted payloads → 400.
//   • POST /preset/restore + /am4/preset/restore (AM4 / gen-2, app + router twin): only preset-dump frames for
//     the connected model, split at their own boundaries — a frame hidden in a chunk → 400, nothing sent.
import '../helpers/env.js'; // MUST stay first — isolates ~/.forgefx-conn / data dir before transport loads
import { serializePresetDump, parsePresetDump, type ParsedPresetDump } from 'forgefx-midi/devices/gen3';
import {
  buildTunerPoll, buildCpuPoll, buildOutputMeterPoll, GEN3_OUTPUT_METERS, buildGetRawParamValue, createModernFractalCodec
} from 'forgefx-midi/gen3/axe-fx-iii';
import { buildIdentifyBroadcast } from 'forgefx-midi/shared';
import { parseAm4PresetDump } from 'forgefx-midi/am4';
import { buildTestApp } from '../helpers/api.js';
import { createRouter } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import { __createRegistryForTest } from '../../src/drivers/registry.js';
import { SendRejectedError, RAW_PROBE_MAX_BYTES } from '../../src/drivers/sendPolicy.js';
import { MockTransport, assert, assertEqual, hex } from '../helpers/mock.js';

/** A checksummed Fractal frame `F0 00 01 74 <model> <fn> <payload…> cs F7`. */
function frame(model: number, fn: number, payload: number[] = []): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}
const toHex = (bytes: readonly number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

/** A structurally valid gen-3 preset dump (1 chunk) for `model`; `chunkByte` lets a test plant a byte. */
function dump(model: number, chunkByte?: { at: number; value: number }): number[] {
  const chunk = new Uint8Array(3074);
  if (chunkByte) chunk[chunkByte.at] = chunkByte.value;
  const parsed = { modelId: model, headerPayload: Uint8Array.from([0x00, 0x05, 0x00, 0x00, 0x00]), chunkPayloads: [chunk], footerPayload: new Uint8Array(3) };
  return Array.from(serializePresetDump(parsed as unknown as ParsedPresetDump));
}

/** A 6-frame AM4 dump (0x77 + 4×0x78 + 0x79). With `smuggle`, chunk 1 ends in `F7 F0 00 01 74 15 7D 00`
 *  and payload[0] is tuned so the chunk's checksum is ALSO the hidden 0x7D frame's checksum: the codec's
 *  fixed-length parser accepts it, while a frame splitter would emit a standalone 0x7D frame. */
function am4Dump(smuggle = false): number[] {
  const chunks: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const p = new Array<number>(3074).fill(0);
    if (smuggle && i === 0) {
      const inner = [0xf0, 0x00, 0x01, 0x74, 0x15, 0x7d, 0x00];
      const at = p.length - inner.length - 1;
      p[at] = 0xf7;
      inner.forEach((b, k) => { p[at + 1 + k] = b; });
      let a = 0;
      for (const b of [0xf0, 0x00, 0x01, 0x74, 0x15, 0x78, ...p.slice(0, at + 1)]) a ^= b;
      p[0] = p[0]! ^ (a & 0x7f); // XOR of everything before the hidden F0 becomes 0 (mod 0x80)
    }
    chunks.push(frame(0x15, 0x78, p));
  }
  return [...frame(0x15, 0x77, [0x00, 0x01, 0x00, 0x00, 0x00]), ...chunks.flat(), ...frame(0x15, 0x79, [0x00, 0x00, 0x00])];
}

export const SEND_POLICY_CASE_COUNT = 15;

export async function runSendPolicyTests(): Promise<void> {
  const { app, registry, mock } = await buildTestApp(0x11); // FM3, real gen-3 driver
  const router = createRouter({ registry, store: store.defaultStore });
  const raw = (payload: unknown) => app.inject({ method: 'POST', url: '/debug/raw', payload: payload as object });
  const load = (bytes: readonly number[]) =>
    app.inject({ method: 'POST', url: '/preset/load', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(bytes) });
  // versions this suite adds to the shared default store — removed again in `finally` (later suites count them)
  const added: store.PresetVersion[] = [];
  /** Run `fn` and assert the mock transport recorded nothing meanwhile. */
  const untouched = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const before = mock.sent.length;
    const r = await fn();
    assertEqual(mock.sent.length, before, `${label}: reached the transport`);
    return r;
  };
  try {
    // 1 — /debug/raw: firmware / update / erase / dump / IR functions and writes → 403, per family
    const refused: Array<[number, number[]]> = [
      [0x11, [0x79, 0x7d, 0x7e, 0x7f, 0x77, 0x78, 0x7a, 0x7b, 0x7c, 0x01, 0x0a, 0x0c, 0x12]], // FM3
      [0x10, [0x79, 0x7d, 0x7e, 0x7f]], [0x12, [0x79, 0x7d, 0x7e, 0x7f]], [0x14, [0x79, 0x7d, 0x7e, 0x7f]],
      [0x07, [0x25, 0x26, 0x27, 0x34, 0x60, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x73, 0x7d, 0x7e, 0x02, 0x1d]], // Axe-Fx II XL+
      [0x15, [0x79, 0x7d, 0x7e, 0x7f, 0x01]], // AM4
      [0x7f, [0x08, 0x7d]] // broadcast: identify only
    ];
    for (const [model, fns] of refused) {
      for (const fn of fns) {
        const label = `raw fn 0x${fn.toString(16)} @ model 0x${model.toString(16)}`;
        const r = await untouched(label, () => raw({ hex: toHex(frame(model, fn, [0x00, 0x00])) }));
        assertEqual(r.statusCode, 403, `${label} status`);
        assert(/read\/query/.test((r.json() as { error: string }).error), `${label}: 403 names the read-only rule`);
      }
    }

    // 2 — non-Fractal SysEx and unknown model bytes → 403 (header allowlist)
    for (const [label, bytes] of [
      ['universal identity request', [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]],
      ['foreign manufacturer', [0xf0, 0x43, 0x10, 0x4c, 0x00, 0x00, 0x7e, 0x00, 0xf7]],
      ['unknown model byte', frame(0x42, 0x1f, [0x3a, 0x00])]
    ] as Array<[string, number[]]>) {
      const r = await untouched(label, () => raw({ hex: toHex(bytes) }));
      assertEqual(r.statusCode, 403, `${label} status`);
    }

    // 3 — malformed hex / not exactly one SysEx frame / oversize → 400
    const big = frame(0x11, 0x1f, new Array(RAW_PROBE_MAX_BYTES).fill(0x00));
    for (const [label, body] of [
      ['odd length', { hex: 'f00001741108' + '0' }],
      ['non-hex digits', { hex: 'f0zz01741108f7' }],
      ['empty string', { hex: '' }],
      ['missing hex', {}],
      ['hex not a string', { hex: 1234 }],
      ['non-ASCII whitespace', { hex: toHex(frame(0x11, 0x08)).replace('f0', 'f0 ') }],
      ['no F0 start', { hex: '0001741108f7' }],
      ['unterminated frame', { hex: 'f0000174110800' }],
      ['header split for a follow-up request', { hex: 'f000017411' }],
      ['8-bit data byte inside a frame', { hex: 'f00001741108' + '80' + 'f7' }],
      ['two query frames in one request', { hex: toHex([...frame(0x11, 0x08), ...frame(0x11, 0x0d, [0x7f])]) }],
      ['query + firmware frame', { hex: toHex([...frame(0x11, 0x08), ...frame(0x11, 0x7d)]) }],
      [`one frame over ${RAW_PROBE_MAX_BYTES} bytes`, { hex: toHex(big) }]
    ] as Array<[string, unknown]>) {
      const r = await untouched(label, () => raw(body));
      assertEqual(r.statusCode, 400, `${label} status`);
    }

    // 4 — benign read/query frames pass through to the transport; reply frames return as hex
    for (const q of [frame(0x11, 0x08), frame(0x11, 0x1f, [0x3a, 0x00]), frame(0x7f, 0x00)]) {
      const reply = frame(0x11, q[5]!, [0x0c, 0x00]);
      const prev = mock.reply;
      mock.reply = (req) => (hex(req) === hex(q) ? [reply] : prev(req));
      try {
        const r = await raw({ hex: toHex(q).toUpperCase().replace(/(..)/g, '$1 ').trim() }); // spaced upper-case hex is fine
        assertEqual(r.statusCode, 200, `query fn 0x${q[5]!.toString(16)} status`);
        assertEqual(hex(mock.sent[mock.sent.length - 1] ?? []), hex(q), 'query frame recorded by the transport');
        assertEqual((r.json() as { frames: string[] }).frames.join(','), toHex(reply), 'reply frames returned as hex');
      } finally {
        mock.reply = prev;
      }
    }

    // 5 — central guard: rawRequest() itself refuses (route bypassed) without writing to the transport
    for (const [bytes, status] of [
      [frame(0x11, 0x7d), 403], [frame(0x07, 0x26), 403], [frame(0x11, 0x79, [0, 0, 0]), 403],
      [[0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7], 403], [[0x01, 0x02], 400], [[...frame(0x11, 0x08), ...frame(0x11, 0x08)], 400]
    ] as Array<[number[], number]>) {
      let err: unknown = null;
      await untouched(`rawRequest(${toHex(bytes)})`, async () => {
        try { await registry.rawRequest(bytes); } catch (e) { err = e; }
      });
      assert(err instanceof SendRejectedError && err.status === status, `rawRequest(${toHex(bytes)}) did not throw ${status}`);
    }

    // 6 — central guard runs before the transport is even opened (fresh registry, no detection yet)
    {
      const fresh = new MockTransport('serial', 'mock-fresh');
      let opens = 0;
      const reg = __createRegistryForTest({
        resolveConn: async () => ({ transport: 'serial', id: fresh.label }),
        openConn: () => { opens++; return fresh; }
      });
      for (const fn of [0x79, 0x7d, 0x7e, 0x7f, 0x01]) {
        let threw = false;
        try { await reg.rawRequest(frame(0x11, fn)); } catch (e) { threw = e instanceof SendRejectedError; }
        assert(threw, `fresh rawRequest(fn 0x${fn.toString(16)}) did not throw`);
      }
      assertEqual(opens, 0, 'refused raw frames opened the transport');
      assertEqual(fresh.sent.length, 0, 'refused raw frames were sent');
      await reg.rawRequest(frame(0x11, 0x08)); // a query frame opens + sends normally
      assertEqual(opens, 1, 'query frame opened the transport once');
      assertEqual(hex(fresh.sent[0] ?? []), hex(frame(0x11, 0x08)), 'query frame sent verbatim');
    }

    // 7 — Browser-Direct twin: the runtime router has no raw-send route — 404, nothing sent
    for (const fn of [0x7d, 0x08]) {
      const r = await untouched(`router /debug/raw fn 0x${fn.toString(16)}`, () =>
        router.handle('POST', '/debug/raw', JSON.stringify({ hex: toHex(frame(0x11, fn)) })));
      assertEqual(r.status, 404, 'router POST /debug/raw status');
    }

    // 8 — /preset/load: one valid FM3 dump is sent, retargeted to the edit buffer, nothing else
    const good = dump(0x11);
    {
      const r = await load(good);
      assertEqual(r.statusCode, 200, 'valid FM3 dump status');
      const sent = mock.sent[mock.sent.length - 1] ?? [];
      assertEqual(sent.length, good.length, 'sent exactly the dump bytes');
      assert(sent[5] === 0x77 && sent[6] === 0x7f && sent[7] === 0x7f, 'header retargeted to the edit buffer (7F 7F)');
      parsePresetDump(Uint8Array.from(sent), 0, 0x11); // still a well-formed FM3 dump on the wire
      assertEqual(hex(sent.slice(13)), hex(good.slice(13)), 'chunks + footer sent verbatim');
    }

    // 9 — /preset/load crafted payloads → 400, nothing sent (app AND router twin)
    const fw = frame(0x11, 0x7d, [0x01, 0x02, 0x03]);
    const crafted: Array<[string, number[]]> = [
      ['bare firmware frame', fw],
      ['dump + trailing firmware frame', [...good, ...fw]],
      ['firmware frame + dump', [...fw, ...good]],
      ['dump for another model (FM9 on FM3)', dump(0x12)],
      ['two dumps (bank)', [...good, ...good]],
      ['8-bit byte (F0) hidden in a chunk', dump(0x11, { at: 100, value: 0xf0 })],
      ['query frame instead of a dump', frame(0x11, 0x08)]
    ];
    for (const [label, bytes] of crafted) {
      const r = await untouched(`/preset/load ${label}`, () => load(bytes));
      assertEqual(r.statusCode, 400, `/preset/load ${label} status`);
      const rr = await untouched(`router /preset/load ${label}`, () => router.handle('POST', '/preset/load', Uint8Array.from(bytes)));
      assertEqual(rr.status, 400, `router /preset/load ${label} status`);
    }

    // 10 — /version/:id/load + /restore: crafted store bytes → 400, nothing sent (no load, no store frame)
    {
      const bad = store.defaultStore.addPresetVersion({ location: 41, crc: 1, name: 'crafted', model: 'FM3', source: 'manual' }, Uint8Array.from([...good, ...fw]));
      assert(bad, 'crafted version stored');
      added.push(bad);
      for (const action of ['load', 'restore']) {
        const r = await untouched(`/version/${action} crafted`, () => app.inject({ method: 'POST', url: `/version/${bad.id}/${action}` }));
        assertEqual(r.statusCode, 400, `/version/:id/${action} crafted status`);
        const rr = await untouched(`router /version/${action} crafted`, () => router.handle('POST', `/version/${bad.id}/${action}`));
        assertEqual(rr.status, 400, `router /version/:id/${action} crafted status`);
      }
    }

    // 11 — /version/:id/load with a valid stored FM3 dump still goes out
    {
      const ok = store.defaultStore.addPresetVersion({ location: 42, crc: 2, name: 'valid', model: 'FM3', source: 'manual' }, Uint8Array.from(good));
      assert(ok, 'valid version stored');
      added.push(ok);
      const before = mock.sent.length;
      const r = await app.inject({ method: 'POST', url: `/version/${ok.id}/load` });
      assertEqual(r.statusCode, 200, 'valid version load status');
      assertEqual(mock.sent.length, before + 1, 'valid version sent once');
    }

    // 12 — connected FM3: frames byte-identical to the codec read/poll builders pass (incl. everything the
    //      FM3 golden-capture script sends); the same frames for another model and any variant do not
    {
      const c = createModernFractalCodec(0x11);
      const polls: Array<[string, number[]]> = [
        ['identify broadcast', buildIdentifyBroadcast()],
        ['status dump', c.buildStatusDump()],
        ['tuner poll', buildTunerPoll(0x11)],
        ['CPU poll', buildCpuPoll(0x11)],
        ...GEN3_OUTPUT_METERS.map((m): [string, number[]] => [`meter ${m.role}`, buildOutputMeterPoll(m, 0x11)]),
        ['tempo GET', c.buildGetTempo()],
        ['scene GET', c.buildGetScene()],
        ['FC raw-value GET 0x1B', buildGetRawParamValue(199, 300, 0x11)]
      ];
      for (const [label, f] of polls) {
        const before = mock.sent.length;
        const r = await raw({ hex: toHex(f) });
        assertEqual(r.statusCode, 200, `poll ${label} status`);
        assertEqual(mock.sent.length, before + 1, `poll ${label} sent once`);
      }
      const c10 = createModernFractalCodec(0x10);
      const pollsNot: Array<[string, number[]]> = [
        ['tuner poll for model 0x10', buildTunerPoll(0x10)],
        ['tempo GET for model 0x10', c10.buildGetTempo()],
        ['FC raw-value GET for model 0x10', buildGetRawParamValue(199, 300, 0x10)],
        ['tempo SET', c.buildSetTempo(120)],
        ['scene SET', c.buildSetScene(2)],
        ['param GET (generic 0x01)', c.buildGetParameter(58, 1)],
        ['raw-value GET with non-zero padding', frame(0x11, 0x01, [0x1b, 0x00, 0x47, 0x01, 0x2c, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0x01])],
        ['empty-payload tempo frame', frame(0x11, 0x14)]
      ];
      for (const [label, f] of pollsNot) {
        const r = await untouched(`poll ${label}`, () => raw({ hex: toHex(f) }));
        assertEqual(r.statusCode, 403, `poll ${label} status`);
      }
    }
  } finally {
    store.defaultBackend.deleteVersions(added.map((v) => v.id));
    for (const v of added) store.defaultBackend.deleteBlob(v.hash);
    await app.close();
  }

  // 13–15 — /preset/restore on AM4: a chunk with a hidden 0x7D frame passes the codec's fixed-length parser
  //         but is refused before the driver (app, deprecated alias, router twin); a clean dump still restores
  {
    const smuggled = am4Dump(true);
    parseAm4PresetDump(Uint8Array.from(smuggled)); // the gap: fixed-length + checksum parse accepts it
    const a = await buildTestApp(0x15); // AM4, real driver
    const am4Router = createRouter({ registry: a.registry, store: store.defaultStore });
    const untouchedAm4 = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const before = a.mock.sent.length;
      const r = await fn();
      assertEqual(a.mock.sent.length, before, `${label}: reached the transport`);
      return r;
    };
    try {
      const crafted: Array<[string, number[]]> = [
        ['hidden 0x7D frame in a chunk', smuggled],
        ['bare firmware frame', frame(0x15, 0x7d, [0x01])],
        ['clean dump + trailing firmware frame', [...am4Dump(), ...frame(0x15, 0x7e, [0x01])]],
        ['FM3 dump on an AM4', dump(0x11)],
        ['8-bit byte in a chunk', (() => { const d = am4Dump(); d[100] = 0x80; return d; })()]
      ];
      for (const [label, bytes] of crafted) {
        for (const url of ['/preset/restore', '/am4/preset/restore']) {
          const r = await untouchedAm4(`${url} ${label}`, () => a.app.inject({ method: 'POST', url, payload: { bytes } }));
          assertEqual(r.statusCode, 400, `${url} ${label} status`);
        }
        const rr = await untouchedAm4(`router /preset/restore ${label}`, () =>
          am4Router.handle('POST', '/preset/restore', JSON.stringify({ bytes })));
        assertEqual(rr.status, 400, `router /preset/restore ${label} status`);
      }
      const before = a.mock.sent.length;
      const ok = await a.app.inject({ method: 'POST', url: '/preset/restore', payload: { bytes: am4Dump() } });
      assertEqual(ok.statusCode, 200, 'clean AM4 dump restore status');
      assertEqual(a.mock.sent.length, before + 6, 'clean AM4 dump sent as its 6 frames');
    } finally {
      await a.app.close();
    }

    // gen-2 (Axe-Fx II XL+) shares the restore handler: a firmware frame never reaches its driver
    const g = await buildTestApp(0x07);
    try {
      const before = g.mock.sent.length;
      const r = await g.app.inject({ method: 'POST', url: '/preset/restore', payload: { bytes: frame(0x07, 0x7d, [0x01]) } });
      assertEqual(r.statusCode, 400, 'gen-2 /preset/restore firmware frame status');
      assertEqual(g.mock.sent.length, before, 'gen-2 /preset/restore firmware frame reached the transport');
    } finally {
      await g.app.close();
    }
  }
}
