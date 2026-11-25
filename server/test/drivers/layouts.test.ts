// Editor-layout v2 serving — variant selection + wire passthrough shape, over the REAL device
// profiles wired in src/devices.ts and the AM4 layout resolver. All data-only (no transport):
//   • variant selection: type-value match, a folded variant's own selector (DELAY_TYPE), amp firmware-pin preference,
//     null/first fallback;
//   • firmware gates (variants, pages, controls) on the connected firmware, else the newest (legacy `lt` pages and
//     variants not served, TREMOLO 0/2/4 and DELAY get the editor's catch-all page on newer firmware, MULTITAP keeps
//     its current variant);
//   • a non-enum selector (REVERB_BASETYPE, also beyond its catalog row's top ordinal; LOOPER_DUB) keys its variant by
//     the raw body value, not a dial reading;
//   • v2 passthrough: pages → rows → controls carry widget/rawWidget/placement/crossBlock verbatim;
//   • page-level controls (`pageControls`): served beside the rows with the same per-control treatment;
//   • AM4 gets a layout for the first time (family mapping via am4LayoutFor).
import { PROFILES, am4LayoutFor, resolveLayoutPages, type DeviceLayout, type SelectorValues } from '../../src/devices.js';
import { EDITOR_WIDGET_KINDS, FM3_LAYOUTS, FM3_PARAMS_BY_FAMILY, type DeviceEditorLayouts, type EditorLayoutControl, type EditorLayoutPage } from 'forgefx-midi/gen3/fm3';
import { FM9_LAYOUTS } from 'forgefx-midi/gen3/fm9';
import { AXE3_LAYOUTS } from 'forgefx-midi/gen3/axe-fx-iii';
import { EDITOR_WIDGET_KINDS, type EditorLayoutPage } from 'forgefx-midi/gen3/fm3';
import { mockBlockDevice, eidOfSlug, blockBulkFrames, compactHex, enc14, sysex } from '../helpers/blockRead.js';
import { MockTransport, handshakeReply, isIdentifyBroadcast } from '../helpers/mock.js';
import { SLUG_FAMILY } from '../../src/devices.js';
import { __createRegistryForTest } from '../../src/drivers/registry.js';
import type { Gen3Driver } from '../../src/drivers/gen3.js';
import { createModernFractalCodec } from 'forgefx-midi/gen3/axe-fx-iii';
import type { BlockParamsV2DTO } from '../../src/drivers/types.js';

const fm3 = PROFILES[0x11]!;
const fm9 = PROFILES[0x12]!;
const axe3 = PROFILES[0x10]!;

// Walk every control of a resolved layout (pages → rows → controls).
function* controlsOf(l: DeviceLayout) {
  for (const p of l.pages) for (const r of p.rows) for (const c of r.controls) yield { page: p, row: r, control: c };
}

// Every control of one page: its rows' controls, then its page-level ones.
const pageAll = (p: EditorLayoutPage): EditorLayoutControl[] => [...p.rows.flatMap((r) => r.controls), ...(p.pageControls ?? [])];
// The page-level controls of `param` per page of a resolved layout: page name → its controls.
const pageLevel = (l: DeviceLayout | undefined, param: string): Array<[string, EditorLayoutControl[]]> =>
  (l?.pages ?? []).map((p): [string, EditorLayoutControl[]] => [p.name, (p.pageControls ?? []).filter((c) => c.paramName === param)])
    .filter(([, cs]) => cs.length > 0);

// A resolved layout is v2-shaped and every control passes the codec fields through unchanged.
function shapeOk(l: DeviceLayout): boolean {
  if (typeof l.editorName !== 'string' || typeof l.family !== 'string') return false;
  if (typeof l.variantName !== 'string') return false;
  if (!(l.variantValue === null || typeof l.variantValue === 'string')) return false;
  if (!Array.isArray(l.pages) || l.pages.length === 0) return false;
  for (const { page, row } of controlsOf(l)) {
    if (typeof page.name !== 'string' || !Array.isArray(page.rows)) return false;
    if (row.section !== 'parameters' && row.section !== 'mixer') return false;
  }
  for (const page of l.pages) {
    if (page.pageControls !== undefined && !(Array.isArray(page.pageControls) && page.pageControls.length > 0)) return false;
    for (const control of pageAll(page)) {
      if (typeof control.label !== 'string') return false;
      if (!(EDITOR_WIDGET_KINDS as readonly string[]).includes(control.widget)) return false;
      if (typeof control.rawWidget !== 'string') return false;
      if (!(control.paramName === null || typeof control.paramName === 'string')) return false;
      if (!(control.paramId === null || typeof control.paramId === 'number')) return false;
    }
  }
  return true;
}

const checks: Array<{ name: string; ok: () => boolean }> = [
  // ── variant selection: type-value MATCH (AM4 COMP variants are value-keyed, no fw noise) ──
  { name: "AM4 COMP type 6 → 'Analog' variant (value '6,14')", ok: () => {
    const l = am4LayoutFor('compressor', 6); return l?.variantName === 'Analog' && l.variantValue === '6,14'; } },
  { name: "AM4 COMP type 0 → 'Studio FF' variant", ok: () => am4LayoutFor('compressor', 0)?.variantName === 'Studio FF' },
  { name: "AM4 COMP type 3 → 'Dynamics' variant", ok: () => am4LayoutFor('compressor', 3)?.variantName === 'Dynamics' },

  // ── variant selection: amp/DISTORT prefers the firmware-PINNED variant (all values null) ──
  { name: 'Axe-Fx III DISTORT prefers pinned amp variant', ok: () => {
    const l = axe3.layoutFor('DISTORT', 0); return !!l && l.pinned === true && l.variantValue === null && l.variantName === 'Amp GTE 28.09'; } },
  { name: 'FM9 DISTORT prefers pinned amp variant', ok: () => {
    const l = fm9.layoutFor('DISTORT', 0); return !!l && l.pinned === true && l.variantName === 'Amp GTE 6.00'; } },

  // ── variant selection: FALLBACK ──
  { name: 'FM3 DISTORT falls back to the null-value variants and prefers the pinned one', ok: () => {
    const l = fm3.layoutFor('DISTORT', 5); return !!l && l.variantValue === null && l.pinned === true && l.variantName === 'Amp GTE 8.00'; } },
  { name: 'AM4 COMP with no matching type falls back to the first variant', ok: () => am4LayoutFor('compressor', 99999)?.variantName === 'Analog' },
  { name: 'unknown family → undefined', ok: () => fm3.layoutFor('NOT_A_FAMILY') === undefined && axe3.layoutFor('NOT_A_FAMILY', 3) === undefined },

  // ── AM4 amp: DISTORT holds two value-less variants, the device-global setup pages ('Global', also the
  //    layout's editorName) listed first and the real 'Amp' editor; the amp block must get the latter ──
  { name: "AM4 amp serves the 'Amp' variant, not the device-global setup pages", ok: () => {
    const l = am4LayoutFor('amp', 7);
    return !!l && l.variantName === 'Amp' && l.variantValue === null
      && !l.pages.some((p) => ['Audio', 'Footswitches', 'MIDI/Remote', 'Global'].includes(p.name))
      && l.pages.some((p) => p.name === 'Amp'); } },
  { name: 'AM4 amp: the variant is picked whatever the type value (unknown, or none at all)', ok: () =>
    am4LayoutFor('amp', 99999)?.variantName === 'Amp' && am4LayoutFor('amp')?.variantName === 'Amp' },
  { name: "AM4 amp: a model an explicit page names gets exactly that Amp page (7 → '7,8,93')", ok: () => {
    const ampPages = (am4LayoutFor('amp', 7)?.pages ?? []).filter((p) => p.name === 'Amp');
    return ampPages.length === 1 && ampPages[0]!.value === '7,8,93'; } },
  { name: "AM4 amp: a model no explicit page names gets the group's catch-all Amp page (#86 reaches AM4)", ok: () => {
    const byType = (am4LayoutFor('amp', 99999)?.pages ?? []).filter((p) => p.name === 'Amp');
    const sel: SelectorValues = (n) => (n === 'DISTORT_TYPE' ? 99999 : undefined);
    const bySelector = (resolveLayoutPages(am4LayoutFor('amp', 99999)?.pages ?? [], 99999, sel)).filter((p) => p.name === 'Amp');
    return byType.length === 1 && byType[0]!.value === '' && bySelector.length === 1 && bySelector[0]!.value === ''; } },
  { name: 'the per-family variant hint is AM4-only: gen-3 amp selection is unchanged', ok: () =>
    fm3.layoutFor('DISTORT', 5)?.variantName === 'Amp GTE 8.00' && axe3.layoutFor('DISTORT', 0)?.variantName === 'Amp GTE 28.09' },

  // ── v2 passthrough shape ──
  { name: 'Axe-Fx III DISTORT layout is v2-shaped (pages→rows→controls)', ok: () => { const l = axe3.layoutFor('DISTORT', 0); return !!l && shapeOk(l); } },
  { name: 'AM4 COMP layout is v2-shaped', ok: () => { const l = am4LayoutFor('compressor', 6); return !!l && shapeOk(l); } },
  { name: 'FM3 DISTORT carries at least one control placement (passthrough)', ok: () => {
    const l = fm3.layoutFor('DISTORT'); if (!l) return false;
    for (const { control } of controlsOf(l)) if (control.placement && typeof control.placement.col === 'number') return true;
    return false; } },
  { name: 'crossBlock passes through with its shape (Axe-Fx III, across families)', ok: () => {
    for (const fam of ['DELAY', 'MULTITAP', 'REVERB', 'PITCH', 'GLOBAL', 'CONTROLLERS']) {
      const l = axe3.layoutFor(fam); if (!l) continue;
      for (const { control } of controlsOf(l)) {
        const x = control.crossBlock;
        if (x) return typeof x.effect === 'string'
          && (x.family === null || typeof x.family === 'string')
          && (x.paramName === null || typeof x.paramName === 'string')
          && (x.paramId === null || typeof x.paramId === 'number');
      }
    }
    return false; } },
  { name: 'selected variant includes ALL its pages only (no unioning)', ok: () => {
    // 'Analog' has a fixed page count; a different type resolves a different variant with its own pages.
    const analog = am4LayoutFor('compressor', 6); const dyn = am4LayoutFor('compressor', 3);
    return !!analog && !!dyn && analog.variantName !== dyn.variantName && analog.pages.length >= 1 && dyn.pages.length >= 1; } },

  // ── AM4 layout presence (first-time) — block-name → family mapping ──
  // the codec files the AM4 device-global setup pages under their own GLOBAL family (WP-F7a generator fix), so the
  // amp block's layout is the amp editor's own component
  { name: "AM4 'amp' → DISTORT layout (editorName 'Amp')", ok: () => {
    const l = am4LayoutFor('amp'); return l?.family === 'DISTORT' && l.editorName === 'Amp'; } },
  { name: "AM4 'reverb' → REVERB layout", ok: () => am4LayoutFor('reverb')?.family === 'REVERB' },
  { name: "AM4 'drive' → FUZZ layout", ok: () => am4LayoutFor('drive')?.family === 'FUZZ' },
  { name: "AM4 'volpan' → VOLUME layout", ok: () => am4LayoutFor('volpan')?.family === 'VOLUME' },
  { name: "AM4 'compressor' → COMP layout", ok: () => am4LayoutFor('compressor')?.family === 'COMP' },
  { name: "AM4 unmapped block → undefined", ok: () => am4LayoutFor('none') === undefined && am4LayoutFor('bogus') === undefined },

  // ── serve-time page filtering (FORGEFX-24): a multi-selector variant's pages collapse to the ones
  //    the editor actually shows for the block's current selector + firmware state (was: 57 'Authentic'
  //    amp tabs served at once → duplicate tabs in Axis) ──
  { name: 'FM3 amp: DISTORT_TYPE selector picks exactly one Authentic page for the current model', ok: () => {
    const sel: SelectorValues = (n) => (n === 'DISTORT_TYPE' ? 29 : undefined);
    const l = fm3.layoutFor('DISTORT', 29, sel);
    return !!l && l.pages.filter((p) => p.name === 'Authentic').length === 1; } },
  { name: 'FM3 amp: firmware preference keeps the gtet page over its lt-only sibling (model 15)', ok: () => {
    const sel: SelectorValues = (n) => (n === 'DISTORT_TYPE' ? 15 : undefined);
    const l = fm3.layoutFor('DISTORT', 15, sel);
    const auth = l?.pages.filter((p) => p.name === 'Authentic') ?? [];
    return auth.length === 1 && auth[0]!.fw?.gtet === '10,00' && auth[0]!.fw?.lt === undefined; } },
  { name: 'FM3 amp: no-selector pages (Preamp/Speaker) are always included', ok: () => {
    const sel: SelectorValues = (n) => (n === 'DISTORT_TYPE' ? 29 : undefined);
    const l = fm3.layoutFor('DISTORT', 29, sel);
    return !!l && l.pages.some((p) => p.name === 'Preamp') && l.pages.some((p) => p.name === 'Speaker'); } },
  { name: 'FM3 amp: every served page name is unique (no duplicate tabs)', ok: () => {
    const sel: SelectorValues = (n) => (n === 'DISTORT_TYPE' ? 29 : undefined);
    const l = fm3.layoutFor('DISTORT', 29, sel); if (!l) return false;
    const names = l.pages.map((p) => p.name);
    return new Set(names).size === names.length; } },
  { name: "FM3 amp: a model with no explicit Ideal page still gets the group's catch-all Ideal page", ok: () => {
    // 29 lives in an explicit 'Authentic' page but in no explicit 'Ideal' page. The Ideal group ends
    // with the editor's catch-all (blank `value`), which is what the editor shows for every model its
    // explicit siblings don't name — so exactly one Ideal page is served, not zero.
    const sel: SelectorValues = (n) => (n === 'DISTORT_TYPE' ? 29 : undefined);
    const l = fm3.layoutFor('DISTORT', 29, sel);
    const ideal = l?.pages.filter((p) => p.name === 'Ideal') ?? [];
    return ideal.length === 1 && ideal[0]!.value === '' && ideal[0]!.rows.length > 0; } },
  { name: 'FM3 amp: an explicit selector match wins over the catch-all (model 6)', ok: () => {
    // 6 IS named by an explicit Ideal page → that page is served, never the blank-value default.
    const sel: SelectorValues = (n) => (n === 'DISTORT_TYPE' ? 6 : undefined);
    const l = fm3.layoutFor('DISTORT', 6, sel);
    const ideal = l?.pages.filter((p) => p.name === 'Ideal') ?? [];
    return ideal.length === 1 && (ideal[0]!.value ?? '').split(',').includes('6'); } },
  { name: 'FM3 amp: model 0 does not duplicate a group (catch-all is not "value 0")', ok: () => {
    // `Number('')` is 0, so a blank value list once read as "model 0" — serving BOTH the explicit
    // model-0 page and the catch-all, which Axis rendered as duplicate 'Ideal'/'Ideal 2' tabs.
    const sel: SelectorValues = (n) => (n === 'DISTORT_TYPE' ? 0 : undefined);
    const l = fm3.layoutFor('DISTORT', 0, sel); if (!l) return false;
    const names = l.pages.map((p) => p.name);
    return new Set(names).size === names.length
      && names.filter((n) => n === 'Ideal').length === 1
      && names.filter((n) => n === 'Authentic').length === 1; } },
  { name: 'every FM3 amp model is served both an Authentic and an Ideal page', ok: () => {
    // The regression this guards: only the 124 models named by an explicit Ideal page got the tab.
    for (let t = 0; t < 331; t++) {
      const sel: SelectorValues = (n) => (n === 'DISTORT_TYPE' ? t : undefined);
      const l = fm3.layoutFor('DISTORT', t, sel); if (!l) return false;
      if (l.pages.filter((p) => p.name === 'Ideal').length !== 1) return false;
      if (l.pages.filter((p) => p.name === 'Authentic').length !== 1) return false;
    }
    return true; } },
  { name: 'catch-all page applies only when no explicit sibling matches (synthetic)', ok: () => {
    const pages: EditorLayoutPage[] = [
      { name: 'P', rows: [], selectorParamName: 'SEL', value: '1,2' },
      { name: 'P', rows: [], selectorParamName: 'SEL', value: '' },
    ];
    const hit = resolveLayoutPages(pages, undefined, (n) => (n === 'SEL' ? 2 : undefined));
    const miss = resolveLayoutPages(pages, undefined, (n) => (n === 'SEL' ? 9 : undefined));
    return hit.length === 1 && hit[0]!.value === '1,2' && miss.length === 1 && miss[0]!.value === ''; } },
  { name: 'a group with no catch-all still contributes no page when nothing matches (synthetic)', ok: () => {
    const pages: EditorLayoutPage[] = [{ name: 'P', rows: [], selectorParamName: 'SEL', value: '1,2' }];
    return resolveLayoutPages(pages, undefined, (n) => (n === 'SEL' ? 9 : undefined)).length === 0; } },
  { name: 'unknown selector value prefers the catch-all over the first gated page (synthetic)', ok: () => {
    const pages: EditorLayoutPage[] = [
      { name: 'P', rows: [], selectorParamName: 'SEL', value: '1,2' },
      { name: 'P', rows: [], selectorParamName: 'SEL', value: '' },
    ];
    const out = resolveLayoutPages(pages); // no typeValue, no selectors
    return out.length === 1 && out[0]!.value === ''; } },
  { name: 'FM3 amp: unknown selector value never serves ALL — one page per same-named group', ok: () => {
    const l = fm3.layoutFor('DISTORT'); if (!l) return false; // no typeValue, no selectors
    const byName = new Map<string, number>();
    for (const p of l.pages) byName.set(p.name, (byName.get(p.name) ?? 0) + 1);
    return [...byName.values()].every((c) => c === 1); } },

  // ── page-level controls (FORGEFX-59): the controls the editor places directly on a page, beside its rows ──
  { name: 'Synth: the tracking mode is served on all three voice pages (FM3 / FM9 / III), verbatim from the codec', ok: () => {
    // Gates are not evaluated against the connected firmware (rows neither): a `gtet`-only gate always serves,
    // and travels along in `fw` so a client can apply it.
    const want: Array<[DeviceLayout | undefined, string]> = [
      [fm3.layoutFor('SYNTH', 0), '11,01'], [fm9.layoutFor('SYNTH', 0), '10,01'], [axe3.layoutFor('SYNTH', 0), '29,02'],
    ];
    return want.every(([l, gtet]) => {
      const hits = pageLevel(l, 'SYNTH_PD_RANGE');
      return hits.map(([n]) => n).join(',') === 'Voice 1,Voice 2,Voice 3'
        && hits.every(([, cs]) => cs.length === 1 && JSON.stringify(cs[0]) === JSON.stringify({
          label: 'Tracking\nMode', paramName: 'SYNTH_PD_RANGE', paramId: 41, widget: 'dropdown', rawWidget: 'dropdown1Tight',
          placement: { positionExact: '196,230' }, fw: { gtet },
        }));
    }); } },
  { name: 'Synth: the served tracking mode is a catalog param of the block, and no row shows it', ok: () => {
    const l = fm3.layoutFor('SYNTH');
    const pid = pageLevel(l, 'SYNTH_PD_RANGE')[0]?.[1][0]?.paramId;
    const inRows = [...controlsOf(l!)].some(({ control }) => control.paramName === 'SYNTH_PD_RANGE');
    return FM3_PARAMS_BY_FAMILY.SYNTH!.some((p) => p.name === 'SYNTH_PD_RANGE' && p.paramId === pid) && !inRows; } },
  { name: 'FM3 amp: the EQ page serves its page-level type / location / zero / on-off controls, in editor order', ok: () => {
    const sel: SelectorValues = (n) => (n === 'DISTORT_TYPE' ? 29 : undefined);
    const l = fm3.layoutFor('DISTORT', 29, sel);
    const hits = pageLevel(l, 'DISTORT_EQTYPE');
    const page = l?.pages.find((p) => p.name === hits[0]?.[0]);
    return hits.length === 1
      && (page?.pageControls ?? []).filter((c) => c.paramName).map((c) => c.paramName).join(',') === 'DISTORT_EQTYPE,DISTORT_EQPOSITION,DISTORT_ZEROEQ,DISTORT_EQONOFF'; } },
  { name: 'FM3 drive: every type with a page-level graphic-EQ switch gets the current-firmware one only', ok: () => {
    // the editor carries it twice: a toggle below firmware 3.00, a dropdown from 3.00 on
    let pages = 0;
    for (const v of FM3_LAYOUTS.FUZZ!.variants) {
      const l = fm3.layoutFor('FUZZ', v.value === null ? undefined : Number(v.value.split(',')[0]));
      for (const [, cs] of pageLevel(l, 'FUZZ_EQON')) {
        pages++;
        if (cs.length !== 1 || cs[0]!.fw?.gtet !== '3,00' || cs[0]!.widget !== 'dropdown') return false;
      }
    }
    return pages >= 10; } },
  { name: 'no served page carries an lt-gated control, in a row or page-level (FM3 / FM9 / III: every family of each, without a type and at every value its variants and pages name)', ok: () => {
    const devices: Array<[typeof fm3, DeviceEditorLayouts]> = [[fm3, FM3_LAYOUTS], [fm9, FM9_LAYOUTS], [axe3, AXE3_LAYOUTS]];
    let gated = 0; // page-level lt gates in the codec data, so the check cannot pass on data without any
    for (const [prof, layouts] of devices) {
      for (const [fam, block] of Object.entries(layouts)) {
        const pages = block.variants.flatMap((v) => v.pages);
        for (const p of pages) gated += (p.pageControls ?? []).filter((c) => c.fw?.lt != null).length;
        const values = [...block.variants.map((v) => v.value), ...pages.map((p) => p.value ?? null)]
          .flatMap((v) => (v ?? '').split(',').filter((s) => s.trim() !== '').map(Number));
        for (const t of [undefined, ...new Set(values)]) {
          const served = prof.layoutFor(fam, t)?.pages;
          if (!served?.length || served.some((p) => pageAll(p).some((c) => c.fw?.lt != null))) return false;
        }
      }
    }
    return gated > 0; } },
  { name: "a served page-level paramId is a catalog param of the block's own family (FM3 / FM9 / III, every variant); another family's has none", ok: () => {
    const devices: Array<[typeof fm3, DeviceEditorLayouts]> = [[fm3, FM3_LAYOUTS], [fm9, FM9_LAYOUTS], [axe3, AXE3_LAYOUTS]];
    return devices.every(([prof, layouts]) => Object.entries(layouts).every(([fam, block]) => {
      const own = new Map((prof.params[fam] ?? []).map((p) => [p.name, p.paramId]));
      return block.variants.every((v) => resolveLayoutPages(v.pages).every((p) => (p.pageControls ?? []).every((c) =>
        c.crossBlock !== undefined || c.paramId === (own.get(c.paramName ?? '') ?? null))));
    })); } },
  { name: 'AM4: the graphic EQ and amp pages serve their page-level controls', ok: () =>
    pageLevel(am4LayoutFor('geq', 0), 'GEQ_MASTERQ').length > 0 && pageLevel(am4LayoutFor('amp', 7), 'DISTORT_EQTYPE').length > 0 },
  { name: 'page-level control fw pruning: same rule as rows (lt-bounded dropped, gtet/ungated kept, order kept)', ok: () => {
    const c = (label: string, fw?: EditorLayoutControl['fw']): EditorLayoutControl => ({ label, paramName: label, paramId: 1, widget: 'knob', rawWidget: 'knob', ...(fw ? { fw } : {}) });
    const out = resolveLayoutPages([{ name: 'P', rows: [], pageControls: [
      c('plain'), c('gtet', { gtet: '6,00' }), c('lt', { lt: '10,00' }), c('range', { gtet: '6,00', lt: '10,00' }), c('last'),
    ] }]);
    return out[0]!.pageControls!.map((x) => x.label).join(',') === 'plain,gtet,last'; } },
  { name: 'page-level controls: the key is absent once every one is pruned; rows and the rest of the page stay', ok: () => {
    const row = { section: 'parameters' as const, controls: [{ label: 'R', paramName: 'R', paramId: 2, widget: 'knob' as const, rawWidget: 'knob' }] };
    const out = resolveLayoutPages([{ name: 'P', pageNum: 3, rows: [row], pageControls: [
      { label: 'old', paramName: 'A', paramId: 1, widget: 'knob', rawWidget: 'knob', fw: { lt: '3,00' } },
    ] }]);
    return !('pageControls' in out[0]!) && out[0]!.pageNum === 3 && out[0]!.rows.length === 1 && out[0]!.rows[0] === row; } },
  { name: 'page-level controls: pruning a row keeps them, pruning them keeps the rows; an untouched page is passed as is', ok: () => {
    const c = (label: string, lt?: string): EditorLayoutControl => ({ label, paramName: label, paramId: 1, widget: 'knob', rawWidget: 'knob', ...(lt ? { fw: { lt } } : {}) });
    const rowOnly: EditorLayoutPage = { name: 'A', rows: [{ section: 'parameters', controls: [c('r'), c('r-old', '2,00')] }], pageControls: [c('p')] };
    const pageOnly: EditorLayoutPage = { name: 'B', rows: [{ section: 'parameters', controls: [c('r')] }], pageControls: [c('p-old', '2,00'), c('p')] };
    const clean: EditorLayoutPage = { name: 'C', rows: [{ section: 'parameters', controls: [c('r')] }], pageControls: [c('p')] };
    const [a, b, d] = resolveLayoutPages([rowOnly, pageOnly, clean]);
    return pageAll(a!).map((x) => x.label).join(',') === 'r,p' && a!.pageControls === rowOnly.pageControls
      && pageAll(b!).map((x) => x.label).join(',') === 'r,p' && b!.rows[0] === pageOnly.rows[0]
      && d === clean && pageOnly.pageControls!.length === 2; } },
  { name: 'page-level controls: cross-block reference, placement and decorative entries pass through verbatim; a page of them alone is served', ok: () => {
    const pageControls: EditorLayoutControl[] = [
      { label: 'VOICE 1', paramName: null, paramId: null, widget: 'label', rawWidget: 'sectionLabel', placement: { positionExact: '305,29' } },
      { label: 'Tempo', paramName: 'GLOBAL_TEMPO', paramId: 9, widget: 'knob', rawWidget: 'knob', crossBlock: { effect: 'ID_GLOBAL', family: 'GLOBAL', paramName: 'GLOBAL_TEMPO', paramId: 9 } },
    ];
    const out = resolveLayoutPages([{ name: 'P', rows: [], pageControls }]);
    return out.length === 1 && out[0]!.rows.length === 0 && out[0]!.pageControls === pageControls; } },
  { name: 'page-level controls follow their page through selector and firmware sibling selection', ok: () => {
    const c = (label: string): EditorLayoutControl => ({ label, paramName: label, paramId: 1, widget: 'knob', rawWidget: 'knob' });
    const pages: EditorLayoutPage[] = [
      { name: 'P', rows: [], selectorParamName: 'SEL', value: '1', pageControls: [c('one')] },
      { name: 'P', rows: [], selectorParamName: 'SEL', value: '2', pageControls: [c('two')] },
      { name: 'F', rows: [], fw: { lt: '3,00' }, pageControls: [c('old')] },
      { name: 'F', rows: [], fw: { gtet: '3,00' }, pageControls: [c('new')] },
    ];
    const out = resolveLayoutPages(pages, undefined, (n) => (n === 'SEL' ? 2 : undefined));
    return out.map((p) => p.pageControls!.map((x) => x.label).join()).join(',') === 'two,new'; } },

  // ── page filtering: split (single-selector) families with selector-free variant pages are unaffected ──
  { name: 'split family (selector-free variant pages) passes through unchanged', ok: () => {
    const pages: EditorLayoutPage[] = [
      { name: 'Basic', rows: [] }, { name: 'Advanced', rows: [] }, { name: 'Mix', rows: [] },
    ];
    const out = resolveLayoutPages(pages, 3);
    return out.length === 3 && out.map((p) => p.name).join(',') === 'Basic,Advanced,Mix'; } },

  // ── page filtering: deterministic firmware rule on synthetic same-named siblings ──
  { name: 'fw rule: highest gtet supersedes lt-only and null-gated siblings', ok: () => {
    const pages: EditorLayoutPage[] = [
      { name: 'X', rows: [], fw: { lt: '10,00' } },
      { name: 'X', rows: [], fw: { gtet: '10,00' } },
      { name: 'X', rows: [], fw: { gtet: '20,00' } },
      { name: 'X', rows: [] },
    ];
    const out = resolveLayoutPages(pages);
    return out.length === 1 && out[0]!.fw?.gtet === '20,00'; } },
  { name: 'fw rule: null-gated sibling beats lt-only when no gtet present', ok: () => {
    const pages: EditorLayoutPage[] = [
      { name: 'X', rows: [], fw: { lt: '6,00' } }, { name: 'X', rows: [] },
    ];
    const out = resolveLayoutPages(pages);
    return out.length === 1 && out[0]!.fw === undefined; } },
  { name: 'fw rule: lt-only siblings never apply to the newest firmware; a connected firmware gets the one whose gate holds', ok: () => {
    // the newest firmware (no firmware known) is past every `lt` bound: neither sibling applies, the tab is not served
    // (it used to serve the highest `lt` one, an editor page of an older firmware)
    const pages: EditorLayoutPage[] = [
      { name: 'X', rows: [], fw: { lt: '6,00' } }, { name: 'X', rows: [], fw: { lt: '12,00' } },
    ];
    const at = (major: number, minor = 0) => resolveLayoutPages(pages, undefined, undefined, { major, minor }).map((p) => p.fw?.lt).join(',');
    return resolveLayoutPages(pages).length === 0 && at(5) === '6,00' && at(8) === '12,00' && at(11, 99) === '12,00' && at(12) === ''; } },
  { name: 'fw rule (connected firmware): a gtet page above it is hidden, the ungated sibling serves; at the bound the gtet page wins', ok: () => {
    const pages: EditorLayoutPage[] = [{ name: 'X', rows: [], fw: { gtet: '10,00' } }, { name: 'X', rows: [] }];
    const at = (major: number) => resolveLayoutPages(pages, undefined, undefined, { major, minor: 0 });
    const old = at(9); const cur = at(10);
    return old.length === 1 && old[0]!.fw === undefined && cur.length === 1 && cur[0]!.fw?.gtet === '10,00'; } },
  { name: 'fw rule (connected firmware): a lone page whose gate does not hold is dropped, minors compare as written (9.02 = "9,02")', ok: () => {
    const pages: EditorLayoutPage[] = [{ name: 'A', rows: [], fw: { lt: '9,02' } }, { name: 'B', rows: [], fw: { gtet: '9,02' } }];
    const names = (minor: number) => resolveLayoutPages(pages, undefined, undefined, { major: 9, minor }).map((p) => p.name).join(',');
    return names(1) === 'A' && names(2) === 'B' && resolveLayoutPages(pages).map((p) => p.name).join(',') === 'B'; } },

  // ── page filtering: per-control firmware pruning (lt-bounded controls hidden on newest firmware) ──
  { name: 'control fw pruning: lt-bounded controls are dropped, gtet/ungated kept', ok: () => {
    const pages: EditorLayoutPage[] = [{ name: 'P', rows: [{ section: 'parameters', controls: [
      { label: 'keep-plain', paramName: 'A', paramId: 1, widget: 'knob', rawWidget: 'knob' },
      { label: 'keep-gtet', paramName: 'B', paramId: 2, widget: 'knob', rawWidget: 'knob', fw: { gtet: '6,00' } },
      { label: 'drop-lt', paramName: 'C', paramId: 3, widget: 'knob', rawWidget: 'knob', fw: { lt: '10,00' } },
      { label: 'drop-range', paramName: 'D', paramId: 4, widget: 'knob', rawWidget: 'knob', fw: { gtet: '6,00', lt: '10,00' } },
    ] }] }];
    const out = resolveLayoutPages(pages);
    const labels = out[0]!.rows[0]!.controls.map((c) => c.label);
    // on a connected firmware every control whose gate holds is shown: 5.x hides the gtet ones, 8.x shows the range
    const at = (major: number) => resolveLayoutPages(pages, undefined, undefined, { major, minor: 0 })[0]!.rows[0]!.controls.map((c) => c.label).join(',');
    return labels.length === 2 && labels.join(',') === 'keep-plain,keep-gtet'
      && at(5) === 'keep-plain,drop-lt' && at(8) === 'keep-plain,keep-gtet,drop-lt,drop-range' && at(10) === 'keep-plain,keep-gtet'; } },

  // ── firmware gates on the real layouts (M3 P3): legacy pages / variants are not served on the newest firmware ──
  { name: 'FM3 FLANGER: the legacy `lt 1,2` pages are not served on the newest firmware, a 1.0 unit gets them', ok: () => {
    const newest = fm3.layoutFor('FLANGER')!.pages.map((p) => p.name).join(',');
    const old = fm3.layoutFor('FLANGER', undefined, undefined, { major: 1, minor: 0 })!.pages.map((p) => p.name);
    return newest === 'Basic,Expert 1,Expert 2' && old.includes('Flanger') && old.includes('Tone') && !old.includes('Basic'); } },
  { name: "TREMOLO types 0/2/4: their own variant on every firmware — the editor's catch-all Tremolo page on newer firmware, the legacy page on older", ok: () => {
    // the codec folds the editor's catch-all page (`value=""`, gtet 8,00) into every type no sibling page names, so the
    // 0,2,4 variant carries its current page next to its `lt 8,00` one (it used to hold only the legacy page and
    // yield to the default variant on newer firmware)
    const sel = (t: number): SelectorValues => (n) => (n === 'TREMOLO_TYPE' ? t : undefined);
    for (const [p, bound] of [[fm3, 8], [fm9, 6], [axe3, 23]] as const) {
      for (const t of [0, 2, 4]) {
        const cur = p.layoutFor('TREMOLO', t, sel(t));
        const old = p.layoutFor('TREMOLO', t, sel(t), { major: bound - 1, minor: 0 });
        if (cur?.variantName !== '0,2,4' || cur.pages.length !== 1 || cur.pages[0]!.name !== 'Tremolo' || cur.pages[0]!.fw?.gtet === undefined) return false;
        if (old?.variantName !== '0,2,4' || old.pages.length !== 1 || old.pages[0]!.fw?.lt === undefined) return false;
      }
      // the Panner keeps its own variant, and the catch-all Tremolo page (same tab position) does not reach it
      const pan = p.layoutFor('TREMOLO', 1, sel(1));
      if (pan?.variantName !== '1' || pan.pages.map((pg) => pg.name).join(',') !== 'Panner') return false;
    }
    return true; } },
  { name: "DELAY: every routing type but 6 gets the editor's catch-all Modulation page on current firmware, the legacy one on older", ok: () => {
    const sel = (t: number): SelectorValues => (n) => (n === 'DELAY_TYPE' ? t : undefined);
    for (const [p, bound] of [[fm3, 8], [fm9, 6], [axe3, 23]] as const) {
      for (let t = 0; t <= 7; t++) {
        const mod = (fw?: { major: number; minor: number }) => (p.layoutFor('DELAY', 0, sel(t), fw)?.pages ?? []).filter((pg) => pg.name === 'Modulation');
        const cur = mod(); const old = mod({ major: bound - 1, minor: 0 });
        if (cur.length !== 1 || cur[0]!.fw?.gtet === undefined) return false;
        if (old.length !== 1 || old[0]!.fw?.lt === undefined) return false;
      }
    }
    return true; } },
  { name: 'REVERB: the base types the Pitch Shift page names get the full tab set, not the Pitch Shift page alone', ok: () => {
    for (const p of [fm3, fm9, axe3]) {
      for (const base of [1, 2, 3, 6, 7, 8]) {
        const l = p.layoutFor('REVERB', 0, (n) => (n === 'REVERB_BASETYPE' ? base : undefined));
        if (l?.variantName !== '1,2,3,6,7,8,9,10' || l.pages.map((pg) => pg.name).join(',') !== 'Basic,Advanced,Duck + Mod,EQ,Pitch Shift') return false;
      }
      // 0/5 keep their Ducker tab: the catch-all Duck + Mod (same tab position) does not reach them
      const plate = p.layoutFor('REVERB', 0, (n) => (n === 'REVERB_BASETYPE' ? 5 : undefined));
      if (plate?.variantName !== '0,5' || plate.pages.map((pg) => pg.name).join(',') !== 'Basic,Advanced,Ducker,EQ') return false;
    }
    return true; } },
  { name: 'MULTITAP: the current-firmware variant of a type wins over its legacy twin (FM3 gtet 9,02, FM9 8,02, III 27,02); an older unit gets the legacy one', ok: () => {
    for (const [p, maj, min] of [[fm3, 9, 2], [fm9, 8, 2], [axe3, 27, 2]] as const) {
      for (let t = 0; t <= 5; t++) {
        const cur = p.layoutFor('MULTITAP', t);
        const old = p.layoutFor('MULTITAP', t, undefined, { major: maj, minor: min - 1 });
        const atBound = p.layoutFor('MULTITAP', t, undefined, { major: maj, minor: min });
        if (cur?.variantValue !== String(t) || cur.fw?.gtet === undefined || cur.pages[0]?.name !== 'Master') return false;
        if (old?.variantValue !== String(t) || old.fw?.lt === undefined) return false;
        if (atBound?.variantName !== cur.variantName) return false;
      }
    }
    return true; } },
  { name: 'DELAY: its variants are keyed by DELAY_TYPE (the routing type), not the model selector DELAY_MODEL', ok: () => {
    // the Delay's model 20 with routing type 4 (whose variant has the Tone/Duck page) gets variant '4'; an unknown
    // routing type gets the default variant; a caller without a selector lookup keys by the type value it passes
    for (const p of [fm3, fm9, axe3]) {
      const sel = (type: number | undefined): SelectorValues => (n) => (n === 'DELAY_TYPE' ? type : n === 'DELAY_MODEL' ? 20 : undefined);
      const four = p.layoutFor('DELAY', 20, sel(4));
      if (four?.family !== 'DELAY' || four.editorName !== 'Delay' || four.variantName !== '4') return false;
      if (p === fm3 && !four.pages.some((pg) => pg.name === 'Tone/Duck')) return false;
      if (p.layoutFor('DELAY', 2, sel(undefined))?.variantName !== 'Default') return false;
      if (p.layoutFor('DELAY', 3)?.variantName !== '3') return false;
    }
    return true; } },
  { name: 'every gen-3 family and type value: a non-empty layout whose pages and controls all apply to the firmware it was resolved for', ok: () => {
    const holds = (g: { gtet?: string; lt?: string } | undefined, fw: number) => {
      const b = (v?: string) => { const [a = 0, c = 0] = (v ?? '').split(',').map((x) => Number(x.trim()) || 0); return a * 1000 + c; };
      return !g || ((g.gtet == null || fw >= b(g.gtet)) && (g.lt == null || fw < b(g.lt)));
    };
    for (const p of [fm3, fm9, axe3]) {
      for (const fam of Object.keys(p.editorLayouts!)) {
        for (const fw of [undefined, { major: 4, minor: 0 }, { major: 13, minor: 0 }]) {
          const level = fw ? fw.major * 1000 + fw.minor : Number.POSITIVE_INFINITY;
          for (let t = 0; t < 40; t++) {
            const l = p.layoutFor(fam, t, (n) => (n.endsWith('_TYPE') || n.endsWith('_MODE') ? t % 4 : undefined), fw);
            if (!l || l.pages.length === 0) return false;
            // a variant picked on the newest firmware (nothing of the family exists on that firmware) is resolved there
            const at = holds(l.fw, level) && l.pages.every((pg) => holds(pg.fw, level)) ? level : Number.POSITIVE_INFINITY;
            for (const pg of l.pages) {
              if (!holds(pg.fw, at)) return false;
              for (const r of pg.rows) for (const c of r.controls) if (!holds(c.fw, at)) return false;
            }
          }
        }
      }
    }
    return true; } },
];

// ── served variants: which layout variant a block answers with, from the values it reads ──
// A family with a type selector (<F>_MODEL / <F>_TYPE) picks its variant by the type value (the GEQ's band
// layout); one without picks it by its variant selector: the cab by CABINET_MODE (Legacy / DynaCab), the plex by
// PLEX_BASETYPE. The cab used to follow its preamp type (CABINET_PRETYPE, a param that merely ends in TYPE), so
// a cab on DynaCab could get the Legacy pages and the other way round.
const SERVED_VARIANT_CASES = 8;

async function servedVariantChecks(): Promise<void> {
  for (const profile of [fm3, fm9, axe3]) {
    const served = async (slug: string, set: Record<string, number>, firmware?: { major: number; minor: number }) => {
      const family = SLUG_FAMILY[slug]!;
      const eid = eidOfSlug(slug);
      const values = new Array<number>(profile.rangeSections[family]!.stride * 4).fill(0);
      for (const [name, v] of Object.entries(set)) values[profile.params[family]!.find((p) => p.name === name)!.paramId] = v;
      const { driver } = mockBlockDevice(profile, { [eid]: { values, channel: 0 } }, firmware ? { firmware } : {});
      return [await driver.blockParams(eid), (await driver.blockParams(eid, { generic: true })) as BlockParamsV2DTO] as const;
    };
    // 1. the cab follows CABINET_MODE, in both responses
    for (const mode of [0, 1]) {
      for (const r of await served('cab', { CABINET_MODE: mode })) {
        if (r.layout?.variantValue !== String(mode)) throw new Error(`${profile.key}: cab layout variant for CABINET_MODE=${mode} is ${r.layout?.variantValue}`);
      }
    }
    // 2. …and not the preamp type
    for (const pre of [0, 5, 11]) {
      for (const [mode, want] of [[0, '0'], [1, '1']] as const) {
        for (const r of await served('cab', { CABINET_MODE: mode, CABINET_PRETYPE: pre })) {
          if (r.layout?.variantValue !== want) throw new Error(`${profile.key}: cab variant moved with CABINET_PRETYPE=${pre} (mode ${mode} gave ${r.layout?.variantValue})`);
        }
      }
    }
    // 3. the plex follows PLEX_BASETYPE
    for (const [base, name] of [[0, 'Plex Delay'], [3, 'Plex Verb'], [4, 'Shimmer Verb']] as const) {
      for (const r of await served('plex', { PLEX_BASETYPE: base })) {
        if (r.layout?.variantName !== name) throw new Error(`${profile.key}: plex variant for PLEX_BASETYPE=${base} is ${r.layout?.variantName}`);
      }
    }
    // 4. a family with a type selector is unchanged: the GEQ's band layout follows GEQ_TYPE
    for (const r of await served('geq', { GEQ_TYPE: 2 })) {
      if (r.layout?.variantName !== '7 Band') throw new Error(`${profile.key}: GEQ variant for type 2 is ${r.layout?.variantName}`);
    }
    // 5. the Delay follows its routing type DELAY_TYPE, not its model (DELAY_MODEL is the type selector)
    for (const [routing, model] of [[4, 1], [1, 4], [7, 0]] as const) {
      for (const r of await served('delay', { DELAY_TYPE: routing, DELAY_MODEL: model })) {
        if (r.layout?.family !== 'DELAY' || r.layout.variantName !== String(routing)) throw new Error(`${profile.key}: Delay variant for DELAY_TYPE=${routing} (model ${model}) is ${r.layout?.variantName}`);
      }
    }
    // 6. the driver evaluates the firmware gates against the firmware its context reports: a Tremolo of type 0 is
    //    served its legacy page by a unit older than the gate, the editor's current (catch-all) page by a current
    //    one and by a driver that does not know the firmware — both from the type's own variant
    const bound = { fm3: 8, fm9: 6, axe3: 23 }[profile.key]!;
    for (const [fw, gate] of [[{ major: bound - 1, minor: 0 }, 'lt'], [{ major: bound, minor: 0 }, 'gtet'], [undefined, 'gtet']] as const) {
      for (const r of await served('tremolo', { TREMOLO_TYPE: 0 }, fw)) {
        const pages = r.layout?.pages ?? [];
        if (r.layout?.variantName !== '0,2,4' || pages.length !== 1 || pages[0]!.fw?.[gate] === undefined) {
          throw new Error(`${profile.key}: Tremolo type 0 on firmware ${fw ? `${fw.major}.${fw.minor}` : 'unknown'} is ${r.layout?.variantName} ${JSON.stringify(pages.map((p) => p.fw))}, expected 0,2,4 with its ${gate} page`);
        }
      }
    }
    // 7. the Reverb follows REVERB_BASETYPE as the device stores it — the base type's INDEX in the block body (a
    //    hardware read gives raw 6 for base type 6, which the dial's continuous reading shows as 0.0007), not the
    //    reverb type REVERB_TYPE (the type selector), in both responses (the classic one does not list the param at
    //    all). The catalog row stops at 8, but the current firmware's layouts name base types 9 and 10: raw 9 / 10 are
    //    those base types, not a scaled base type 0 — a reading above the row's top ordinal is an ordinal while it
    //    would unscale onto the bottom one (raw 4095 keys base type 4095: no variant names it, the default answers),
    //    and only a reading large enough to be a 16-bit scaled one is unscaled onto 0..8 (4096 → 1, 32767 → 4,
    //    49151 → 6, 65534 → 8).
    for (const [raw, want] of [
      [6, '1,2,3,6,7,8,9,10'], [1, '1,2,3,6,7,8,9,10'], [4, '4'], [0, '0,5'], [5, '0,5'],
      [9, '1,2,3,6,7,8,9,10'], [10, '1,2,3,6,7,8,9,10'], [4095, 'Default'],
      [4096, '1,2,3,6,7,8,9,10'], [32767, '4'], [49151, '1,2,3,6,7,8,9,10'], [65534, '1,2,3,6,7,8,9,10'],
    ] as const) {
      for (const r of await served('reverb', { REVERB_BASETYPE: raw, REVERB_TYPE: 4 })) {
        if (r.layout?.family !== 'REVERB' || r.layout.variantName !== want) throw new Error(`${profile.key}: Reverb variant for REVERB_BASETYPE raw ${raw} (REVERB_TYPE 4) is ${r.layout?.variantName}, expected ${want}`);
        if (want === '1,2,3,6,7,8,9,10' && r.layout.pages.map((p) => p.name).join(',') !== 'Basic,Advanced,Duck + Mod,EQ,Pitch Shift') {
          throw new Error(`${profile.key}: Reverb base type raw ${raw} pages ${r.layout.pages.map((p) => p.name).join(',')}`);
        }
      }
    }
    // 8. the Looper follows LOOPER_DUB keyed by its raw body value in the classic response: the catalog row has no
    //    usable span (0..0; none at all on the III), so the raw value is the key and the editor's variants '0' / '1'
    //    answer to raw 0 / 1. How the device stores this selector (an ordinal or a scaled value) is not verified on
    //    hardware; this pins the keying the data supports. The generic response serves no LOOPER_DUB (a row without
    //    an informative span is not indexed), so it cannot key by it: it still answers with a Looper layout.
    for (const raw of [0, 1]) {
      const [classic, generic] = await served('looper', { LOOPER_DUB: raw });
      if (classic.layout?.family !== 'LOOPER' || classic.layout.variantName !== String(raw)) throw new Error(`${profile.key}: Looper variant for LOOPER_DUB raw ${raw} is ${classic.layout?.variantName}, expected ${raw}`);
      if (generic.layout?.family !== 'LOOPER') throw new Error(`${profile.key}: generic Looper layout for LOOPER_DUB raw ${raw} is ${generic.layout?.family}`);
    }
  }
  console.log('  drivers/layouts: served variants — cab by CABINET_MODE (not the preamp type), plex by PLEX_BASETYPE, GEQ by its type, Delay by DELAY_TYPE (not its model), Reverb by REVERB_BASETYPE read raw (not its type; base types 9/10 beyond the row), Looper by LOOPER_DUB raw, firmware gates on the firmware the driver reports; classic and generic, FM3/FM9/III');
}

// ── layout firmware over a session: the registry evaluates the layouts against the firmware the connected unit last
// reported. Every firmware read clears the running firmware first, and one the unit does not answer (the full-capture
// gate's refreshFirmware, the diagnostic capture's, a re-detect) leaves it unknown — which used to flip an older unit
// to the newest firmware's layout for the rest of the session. A disconnect / port change, or another model, forgets
// it. Driven through the registry over a mocked unit (identify, fn 0x08, status dump, the Tremolo's block read). ──
const LAYOUT_FIRMWARE_CASES = 1;

async function layoutFirmwareChecks(): Promise<void> {
  for (const profile of [fm3, fm9, axe3]) {
    const model = profile.model;
    const bound = { fm3: 8, fm9: 6, axe3: 23 }[profile.key]!;
    const older = { major: bound - 1, minor: 0 }; // below the Tremolo page's `gtet` gate: the legacy page is the one shown
    const codec = createModernFractalCodec(model);
    const eid = eidOfSlug('tremolo');
    const values = new Array<number>(profile.rangeSections.TREMOLO!.stride * 4).fill(0); // TREMOLO_TYPE 0, channel A
    const statusHex = compactHex(codec.buildStatusDump());
    const pollHex = compactHex(codec.buildBlockBulkReadPoll(eid));
    let identifyAs = model;
    let fwAnswers = true;
    const mock = new MockTransport('serial', `mock-layout-fw-${profile.key}`);
    mock.reply = (req) => {
      if (isIdentifyBroadcast(req)) return [handshakeReply(identifyAs)];
      if (req[0] === 0xf0 && req[5] === 0x08) return fwAnswers ? [[0xf0, 0x00, 0x01, 0x74, model, 0x08, older.major, older.minor, 0x00, 0x00, 0xf7]] : [];
      const h = compactHex(req);
      if (h === statusHex) return [sysex(model, 0x13, [...enc14(eid), 0])];
      if (h === pollHex) return blockBulkFrames(model, eid, values);
      return [];
    };
    const registry = __createRegistryForTest({ resolveConn: async () => ({ transport: 'serial', id: mock.label }), openConn: () => mock });
    const tag = (what: string) => `${profile.key}: ${what}`;
    // the gate of the Tremolo page both responses serve ('lt' = the older firmware's page, 'gtet' = the newest's)
    const served = async (what: string, want: 'lt' | 'gtet') => {
      const d = (await registry.driver()) as Gen3Driver;
      for (const r of [await d.blockParams(eid), await d.blockParams(eid, { generic: true })]) {
        const fw = r.layout?.pages[0]?.fw;
        const got = fw?.lt ? 'lt' : fw?.gtet ? 'gtet' : String(r.layout?.pages.length);
        if (r.layout?.variantName !== '0,2,4' || got !== want) throw new Error(tag(`${what}: Tremolo page ${got} (variant ${r.layout?.variantName}), expected ${want}`));
      }
    };
    const fwIs = (what: string, running: number | null, layout: number | null) => {
      const r = registry.firmwareInfo()?.major ?? null;
      const l = registry.layoutFirmware()?.major ?? null;
      if (r !== running || l !== layout) throw new Error(tag(`${what}: running ${r} / layout ${l}, expected ${running} / ${layout}`));
    };

    await registry.detect();
    fwIs('detect', older.major, older.major);
    await served('detect read the older firmware', 'lt');

    fwAnswers = false;
    if ((await registry.refreshFirmware()) !== null) throw new Error(tag('a silent re-read returns null'));
    fwIs('silent refreshFirmware', null, older.major);
    await served('after a silent refreshFirmware (the unit keeps its older firmware)', 'lt');
    await registry.refreshFirmware({ keepOnSilence: true });
    fwIs('silent refreshFirmware keepOnSilence', null, older.major);
    await registry.detect();
    fwIs('silent re-detect of the same unit', null, older.major);
    await served('after a silent re-detect of the same unit', 'lt');

    // a re-detect that identifies another model forgets it, also once the original model is back
    identifyAs = 0x15;
    await registry.detect();
    fwIs('re-detect as another model (AM4)', null, null);
    identifyAs = model;
    await registry.detect();
    fwIs('back to the original model, firmware still silent', null, null);
    await served('another model came in between', 'gtet');

    // a successful read is remembered again; a port change / dropped connection (selectConnection closes the
    // transport, the next request opens a new one) forgets it
    fwAnswers = true;
    await registry.detect();
    fwIs('re-detect, the read answers again', older.major, older.major);
    await registry.selectConnection(null);
    fwIs('right after the port change', null, null);
    fwAnswers = false;
    await registry.detect(); // opens a new transport
    fwIs('after a port change, firmware silent', null, null);
    await served('after a port change with the firmware unread', 'gtet');
  }
  console.log('  drivers/layouts: layout firmware — a silent firmware re-read (refreshFirmware, re-detect) keeps the older unit on its own layout; another model and a port change / dropped connection forget it; classic and generic, FM3/FM9/III');
}

export const LAYOUTS_CASE_COUNT = checks.length + SERVED_VARIANT_CASES + LAYOUT_FIRMWARE_CASES;

export async function runLayoutsTests(): Promise<void> {
  for (const c of checks) {
    if (!c.ok()) throw new Error(`editor-layout check failed: ${c.name}`);
  }
  await servedVariantChecks();
  await layoutFirmwareChecks();
}