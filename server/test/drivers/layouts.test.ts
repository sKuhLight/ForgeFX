// Editor-layout v2 serving — variant selection + wire passthrough shape, over the REAL device
// profiles wired in src/devices.ts and the AM4 layout resolver. All data-only (no transport):
//   • variant selection: type-value match, amp firmware-pin preference, null/first fallback;
//   • v2 passthrough: pages → rows → controls carry widget/rawWidget/placement/crossBlock verbatim;
//   • page-level controls (`pageControls`): served beside the rows with the same per-control treatment;
//   • AM4 gets a layout for the first time (family mapping via am4LayoutFor).
import { PROFILES, am4LayoutFor, resolveLayoutPages, type DeviceLayout, type SelectorValues } from '../../src/devices.js';
import { EDITOR_WIDGET_KINDS, FM3_LAYOUTS, FM3_PARAMS_BY_FAMILY, type DeviceEditorLayouts, type EditorLayoutControl, type EditorLayoutPage } from 'forgefx-midi/gen3/fm3';
import { FM9_LAYOUTS } from 'forgefx-midi/gen3/fm9';
import { AXE3_LAYOUTS } from 'forgefx-midi/gen3/axe-fx-iii';

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
  { name: "AM4 'amp' → DISTORT layout (editorName 'Global')", ok: () => {
    const l = am4LayoutFor('amp'); return l?.family === 'DISTORT' && l.editorName === 'Global'; } },
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
  { name: 'fw rule: only lt-only siblings → newest reaches the highest lt bound', ok: () => {
    const pages: EditorLayoutPage[] = [
      { name: 'X', rows: [], fw: { lt: '6,00' } }, { name: 'X', rows: [], fw: { lt: '12,00' } },
    ];
    const out = resolveLayoutPages(pages);
    return out.length === 1 && out[0]!.fw?.lt === '12,00'; } },

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
    return labels.length === 2 && labels.join(',') === 'keep-plain,keep-gtet'; } },
];

export const LAYOUTS_CASE_COUNT = checks.length;

export function runLayoutsTests(): void {
  for (const c of checks) {
    if (!c.ok()) throw new Error(`editor-layout check failed: ${c.name}`);
  }
}
