// GET /preset/blocks/:eid/curve on BOTH surfaces (app.ts and its runtime/router.ts twin) over the REAL
// gen-3 driver and a mocked FM3: the device-rendered `sub 0x23` curve decoded to 128 magnitudes, the
// default slot, the 400/501/503 gates, a 200 `null` when no reply matched (silence, another slot's
// frame, a bad checksum, a wrong declared count), app↔router parity, and the Looper waveform contract
// that shares this channel. Every device reply is built here by a synthetic MSB-first septet writer —
// a full-size curve reply is a real 609-byte frame, never a hand-padded array.
import '../helpers/env.js'; // MUST stay first — isolates ~/.forgefx-conn / data dir before transport loads
import { buildGraphCurvePoll } from 'forgefx-midi/gen3/axe-fx-iii';
import { createRouter, type RouterResponse } from '../../src/runtime/router.js';
import * as store from '../../src/store.js';
import { buildTestApp, deepEqual } from '../helpers/api.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const PRESET_CURVE_CASE_COUNT = 8;

const FM3 = 0x11;
const CURVE_EID = 62;
const LOOPER_EID = 166;

/** Pack bytes into one continuous MSB-first 7-bit stream — the payload container of a `sub 0x23` reply. */
function septets(bytes: readonly number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 7) {
      bits -= 7;
      out.push((acc >>> bits) & 0x7f);
    }
  }
  if (bits > 0) out.push((acc << (7 - bits)) & 0x7f);
  return out;
}

const checksum = (bytes: readonly number[]): number => bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;

/** A real `sub 0x23` reply: 21-byte header, the float32-LE values in one septet stream, checksum + F7.
 *  128 values declare 512 payload bytes and make the frame exactly 609 bytes. `count` overrides the
 *  declared byte count only (a length that no longer matches the stream). */
function curveFrame(opts: { eid: number; slot: number; values: readonly number[]; count?: number; model?: number }): number[] {
  const payload = new Uint8Array(opts.values.length * 4);
  const view = new DataView(payload.buffer);
  opts.values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  const count = opts.count ?? payload.length;
  const head = [
    0xf0, 0x00, 0x01, 0x74, opts.model ?? FM3, 0x01, 0x23, 0x00,
    opts.eid & 0x7f, (opts.eid >> 7) & 0x7f,
    opts.slot & 0x7f, (opts.slot >> 7) & 0x7f,
    0, 0, 0, 0, 0, // revision word
    0, 0, // status: 0 = data follows
    count & 0x7f, (count >> 7) & 0x7f,
  ];
  const body = [...head, ...septets(payload)];
  return [...body, checksum(body), 0xf7];
}

/** 128 device magnitudes with exact float32 values worth pinning (0, 0.25, 1, 2.25, 0.75). */
const CURVE_VALUES = Array.from({ length: 128 }, (_, i) => (i === 1 ? 0.25 : i === 2 ? 1 : i === 3 ? 2.25 : i === 127 ? 0.75 : 0));
/** The looper's envelope can exceed 1; -0.5 and 2.25 pin both clamps. */
const WAVE_VALUES = Array.from({ length: 128 }, (_, i) => (i === 1 ? 0.5 : i === 2 ? 1.5 : i === 3 ? 2.25 : i === 4 ? -0.5 : 0));

const isCurvePoll = (f: readonly number[]): boolean => f[5] === 0x01 && f[6] === 0x23;

export async function runPresetCurveTests(): Promise<void> {
  const { app, registry, mock } = await buildTestApp(FM3);
  try {
    const serve = (frame: number[] | null): void => {
      mock.reply = (req) => (isCurvePoll(req) && frame ? [frame] : []);
    };
    const driver = await registry.driver();
    const router = createRouter({ registry, store: store.defaultStore });
    const appBody = async (url: string) => {
      const res = await app.inject({ method: 'GET', url });
      return { status: res.statusCode, json: res.json() as unknown };
    };
    const routerBody = async (url: string): Promise<{ status: number; json: unknown }> => {
      const routed: RouterResponse = await router.handle('GET', url);
      return { status: routed.status, json: JSON.parse(routed.body as string) as unknown };
    };
    const parity = async (url: string): Promise<{ status: number; json: unknown }> => {
      const a = await appBody(url);
      const r = await routerBody(url);
      assertEqual(r.status, a.status, `${url}: router/app status parity`);
      assert(deepEqual(r.json, a.json), `${url}: router/app body parity\napp:    ${JSON.stringify(a.json)}\nrouter: ${JSON.stringify(r.json)}`);
      return a;
    };

    // 1 — the driver itself: the poll carries (eid, slot, model byte) and the reply decodes to 128 values
    serve(curveFrame({ eid: CURVE_EID, slot: 1, values: CURVE_VALUES }));
    mock.sent.length = 0;
    const direct = await driver.blockCurve!(CURVE_EID, 1);
    assertEqual(JSON.stringify(direct), JSON.stringify({ eid: CURVE_EID, slot: 1, values: CURVE_VALUES }), 'driver blockCurve decodes the full-size reply');
    assertEqual(JSON.stringify(mock.sent), JSON.stringify([buildGraphCurvePoll(CURVE_EID, 1, FM3)]), 'driver sends the codec curve poll (eid, slot, model byte)');
    let threw = false;
    try { await driver.blockCurve!(CURVE_EID, 4); } catch { threw = true; }
    assert(threw, 'driver blockCurve refuses slot 4 (0..3 only)');
    assertEqual(mock.sent.length, 1, 'an out-of-range slot never reaches the wire');

    // 2 — the route defaults `slot` to 0
    serve(curveFrame({ eid: CURVE_EID, slot: 0, values: CURVE_VALUES }));
    mock.sent.length = 0;
    const dflt = await parity(`/preset/blocks/${CURVE_EID}/curve`);
    assertEqual(dflt.status, 200, 'default slot: status');
    assertEqual(JSON.stringify(dflt.json), JSON.stringify({ eid: CURVE_EID, slot: 0, values: CURVE_VALUES }), 'default slot: slot 0 served');
    assertEqual(JSON.stringify(mock.sent), JSON.stringify([buildGraphCurvePoll(CURVE_EID, 0, FM3), buildGraphCurvePoll(CURVE_EID, 0, FM3)]), 'default slot: both surfaces polled slot 0');

    // 3 — an explicit slot reaches the wire and the answer
    serve(curveFrame({ eid: CURVE_EID, slot: 2, values: CURVE_VALUES }));
    const explicit = await parity(`/preset/blocks/${CURVE_EID}/curve?slot=2`);
    assertEqual(explicit.status, 200, 'slot=2: status');
    assertEqual((explicit.json as { slot: number }).slot, 2, 'slot=2: answer carries the requested slot');
    assertEqual(JSON.stringify(mock.sent.at(-1)), JSON.stringify(buildGraphCurvePoll(CURVE_EID, 2, FM3)), 'slot=2: polled slot 2');

    // 4 — 400 on a non-finite eid / an out-of-range slot, with nothing sent
    for (const url of [`/preset/blocks/abc/curve`, `/preset/blocks/${CURVE_EID}/curve?slot=4`, `/preset/blocks/${CURVE_EID}/curve?slot=-1`, `/preset/blocks/${CURVE_EID}/curve?slot=1.5`, `/preset/blocks/${CURVE_EID}/curve?slot=x`]) {
      mock.sent.length = 0;
      const r = await parity(url);
      assertEqual(r.status, 400, `${url}: 400`);
      assertEqual(mock.sent.length, 0, `${url}: nothing sent`);
    }

    // 5 — no reply matched is a 200 null (silence, another slot's frame, bad checksum, wrong count)
    const noReply: [string, number[] | null][] = [
      ['silence', null],
      ['another slot', curveFrame({ eid: CURVE_EID, slot: 3, values: CURVE_VALUES })],
      ['bad checksum', (() => { const f = curveFrame({ eid: CURVE_EID, slot: 0, values: CURVE_VALUES }); f[f.length - 2] = (f[f.length - 2]! ^ 0x01) & 0x7f; return f; })()],
      ['wrong count', curveFrame({ eid: CURVE_EID, slot: 0, values: CURVE_VALUES, count: 508 })],
    ];
    for (const [label, frame] of noReply) {
      serve(frame);
      mock.sent.length = 0;
      const r = await parity(`/preset/blocks/${CURVE_EID}/curve?slot=0`);
      assertEqual(r.status, 200, `${label}: 200`);
      assertEqual(r.json, null, `${label}: null body`);
      assertEqual(mock.sent.length, 2, `${label}: both surfaces made the request`);
    }

    // 6 — capability gate: an AM4 has no curve channel → 501 on both surfaces, no traffic
    const am4 = await buildTestApp(0x15);
    try {
      const a = await am4.app.inject({ method: 'GET', url: `/preset/blocks/${CURVE_EID}/curve` });
      assertEqual(a.statusCode, 501, 'AM4: 501');
      assertEqual(JSON.stringify(a.json()), JSON.stringify({ error: 'unsupported', capability: 'graphCurves' }), 'AM4: unsupported body');
      const am4Router = createRouter({ registry: am4.registry, store: store.defaultStore });
      const r = await am4Router.handle('GET', `/preset/blocks/${CURVE_EID}/curve`);
      assertEqual(r.status, 501, 'AM4 router: 501');
      assertEqual(r.body, a.payload, 'AM4: router/app body parity');
      assertEqual(am4.mock.sent.filter(isCurvePoll).length, 0, 'AM4: no curve poll');
    } finally {
      await am4.app.close();
    }

    // 7 — a driver/transport error is a 503 (message preserved) on both surfaces
    mock.reply = (req) => {
      if (isCurvePoll(req)) throw new Error('link lost');
      return [];
    };
    const failed = await parity(`/preset/blocks/${CURVE_EID}/curve`);
    assertEqual(failed.status, 503, 'driver error: 503');
    assertEqual((failed.json as { error: string }).error, 'link lost', 'driver error: message preserved');

    // 8 — the Looper waveform is the same channel at slot 0: 128 device magnitudes clamped to 0..1
    serve(curveFrame({ eid: LOOPER_EID, slot: 0, values: WAVE_VALUES }));
    mock.sent.length = 0;
    const looper = await parity(`/preset/looper?eid=${LOOPER_EID}`);
    assertEqual(looper.status, 200, 'looper: status');
    const wave = (looper.json as { wave: number[] }).wave;
    assertEqual(wave.length, 128, 'looper: 128 waveform values');
    assertEqual(wave[1], 0.5, 'looper: a value inside 0..1 passes through');
    assertEqual(wave[2], 1, 'looper: 1.5 clamps to 1');
    assertEqual(wave[3], 1, 'looper: 2.25 clamps to 1');
    assertEqual(wave[4], 0, 'looper: -0.5 clamps to 0');
    assertEqual(Math.max(...wave), 1, 'looper: nothing above 1');
    assertEqual(JSON.stringify(mock.sent.filter(isCurvePoll)), JSON.stringify([buildGraphCurvePoll(LOOPER_EID, 0, FM3), buildGraphCurvePoll(LOOPER_EID, 0, FM3)]), 'looper: both surfaces polled the waveform at slot 0');
  } finally {
    await app.close();
  }
}
