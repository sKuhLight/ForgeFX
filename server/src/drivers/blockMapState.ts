// What a block-map entry means for serving a block: its state as clients see it (`definitions.blockMap.state` of the
// generic block params and `blocks[].state` of the definitions diff — ONE mapping for both), and whether its params
// are served and may be written. A block-map entry binds an effect id the catalog cannot place on its own to
// definitions (the codec's matcher, forgefx-midi `cache/blockMap.ts`; the Axe-Fx III effect-id table's `roster`
// entries; the runtime bulk-shape match):
//
//   confidence                      state        params served                 writes
//   confirmed + device-records|pack confirmed    generic (named for a family)  allowed (M2 guards), kill switch below
//   confirmed + live-only           confirmed    generic from the live rows    refused (409): a walk guesses kinds
//   likely (runtime bulk shape)     likely       generic from the section      refused (409)
//   roster (effect-id table only)   likely       named from the catalog        refused (409)
//   catalog                         confirmed    (implied: never listed)       —
//   candidate / anything else       candidates   none                          unchanged (no information, no guard)
//   no entry                        none         none                          unchanged
//
// `roster` maps to `likely`: the family is known but no device read has bound it, exactly what `likely` says of a
// section matched by its shape — served for reading, never written, until device evidence confirms it.
//
// Pure and browser-safe (no imports).

/** Kill switch for writes to blocks bound by the block map (contract R3): false makes every block-map binding
 *  read-only, `confirmed` byte-bridged ones included. */
export const BLOCK_MAP_WRITES_ENABLED = true;

export type BlockMapState = 'confirmed' | 'likely' | 'candidates' | 'none';

/** The client-facing state of a block-map confidence (see the module table). */
export function blockMapState(confidence: unknown): BlockMapState {
  switch (confidence) {
    case 'confirmed':
    case 'catalog':
      return 'confirmed';
    case 'likely':
    case 'roster':
      return 'likely';
    case 'candidate':
      return 'candidates';
    default:
      return 'none';
  }
}

/** Why a served block's params are read-only (the block, not the param). */
export type BlockReadOnlyReason = 'unconfirmed-block' | 'live-only-block';

/** How a block bound by a block-map entry is served. */
export interface BlockMapAccess {
  state: BlockMapState;
  /** Params are served (`named` / `enums`); false = the block lists nothing. */
  serves: boolean;
  /** Param writes reach the device (subject to the M2 guards); false with `serves` = read-only. */
  writable: boolean;
  /** Set when params are served but not writable. */
  readOnlyReason?: BlockReadOnlyReason;
}

/** How a block bound by `entry` is served (see the module table). An entry without any confidence (none known) serves
 *  nothing and leaves writes as they were. */
export function blockMapAccess(entry: { confidence?: unknown; evidence?: readonly unknown[] } | null | undefined): BlockMapAccess {
  const state = blockMapState(entry?.confidence);
  if (state === 'candidates' || state === 'none') return { state, serves: false, writable: true };
  if (state === 'likely') return { state, serves: true, writable: false, readOnlyReason: 'unconfirmed-block' };
  const evidence = entry?.evidence ?? [];
  const exact = evidence.includes('device-records') || evidence.includes('pack');
  if (!exact) return { state, serves: true, writable: false, readOnlyReason: evidence.includes('live-only') ? 'live-only-block' : 'unconfirmed-block' };
  return BLOCK_MAP_WRITES_ENABLED ? { state, serves: true, writable: true } : { state, serves: true, writable: false, readOnlyReason: 'unconfirmed-block' };
}

/** The message of a refused write to a block without confirmed definitions (409). */
export function blockWriteRefusedMessage(eid: number): string {
  return `block ${eid} has no confirmed definitions on this device; write refused`;
}
