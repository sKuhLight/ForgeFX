// scripts/profile-check.ts — the offline document tools (M3 WP-F7: --rederive, --diff, --merge <doc2>, --blocks) and the
// unchanged offline check, through the exported `runProfileCheck(argv)` (no subprocess, no process.exit). Covers:
//   - a plain offline run of the catalog read back as a profile: exit 0, and the JSON document carries exactly the keys
//     it always had (the tools' sections and `inputErrors` appear only when a tool is asked for);
//   - --rederive: a format-2 document derived from raw sources re-derives to equal tables (exit 0); a tampered derived
//     row is a per-family mismatch (exit 1); raw sources that no longer derive are a finding with the message; a
//     format-1 document reports `no-raw` without a finding;
//   - --diff: the catalog document has an empty diff (state none); the synthetic newer firmware with the golden's
//     placed blocks (--eid) gives exactly the definitions-diff golden (test/fixtures/definitions-diff/newer.json);
//   - --merge: an editor-cache document merged with a live walk keeps both sources, reports provenance and coverage and
//     runs the invariants on the result; another model, a format-1 document and a source of another firmware are
//     refused (exit 2);
//   - --blocks: the probed block's confirmed entry, the unassigned sections, the placed block that maps nowhere; a
//     confirmed entry whose key has no rows is a finding; the Axe-Fx III's roster-only ids;
//   - usage: a tool without --profile is a usage error (exit 2).
// Committed catalog data and synthetic data only; the documents are written to the per-process test data dir.
import '../helpers/env.js'; // MUST be first — points the conn override + data dir at throwaway paths
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BlockMapEntry, ProfileDoc } from 'forgefx-midi/cache';
import { runProfileCheck, type ProfileCheckResult } from '../../scripts/profile-check.js';
import { assert, assertEqual } from '../helpers/mock.js';
import { catalogBuilt } from '../helpers/catalogProfile.js';
import { NEWER_FIRMWARE, NEWER_FIRMWARE_DIFF, newerFirmwareDoc } from '../helpers/newerFirmware.js';
import { FM3, clone, editorCacheSource, liveSeedRecords, liveSource, profileDoc } from '../helpers/profileDocs.js';

const CASES: Array<[string, () => void | Promise<void>]> = [
  ['plain offline run: exit 0, the JSON keys it always had', plainRun],
  ['--rederive: equal, tampered row, derivation failure, format-1 no-raw', rederive],
  ['--diff: catalog empty, newer firmware = the definitions-diff golden', diff],
  ['--merge: two compatible documents, refusals exit 2', merge],
  ['--blocks: block map, unassigned sections, unmapped eids, inconsistency, III roster', blocks],
  ['usage: a document tool without --profile', usage]
];
export const PROFILE_CHECK_CASE_COUNT = CASES.length;

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

const DIR = join(process.env.FORGEFX_DATA_DIR!, 'profile-check');
const GOLDEN = fileURLToPath(new URL('../fixtures/definitions-diff/newer.json', import.meta.url));

/** Write `doc` as a bare profile document file and return its path. */
function file(name: string, doc: unknown): string {
  mkdirSync(DIR, { recursive: true });
  const p = join(DIR, `${name}.json`);
  writeFileSync(p, JSON.stringify(doc));
  return p;
}

/** Run the script quietly (the runtime profile's suspect warning goes to console.warn). */
async function run(...argv: string[]): Promise<ProfileCheckResult> {
  const w = console.warn;
  console.warn = () => {};
  try { return await runProfileCheck(argv); } finally { console.warn = w; }
}

/** `--json` run: the JSON document (throws when there is none). */
async function json(...argv: string[]): Promise<{ r: ProfileCheckResult; j: Record<string, any> }> {
  const r = await run(...argv, '--json');
  assert(r.json, `no JSON document (exit ${r.exitCode}): ${r.stderr}`);
  return { r, j: r.json as Record<string, any> };
}

const codes = (j: Record<string, any>, list: 'failures' | 'warnings' | 'inputErrors' = 'failures'): string[] => (j[list] as { code: string }[]).map((f) => f.code);

/** JSON text with every object's keys sorted (a DTO against its golden, whatever the key order). */
function canon(v: unknown): string {
  const sort = (x: unknown): unknown => Array.isArray(x)
    ? x.map(sort)
    : x !== null && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(sort(JSON.parse(JSON.stringify(v))));
}

// the documents (built once)
let docs: { catalog: string; ec: string; ecDoc: ProfileDoc; live: string; newer: string } | null = null;
async function fixtures(): Promise<NonNullable<typeof docs>> {
  if (docs) return docs;
  const ecDoc = profileDoc([await editorCacheSource()]);
  docs = {
    catalog: file('catalog', catalogBuilt(FM3)),
    ec: file('editor-cache', ecDoc),
    ecDoc,
    live: file('live', profileDoc([liveSource(liveSeedRecords())])),
    newer: file('newer', newerFirmwareDoc())
  };
  return docs;
}

// ── cases ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function plainRun(): Promise<void> {
  const d = await fixtures();
  const r = await run('--profile', d.catalog);
  assertEqual(r.exitCode, 0, 'catalog document: exit 0');
  assert(r.stdout.startsWith(`Offline check of ${d.catalog}`), 'the offline report heads the output');
  assert(r.stdout.endsWith('RESULT: all invariants hold'), 'the result line ends the output');
  assert(!/Re-derivation|Definitions diff|Merge \(|Block map/.test(r.stdout), 'no tool section without a tool flag');
  const { r: jr, j } = await json('--profile', d.catalog);
  assertEqual(jr.stdout, JSON.stringify(j, null, 2), 'stdout is the JSON document');
  assertEqual(Object.keys(j).join(','), 'ok,failures,warnings,transportErrors,offline,online', 'the JSON keys of a plain run are unchanged');
  assertEqual(j.ok, true, 'ok');
  assertEqual(j.offline.shape, 'profile', 'a bare document');
}

async function rederive(): Promise<void> {
  const d = await fixtures();
  // equal: a document the server derived from its raw sources
  let { r, j } = await json('--profile', d.ec, '--rederive');
  assertEqual(r.exitCode, 0, 'equal: exit 0');
  assertEqual(j.rederive.status, 'equal', 'equal: status');
  assertEqual(j.rederive.format, 2, 'equal: format 2');
  assertEqual(j.rederive.onLoad, null, 'a current document is used as stored');
  assert(j.rederive.families.compared > 0 && j.rederive.families.differing === 0, 'every family key compared, none differs');
  assert(j.rederive.parts.length > 0 && j.rederive.parts.every((p: { equal: boolean }) => p.equal), 'every other derived part equal');
  assertEqual(j.rederive.sources.length, 1, 'one raw source');
  assertEqual(JSON.stringify(j.inputErrors), '[]', 'a tool run carries inputErrors');
  const text = await run('--profile', d.ec, '--rederive');
  assert(text.stdout.includes('result: EQUAL'), 'text: EQUAL');

  // a tampered derived row: a mismatch of that family (exit 1)
  const tampered = clone(d.ecDoc) as unknown as { ranges: Record<string, Record<string, { displayMax: number }>> };
  const [family, rows] = Object.entries(tampered.ranges).find(([, rs]) => Object.values(rs).some((x) => x.displayMax > 0))!;
  const [pid, row] = Object.entries(rows).find(([, x]) => x.displayMax > 0)!;
  row.displayMax += 1;
  ({ r, j } = await json('--profile', file('tampered', tampered), '--rederive'));
  assertEqual(r.exitCode, 1, 'tampered: exit 1');
  assertEqual(j.rederive.status, 'mismatch', 'tampered: mismatch');
  assertEqual(j.rederive.differences.length, 1, 'tampered: one family differs');
  assertEqual(j.rederive.differences[0].family, family, 'tampered: the tampered family');
  assertEqual(JSON.stringify(j.rederive.differences[0].rows.changed), JSON.stringify([Number(pid)]), 'tampered: the tampered pid changed');
  assert(codes(j).includes('rederive-mismatch'), 'tampered: a rederive-mismatch finding');
  assert(j.failures.some((f: { where: string }) => f.where === `rederive ${family}`), 'tampered: the finding names the family');

  // the same tampering on a document of an older derivation revision: the server re-derives it on load anyway, so the
  // difference is a warning (exit 0; --strict makes it a failure)
  (tampered as unknown as { meta: { derivedRevision: number } }).meta.derivedRevision = 0;
  const older = file('tampered-older', tampered);
  ({ r, j } = await json('--profile', older, '--rederive'));
  assertEqual(j.rederive.onLoad, 'revision', 'older revision: re-derived on load');
  assertEqual(j.rederive.status, 'mismatch', 'older revision: mismatch');
  assertEqual(r.exitCode, 0, 'older revision: exit 0');
  assert(codes(j, 'warnings').includes('rederive-mismatch') && !codes(j).includes('rederive-mismatch'), 'older revision: a warning, not a failure');

  // raw sources that no longer derive (a source of another firmware): a finding with the codec's message
  const broken = clone(d.ecDoc) as unknown as { raw: { sources: Array<{ firmware: string }> } };
  broken.raw.sources[0]!.firmware = '13.0';
  ({ r, j } = await json('--profile', file('broken', broken), '--rederive'));
  assertEqual(r.exitCode, 1, 'not derivable: exit 1');
  assertEqual(j.rederive.status, 'failed', 'not derivable: failed');
  assert(String(j.rederive.message).includes('13.0'), `not derivable: the derivation's message (${j.rederive.message})`);
  assert(codes(j).includes('rederive-failed'), 'not derivable: a rederive-failed finding');

  // format 1: no raw sources, reported, no finding
  ({ r, j } = await json('--profile', d.catalog, '--rederive'));
  assertEqual(r.exitCode, 0, 'format 1: exit 0');
  assertEqual(j.rederive.status, 'no-raw', 'format 1: no-raw');
  assertEqual(j.rederive.format, 1, 'format 1: format');
  assertEqual(j.failures.length, 0, 'format 1: no finding');
}

async function diff(): Promise<void> {
  const d = await fixtures();
  // the catalog on its own firmware: nothing differs
  let { r, j } = await json('--profile', d.catalog, '--diff');
  assertEqual(r.exitCode, 0, 'catalog: exit 0');
  assertEqual(j.diff.diff.state, 'none', 'catalog: state none');
  assertEqual(j.diff.diff.families.length, 0, 'catalog: no family listed');
  assertEqual(j.diff.diff.summary.newParams + j.diff.diff.summary.changed.compatible + j.diff.diff.summary.changed.incompatible, 0, 'catalog: no row differs');
  assertEqual(j.diff.diff.profile.format, 1, 'catalog: a format-1 profile');

  // the newer firmware, placed as the golden's grid read placed it: exactly the golden
  const placed = [58, NEWER_FIRMWARE_DIFF.probedEid, NEWER_FIRMWARE.unknownEid];
  ({ r, j } = await json('--profile', d.newer, '--diff', '--eid', placed.join(',')));
  assert(!codes(j).includes('diff-failed'), 'newer: the builder did not throw');
  assertEqual(j.diff.input.key, '11_99p0', 'newer: the key of the document firmware');
  assertEqual(JSON.stringify(j.diff.input.unmappedEids), JSON.stringify([NEWER_FIRMWARE.unknownEid]), 'newer: only the unknown block maps nowhere');
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  assertEqual(canon(j.diff.diff.summary), canon(golden.summary), 'newer: the golden summary');
  assertEqual(canon(j.diff.diff), canon(golden), 'newer: the golden diff');
  assert(j.diff.diff.families.length > 0, 'newer: families listed');
  // the diff only reports: the newer document's findings are its invariants' (its swapped sections are suspects)
  assertEqual(codes(j).join(','), 'suspect-family,suspect-family', 'newer: --diff adds no finding');
  assertEqual(r.exitCode, 1, 'newer: exit 1 from the suspect families');
  const text = await run('--profile', d.newer, '--diff', '--eid', placed.join(','));
  assert(text.stdout.includes('Definitions diff against the bundled catalog') && text.stdout.includes('state partial'), 'text: the diff section');
  assert(text.stdout.includes(`mapping nowhere: ${NEWER_FIRMWARE.unknownEid}`), 'text: the placed block that maps nowhere');
}

async function merge(): Promise<void> {
  const d = await fixtures();
  // an editor-cache document and a live walk of the same firmware
  let { r, j } = await json('--profile', d.ec, '--merge', d.live);
  assertEqual(j.merge.status, 'merged', `merged (${j.merge.message ?? ''})`);
  assertEqual(j.merge.kept, 1, 'the stored source is kept');
  assertEqual(j.merge.dropped, 0, 'nothing dropped');
  assertEqual(j.merge.key, '11_12p0', 'the key of the document firmware');
  const kinds = (j.merge.result.sources as { kind: string }[]).map((s) => s.kind).sort().join(',');
  assertEqual(kinds, 'editor-cache,live-readonly', 'both sources in the merged document');
  assert(j.merge.result.provenance && j.merge.result.provenance.existence.length > 0, 'provenance reported');
  assert(typeof j.merge.result.provenance.conflicts.entries === 'number', 'conflict count reported');
  assert(j.merge.result.coverage && typeof j.merge.result.coverage.complete === 'boolean', 'coverage reported');
  assert(j.merge.result.check.families.length > 0, 'the invariants ran on the merged document');
  assertEqual(r.exitCode, j.failures.length === 0 ? 0 : 1, 'exit code follows the findings');
  assert(j.failures.every((f: { where: string }) => !f.where.startsWith('merged ')) || r.exitCode === 1, 'merged findings are marked');
  const text = await run('--profile', d.ec, '--merge', d.live);
  assert(text.stdout.includes('result: merged; kept 1 stored source(s)') && text.stdout.includes('invariants of the merged document'), 'text: the merge section');

  // refusals: exit 2, reported in the merge section and inputErrors
  const refused = async (label: string, doc2: string, error: string) => {
    const x = await json('--profile', d.ec, '--merge', doc2);
    assertEqual(x.r.exitCode, 2, `${label}: exit 2`);
    assertEqual(x.j.merge.status, 'refused', `${label}: refused`);
    assertEqual(x.j.merge.error, error, `${label}: error`);
    assertEqual(codes(x.j, 'inputErrors').join(','), error, `${label}: inputErrors`);
    assertEqual(x.j.ok, false, `${label}: not ok`);
  };
  await refused('another model', file('fm9', { ...profileDoc([liveSource(liveSeedRecords())]), model: 0x12 }), 'model-mismatch');
  await refused('format 1', d.catalog, 'no-raw');
  await refused('another firmware', file('fw13', profileDoc([liveSource(liveSeedRecords(), { firmware: '13.0' })], { firmware: '13.0' })), 'firmware-differs');
  const t = await run('--profile', d.ec, '--merge', d.catalog);
  assert(t.stdout.includes('REFUSED [no-raw]') && t.stdout.includes('INPUT: 1 document(s)'), 'text: refusal and the INPUT line');
}

async function blocks(): Promise<void> {
  const d = await fixtures();
  const probed = NEWER_FIRMWARE_DIFF.probedEid;
  const newKey = `section:${NEWER_FIRMWARE_DIFF.newSection.tag}`;
  let { j } = await json('--profile', d.newer, '--blocks', '--eid', String(NEWER_FIRMWARE.unknownEid));
  const b = j.blocks;
  assertEqual(b.entries.length, 1, 'one persisted entry');
  const e = b.entries[0];
  assertEqual(e.eid, probed, 'the probed block');
  assertEqual(e.key, newKey, 'bound to the new section');
  assertEqual(e.state, 'confirmed', 'confirmed');
  assertEqual(e.writable, true, 'device records: writable');
  assertEqual(e.sectionTag, NEWER_FIRMWARE_DIFF.newSection.tag, 'its section tag');
  assertEqual(e.evidence.join(','), 'device-records', 'its evidence');
  assert(e.informative > 0, 'its key has rows');
  assertEqual(e.resolvesTo, newKey, 'the runtime profile resolves the block to the key');
  const keys = (b.unknownSections as { key: string }[]).map((s) => s.key);
  assert(keys.includes(newKey) && keys.includes(`section:${NEWER_FIRMWARE_DIFF.systemSection.tag}`), `the unassigned sections (${keys.join(', ')})`);
  assertEqual(JSON.stringify(b.unknownSections.find((s: { key: string }) => s.key === newKey).boundBy), JSON.stringify([probed]), 'the new section is bound by the probed block');
  assertEqual(JSON.stringify(b.unmapped), JSON.stringify([{ eid: NEWER_FIRMWARE.unknownEid, known: ['placed'] }]), 'the placed unknown block maps nowhere');
  assertEqual(b.roster, null, 'FM3: no roster-only ids');
  assert(!codes(j).some((c) => c.startsWith('block-map')), 'a consistent map: no block-map finding');

  // a confirmed entry whose key has no rows: a finding
  const bad = clone(newerFirmwareDoc()) as unknown as { blockMap: BlockMapEntry[] };
  bad.blockMap[0]!.key = 'section:250';
  ({ j } = await json('--profile', file('bad-map', bad), '--blocks'));
  assert(codes(j).includes('block-map-no-rows'), 'no rows under the key: finding');
  // the runtime overlay only binds a key that has rows; the driver still counts a confirmed block as mapped
  assertEqual(j.blocks.entries[0].resolvesTo, null, 'the runtime profile no longer resolves the block');

  // the Axe-Fx III: the static effect-id table's roster-only ids
  ({ j } = await json('--profile', file('axe3', catalogBuilt(0x10)), '--blocks'));
  assert(Array.isArray(j.blocks.roster) && j.blocks.roster.length > 0, 'III: roster-only ids listed');
  assert(j.blocks.roster.every((x: { state: string; family: string | null }) => x.state === 'likely' && typeof x.family === 'string'), 'III: roster entries are likely, with a family');
  const text = await run('--profile', d.ec, '--blocks');
  assert(text.stdout.includes('Block map (--blocks): 0 persisted entries') && text.stdout.includes('map nowhere: none'), 'text: the blocks section');
}

async function usage(): Promise<void> {
  const r = await run('--url', 'http://127.0.0.1:1', '--diff');
  assertEqual(r.exitCode, 2, 'a tool without --profile: exit 2');
  assert(r.stderr.includes('give --profile'), `usage message (${r.stderr})`);
  assertEqual(r.stdout, '', 'nothing printed');
  const m = await run('--profile', (await fixtures()).ec, '--merge');
  assertEqual(m.exitCode, 2, '--merge without a file: exit 2');
  assert(m.stderr.includes('--merge needs a value'), `--merge usage message (${m.stderr})`);
}

export async function runProfileCheckTests(): Promise<void> {
  for (const [name, fn] of CASES) {
    try { await fn(); }
    catch (e) { throw new Error(`[scripts/profile-check] ${name}: ${(e as Error).message}`); }
  }
}
