// Row-by-row comparison of a built device profile against the bundled catalog (extracted from
// scripts/profile-check.ts so the editor-cache contribution validation reuses the exact same count).
// Pure and browser-safe: codec cache helpers + the param index's wire-pid bound, no I/O.
import { isInformativeRow, isSyntheticFamilyKey, paramFingerprint, rowsCompatible, type BuiltCache } from 'forgefx-midi/cache';
import type { DeviceProfile } from '../devices.js';
import { MAX_WIRE_PID } from './paramIndex.js';

/** How a profile's informative rows relate to the catalog's, before any naming rule is applied. */
export interface RowComparison {
  /** Same fingerprint as the catalog row. */
  exact: number;
  /** A compatible revision of the catalog row (`rowsCompatible`). */
  compatible: number;
  /** Neither. */
  incompatible: number;
  /** No informative catalog row at this pid. */
  newRows: number;
  /** Informative catalog rows the profile lacks (byte-exact profiles only; null otherwise). */
  removed: number | null;
  /** Families left out (the suspects passed in). */
  skippedFamilies: string[];
  /** family → the new pids. */
  newByFamily: Record<string, number[]>;
}

/** The profile's rows against the catalog's, row by row, before any naming rule is applied: how many
 *  informative profile rows carry the catalog row's fingerprint (exact), a compatible revision of it, an
 *  incompatible one, or have no informative catalog row at all (new). It also covers the rows the index
 *  hides (type, bypass) and the families no block reaches, so it is a wider count than the index histogram.
 *  `suspects` are skipped; for a byte-exact family it also counts the catalog rows the profile no longer has.
 *  `byteExact`: the whole profile, or per family (`ProfileFacts.isByteExactFamily`: a merged profile document can
 *  provide some families from a live walk only); `removed` stays null until a byte-exact family is compared. */
export function compareRows(built: BuiltCache, staticProfile: DeviceProfile, suspects: readonly string[], byteExact: boolean | ((family: string) => boolean)): RowComparison {
  const base = staticProfile.staticBase ?? staticProfile;
  const isByte = typeof byteExact === 'function' ? byteExact : () => byteExact;
  const out: RowComparison = { exact: 0, compatible: 0, incompatible: 0, newRows: 0, removed: byteExact === true ? 0 : null, skippedFamilies: [...suspects], newByFamily: {} };
  for (const [fam, rows] of Object.entries(built.ranges ?? {})) {
    // a synthetic family (`section:<tag>` / `block:<eid>`, an unassigned section of a profile v2 doc) is no
    // catalog family: it has nothing to compare with, and its rows are not new rows of a known family
    if (suspects.includes(fam) || isSyntheticFamilyKey(fam)) continue;
    const cat = base.ranges[fam] ?? {};
    const own = built.enumOverrides?.[fam] ?? {};
    for (const [k, e] of Object.entries(rows)) {
      const pid = Number(k);
      if (pid > MAX_WIRE_PID || !isInformativeRow(e)) continue;
      const c = cat[pid];
      if (!c || !isInformativeRow(c)) { out.newRows++; (out.newByFamily[fam] ??= []).push(pid); continue; }
      if (c.synthetic) { if (c.kind === e.kind) out.compatible++; else out.incompatible++; continue; }
      const ownLabels = own[String(pid)];
      const catLabels = base.enumLabelsFor(fam, pid);
      if (paramFingerprint(c, catLabels) === paramFingerprint(e, ownLabels)) out.exact++;
      else if (rowsCompatible(c, catLabels, e, ownLabels)) out.compatible++;
      else out.incompatible++;
    }
    if (isByte(fam)) {
      out.removed ??= 0;
      for (const [k, c] of Object.entries(cat)) {
        const pid = Number(k);
        if (pid > MAX_WIRE_PID || !isInformativeRow(c) || c.synthetic) continue;
        const e = rows[pid];
        if (!e || !isInformativeRow(e)) out.removed = (out.removed ?? 0) + 1;
      }
    }
  }
  return out;
}

/** Share of the compared rows that agree with the catalog: `(exact + compatible) / (exact + compatible +
 *  incompatible)`, 0 when nothing could be compared. New rows are not part of it (a newer firmware adds rows). */
export function catalogAgreement(c: Pick<RowComparison, 'exact' | 'compatible' | 'incompatible'>): number {
  const n = c.exact + c.compatible + c.incompatible;
  return n > 0 ? (c.exact + c.compatible) / n : 0;
}
