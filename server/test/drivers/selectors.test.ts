// Type / variant selectors and the layout widget index (devices.ts). The type selector is the family's
// `<F>_MODEL` or `<F>_TYPE` by exact name and nothing else; the variant selector (which picks the layout
// variant of a block) additionally falls back to `<F>_BASETYPE`, then `<F>_MODE`. The widget index says
// which widget the editor draws for a parameter id. Catalog data only (no device).
import { PROFILES, typeSelectorPid, variantSelectorPid, layoutWidgetIndex, type DeviceProfile } from '../../src/devices.js';
import { assert, assertEqual } from '../helpers/mock.js';

export const SELECTORS_CASE_COUNT = 6;

const FM3 = PROFILES[0x11]!;
const FM9 = PROFILES[0x12]!;
const AXE3 = PROFILES[0x10]!;

const show = (v: number | undefined) => (v === undefined ? '-' : String(v));

/** family → "type/variant" as the resolution table prints it. */
function resolve(p: DeviceProfile, families: string[]): Record<string, string> {
  return Object.fromEntries(families.map((f) => [f, `${show(typeSelectorPid(p, f))}/${show(variantSelectorPid(p, f))}`]));
}

const SHARED: Record<string, string> = {
  CABINET: '-/31', // no type: the Legacy / DynaCab switch (CABINET_MODE) picks the layout variant
  PLEX: '-/0', // PLEX_BASETYPE
  MULTITAP: '-/0', // MULTITAP_BASETYPE
  GLOBAL: '-/-',
  CONTROLLERS: '-/-',
  MOD: '-/-',
  COMP: '12/12',
  GEQ: '15/15',
  FUZZ: '0/0',
};

// ── 1. the per-device resolution table (type/variant) ──
function resolutionTable(): void {
  const check = (name: string, p: DeviceProfile, expected: Record<string, string>) => {
    const got = resolve(p, Object.keys(expected));
    for (const [fam, want] of Object.entries(expected)) assertEqual(got[fam], want, `${name} ${fam}`);
  };
  check('FM3', FM3, { ...SHARED, DELAY: '6/6', DISTORT: '6/6', REVERB: '0/0' });
  check('FM9', FM9, { ...SHARED, DELAY: '10/10', DISTORT: '10/10', REVERB: '10/10' });
  check('Axe-Fx III', AXE3, { ...SHARED, DELAY: '0/0', DISTORT: '0/0', REVERB: '0/0' });
}

// ── 2. a param that merely ends in TYPE is not a type selector ──
function lookalikesAreNotSelectors(): void {
  for (const [name, p] of [['FM3', FM3], ['FM9', FM9], ['Axe-Fx III', AXE3]] as const) {
    const has = (fam: string, n: string) => (p.params[fam] ?? []).some((d) => d.name === n);
    // the premise: these names exist in the catalog (they are what a "ends in TYPE" guess used to pick)
    assert(has('CABINET', 'CABINET_PRETYPE'), `${name}: CABINET_PRETYPE exists`);
    assert(has('CONTROLLERS', 'CONTROLLERS_LFO1TYPE'), `${name}: CONTROLLERS_LFO1TYPE exists`);
    assert(has('GLOBAL', 'GLOBAL_CC_BYPASS_TYPE'), `${name}: GLOBAL_CC_BYPASS_TYPE exists`);
    assert(has('PLEX', 'PLEX_FILTERTYPE'), `${name}: PLEX_FILTERTYPE exists`);
    // and none of them resolves as a type selector
    for (const fam of ['CABINET', 'CONTROLLERS', 'GLOBAL', 'PLEX', 'MULTITAP']) assertEqual(typeSelectorPid(p, fam), undefined, `${name} ${fam}: no type selector`);
  }
}

// ── 3. MODEL before TYPE, exact names, first definition wins ──
function precedence(): void {
  const synth = (names: string[]): DeviceProfile => ({
    params: { Z: names.map((name, i) => ({ paramId: 10 + i, name, unit: 'enum' })) },
  }) as unknown as DeviceProfile;
  assertEqual(typeSelectorPid(synth(['Z_TYPE', 'Z_MODEL']), 'Z'), 11, 'MODEL wins over TYPE whatever the order');
  assertEqual(typeSelectorPid(synth(['Z_TYPE']), 'Z'), 10, 'TYPE when there is no MODEL');
  assertEqual(typeSelectorPid(synth(['Z_PRETYPE', 'Z_FILTERTYPE', 'ZED_TYPE']), 'Z'), undefined, 'a name that only ends in TYPE is not a selector');
  assertEqual(variantSelectorPid(synth(['Z_MODE', 'Z_BASETYPE', 'Z_TYPE']), 'Z'), 12, 'variant: TYPE first');
  assertEqual(variantSelectorPid(synth(['Z_MODE', 'Z_BASETYPE']), 'Z'), 11, 'variant: BASETYPE before MODE');
  assertEqual(variantSelectorPid(synth(['Z_MODE']), 'Z'), 10, 'variant: MODE last');
  assertEqual(variantSelectorPid(synth(['Z_OTHER']), 'Z'), undefined, 'variant: none');
  assertEqual(typeSelectorPid(synth([]), 'MISSING'), undefined, 'a family the profile does not have');
  assertEqual(typeSelectorPid(synth(['Z_MODEL', 'Z_MODEL']), 'Z'), 10, 'the first definition of a name wins');
}

// ── 4. the widget index on the committed layouts ──
function layoutIndexCatalog(): void {
  const global = layoutWidgetIndex(FM3, 'GLOBAL');
  assertEqual(global.get(7115), 'knob', 'FM3 GLOBAL_FS_BRIGHTNESS is drawn as a knob');
  assertEqual(global.get(3602), 'dropdown', 'FM3 GLOBAL_FC_DEFAULT_LAYOUT_PFC1 is drawn as a dropdown');
  assertEqual(layoutWidgetIndex(FM3, 'CABINET').get(43), 'dropdown', 'the cab preamp type is a dropdown');
  for (const [name, p] of [['FM3', FM3], ['FM9', FM9], ['Axe-Fx III', AXE3]] as const) {
    assertEqual(layoutWidgetIndex(p, 'CABINET').get(65286), undefined, `${name}: the button pseudo id 65286 is not indexed`);
    const layouts = p.editorLayouts!;
    for (const fam of Object.keys(layouts)) {
      for (const pid of layoutWidgetIndex(p, fam).keys()) assert(pid <= 0x3fff, `${name} ${fam} ${pid}: only wire pids are indexed`);
    }
  }
  assertEqual(layoutWidgetIndex(FM3, 'NOPE').size, 0, 'an unknown family has no evidence');
  assert(layoutWidgetIndex(FM3, 'GLOBAL') === layoutWidgetIndex(FM3, 'GLOBAL'), 'memoised: the same map comes back');
}

// ── 5. the walk: ownership, pseudo ids, conflicts ──
function layoutIndexSynthetic(): void {
  type Ctl = { label: string; paramName: string | null; paramId: number | null; widget: string; rawWidget: string; crossBlock?: unknown };
  const ctl = (paramId: number | null, widget: string, crossBlock?: Ctl['crossBlock']): Ctl => ({
    label: '', paramName: paramId == null ? null : `P_${paramId}`, paramId, widget, rawWidget: widget, ...(crossBlock ? { crossBlock } : {}),
  });
  const layouts = {
    AA: {
      editorName: 'A', family: 'AA',
      variants: [
        { name: 'v1', value: null, pages: [{ name: 'p1', rows: [{ section: 'parameters', controls: [
          ctl(1, 'knob'), ctl(1, 'dropdown'), // a non-knob wins
          ctl(2, 'knob'), ctl(2, 'slider'),
          ctl(3, 'toggle'), ctl(3, 'dropdown'), // the selector kinds rank dropdown before toggle
          ctl(4, 'label'), ctl(4, 'dropdown'),
          ctl(9, 'graph'), ctl(9, 'knob'), // a display-only kind ranks below a knob
          ctl(10, 'button'), ctl(10, 'toggle'),
          ctl(11, 'meter'), // alone it is still the evidence there is
          ctl(12, 'label'), ctl(12, 'readout'), // among display-only kinds the first stays
          ctl(13, 'unknown'), ctl(13, 'knob'), // an input kind the normaliser did not recognise outranks a knob
          ctl(0xff00, 'dropdown'), // a pseudo id
          ctl(0x4000, 'dropdown'), // not a wire pid either
          ctl(null, 'spacer'),
          ctl(5, 'knob', { effect: 'ID_B', family: 'BB', paramName: 'BB_X', paramId: 9 }), // owned by BB, at the referenced pid
          ctl(6, 'dropdown', { effect: 'ID_C', family: null, paramName: null, paramId: null }), // an unresolved reference names nothing
        ] }] }] },
        { name: 'v2', value: '1', pages: [{ name: 'p2', rows: [{ section: 'parameters', controls: [
          ctl(7, 'knob'), ctl(8, 'dropdown'),
        ] }] }] },
      ],
    },
  };
  const p = { editorLayouts: layouts } as unknown as DeviceProfile;
  const aa = layoutWidgetIndex(p, 'AA');
  assertEqual(aa.get(1), 'dropdown', 'a non-knob wins over a knob');
  assertEqual(aa.get(2), 'slider', 'a slider wins over a knob');
  assertEqual(aa.get(3), 'dropdown', 'dropdown ranks before toggle');
  assertEqual(aa.get(4), 'dropdown', 'a dropdown outranks a label');
  assertEqual(aa.get(9), 'knob', 'a graph does not outrank a knob');
  assertEqual(aa.get(10), 'toggle', 'a button does not outrank a toggle');
  assertEqual(aa.get(11), 'meter', 'a lone display-only control is indexed');
  assertEqual(aa.get(12), 'label', 'display-only kinds tie: the first stays');
  assertEqual(aa.get(13), 'unknown', 'an unrecognised input widget outranks a knob');
  assertEqual(aa.get(0xff00), undefined, 'pseudo ids are skipped');
  assertEqual(aa.get(0x4000), undefined, 'ids above 0x3FFF are skipped');
  assertEqual(aa.get(5), undefined, 'a cross-block control is not the layout family\'s');
  assertEqual(aa.get(6), undefined, 'an unresolved cross-block reference is skipped');
  assertEqual(aa.get(7), 'knob', 'every variant is walked (v2)');
  assertEqual(aa.get(8), 'dropdown', 'every variant is walked (v2)');
  assertEqual(layoutWidgetIndex(p, 'BB').get(9), 'knob', 'the referenced family owns the control, at the referenced pid');
  assertEqual(layoutWidgetIndex(p, 'BB').get(5), undefined, 'the control\'s own pid is not used for a cross-block control');
}

// ── 6. no layouts, memo per layouts object ──
function layoutIndexEdges(): void {
  const none = { params: {} } as unknown as DeviceProfile;
  assertEqual(layoutWidgetIndex(none, 'AA').size, 0, 'a profile without editor layouts has no evidence');
  const layouts = { AA: { editorName: 'A', family: 'AA', variants: [{ name: 'v', value: null, pages: [{ name: 'p', rows: [{ section: 'parameters', controls: [{ label: '', paramName: 'X', paramId: 1, widget: 'toggle', rawWidget: 'toggle' }] }] }] }] } };
  const a = { editorLayouts: layouts } as unknown as DeviceProfile;
  const b = { editorLayouts: layouts } as unknown as DeviceProfile;
  assert(layoutWidgetIndex(a, 'AA') === layoutWidgetIndex(b, 'AA'), 'profiles that share a layouts object share the index (memoised per layouts object)');
  // a runtime profile keeps the static profile's layouts, so the evidence is the same object
  const runtime = { ...FM3 } as DeviceProfile;
  assert(layoutWidgetIndex(runtime, 'GLOBAL') === layoutWidgetIndex(FM3, 'GLOBAL'), 'a derived profile reuses the bundled index');
}

export function runSelectorsTests(): void {
  resolutionTable();
  lookalikesAreNotSelectors();
  precedence();
  layoutIndexCatalog();
  layoutIndexSynthetic();
  layoutIndexEdges();
}
