// Editor-layout v2 serving — variant selection + wire passthrough shape, over the REAL device
// profiles wired in src/devices.ts and the AM4 layout resolver. All data-only (no transport):
//   • variant selection: type-value match, amp firmware-pin preference, null/first fallback;
//   • v2 passthrough: pages → rows → controls carry widget/rawWidget/placement/crossBlock verbatim;
//   • AM4 gets a layout for the first time (family mapping via am4LayoutFor).
import { PROFILES, am4LayoutFor, resolveLayoutPages, type DeviceLayout, type SelectorValues } from '../../src/devices.js';
import { EDITOR_WIDGET_KINDS, type EditorLayoutPage } from 'forgefx-midi/gen3/fm3';

const fm3 = PROFILES[0x11]!;
const fm9 = PROFILES[0x12]!;
const axe3 = PROFILES[0x10]!;

// Walk every control of a resolved layout (pages → rows → controls).
function* controlsOf(l: DeviceLayout) {
  for (const p of l.pages) for (const r of p.rows) for (const c of r.controls) yield { page: p, row: r, control: c };
}

// A resolved layout is v2-shaped and every control passes the codec fields through unchanged.
function shapeOk(l: DeviceLayout): boolean {
  if (typeof l.editorName !== 'string' || typeof l.family !== 'string') return false;
  if (typeof l.variantName !== 'string') return false;
  if (!(l.variantValue === null || typeof l.variantValue === 'string')) return false;
  if (!Array.isArray(l.pages) || l.pages.length === 0) return false;
  for (const { page, row, control } of controlsOf(l)) {
    if (typeof page.name !== 'string' || !Array.isArray(page.rows)) return false;
    if (row.section !== 'parameters' && row.section !== 'mixer') return false;
    if (typeof control.label !== 'string') return false;
    if (!(EDITOR_WIDGET_KINDS as readonly string[]).includes(control.widget)) return false;
    if (typeof control.rawWidget !== 'string') return false;
    if (!(control.paramName === null || typeof control.paramName === 'string')) return false;
    if (!(control.paramId === null || typeof control.paramId === 'number')) return false;
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
