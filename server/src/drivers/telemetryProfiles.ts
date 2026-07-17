// Telemetry cadence profiles — the per-mode, per-family polling/smoothing cadences the registry
// supervisor resolves AT RESCHEDULE TIME (so a mode switch applies on the next tick). BROWSER-SAFE:
// pure data + a resolver, NO node:/transport imports (check-browser-safe.ts gates this module because
// registryCore.ts — which loads in a browser runtime — imports it).
//
// Modes:
//   performance — tightest cadence (snappiest meters/edit-watch), highest link cost.
//   balanced    — server DEFAULT. Slightly relaxed meter tick + edit-watch vs. today (invisible
//                 smoothing); scene/channel latency held stable by keeping the every-Nth offsets at 8.
//   reduced      — coarsest cadence for constrained links / battery.
// (AM4 latched-rehash is now disabled in ALL modes — see editRehashMs below.)

export type TelemetryMode = 'performance' | 'balanced' | 'reduced';

/** One resolved cadence bundle the supervisor reads its reschedule/every-Nth/smoothing values from. */
export interface CadenceProfile {
  /** Meter round-robin reschedule on a fast link (ms). Also the first-tick primer. */
  meterTickMs: number;
  /** Meter reschedule on a slow (5-pin DIN) link (ms). */
  meterSlowMs: number;
  /** Run the (heavy) CPU read once every N meter ticks. */
  cpuEveryNTicks: number;
  /** Run the front-panel active-channel watch once every N meter ticks. */
  channelEveryNTicks: number;
  /** Run the front-panel scene watch once every N meter ticks. */
  sceneEveryNTicks: number;
  /** Device-edit watch poll reschedule on a fast link (ms). */
  editWatchMs: number;
  /** Device-edit watch poll reschedule on a slow link (ms). */
  editWatchSlowMs: number;
  /** Tuner poll reschedule (ms) — unchanged per family (gen-3 55, AM4 100), all modes. */
  tunerMs: number;
  /** AM4 edit-watch content-rehash interval (ms); 0 = disabled. Consumed by the AM4 edit-watch
   *  redesign (a later work item) via DriverCtx.getCadence — exposed here now, unused by gen-3. */
  editRehashMs: number;
}

/** The mode set — the order the /telemetry/config DTO advertises. */
export const TELEMETRY_MODES: readonly TelemetryMode[] = ['performance', 'balanced', 'reduced'];

/** True for a value the mode enum accepts (route validation). */
export function isTelemetryMode(v: unknown): v is TelemetryMode {
  return typeof v === 'string' && (TELEMETRY_MODES as readonly string[]).includes(v);
}

type Family = 'gen3' | 'am4' | 'generic';

/** Group a model byte into a cadence family. gen-3 = Axe-Fx III / FM3 / FM9 / VP4; AM4 = 0x15;
 *  everything else (gen-1/gen-2, or an unidentified/null model) → the generic row. */
function familyFor(modelId: number | null): Family {
  if (modelId == null) return 'generic';
  if (modelId === 0x15) return 'am4';
  if (modelId === 0x10 || modelId === 0x11 || modelId === 0x12 || modelId === 0x14) return 'gen3';
  return 'generic';
}

const MODE_INDEX: Record<TelemetryMode, 0 | 1 | 2> = { performance: 0, balanced: 1, reduced: 2 };

/**
 * Resolve the cadence for a model byte (null = not-yet-identified / generic) and mode. The BALANCED
 * default deliberately relaxes the gen-3 meter tick (100 vs today's 60) and edit-watch (2000 vs 1500)
 * for invisible smoothing, while holding scene/channel absolute latency roughly stable by keeping the
 * every-Nth offsets at 8. Tuner cadence is family-fixed and mode-independent (gen-3 55, AM4 100).
 */
export function cadenceFor(modelId: number | null, mode: TelemetryMode): CadenceProfile {
  const i = MODE_INDEX[mode] ?? MODE_INDEX.balanced;
  const fam = familyFor(modelId);
  return {
    meterTickMs: [60, 100, 400][i]!,
    meterSlowMs: 2000,
    cpuEveryNTicks: [8, 8, 16][i]!,
    channelEveryNTicks: 8,
    sceneEveryNTicks: 8,
    editWatchMs: [1500, 2000, 4000][i]!,
    editWatchSlowMs: [4000, 4000, 8000][i]!,
    tunerMs: fam === 'am4' ? 100 : 55,
    // Latched-rehash DISABLED in every mode (FORGEFX-25 follow-up): while the AM4 active-buffer edited
    // bit stays latched (e.g. after a channel swap), periodically re-dumping all placed blocks via fn-0x1F
    // put a ~2.7 KB multi-frame burst on the AM4 MIDI link every few seconds and audibly glitched its
    // audio engine. Reloads now ride the CHEAP transitions only (dirty-onset false→true, scene, channel,
    // save true→false); a 2nd on-device tweak while already dirty reflects on the next such event.
    editRehashMs: [0, 0, 0][i]!
  };
}
