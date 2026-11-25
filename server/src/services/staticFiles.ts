// Path resolution for the optional static SPA handler (FORGEFX_STATIC; see app.ts). Node-only.
//
// A request path is decoded once and joined under the root; the result must stay INSIDE the root by a
// real containment check (`path.relative`, no `..` step, same drive), not a string prefix: a plain
// `startsWith(root)` also accepts a sibling folder whose name starts with the root's (`/srv/ui-private`
// for the root `/srv/ui`). Malformed percent-encoding and NUL bytes are a client error, not a crash.
// On Windows a segment naming a reserved device (`CON`, `NUL`, `COM1.txt`, …) or holding a `:` (drive or
// alternate data stream syntax) is refused before any file system call: opening such a "file" reads a
// device and never ends. The handler is public, so this is decided here, without touching the disk.
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type StaticTarget =
  | { kind: 'file'; path: string } // inside the root (may not exist: the caller falls back to index.html)
  | { kind: 'index' } // the root itself
  | { kind: 'outside' } // escapes the root → 404
  | { kind: 'reserved' } // a Windows device name or `:` in a segment → 404
  | { kind: 'invalid-url' }; // undecodable path → 400

/** A Windows reserved device name, with or without an extension (trailing spaces/dots are ignored there). */
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$) *(\..*)?$/i;

/** Where a request URL (path + optional query) points under `root` (an absolute, resolved directory).
 *  `platform` defaults to this process's; the tests pass one. */
export function staticTarget(root: string, url: string, platform: NodeJS.Platform = process.platform): StaticTarget {
  const rawPath = url.split('?')[0] || '/';
  let p: string;
  try { p = decodeURIComponent(rawPath); } catch { return { kind: 'invalid-url' }; }
  if (p.includes('\0')) return { kind: 'invalid-url' };
  if (platform === 'win32' && p.split(/[\\/]/).some((s) => s.includes(':') || WIN_RESERVED.test(s))) return { kind: 'reserved' };
  // join (not resolve) so an absolute-looking request path never replaces the root
  const target = resolve(join(root, p));
  const rel = relative(root, target);
  if (rel === '') return { kind: 'index' };
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return { kind: 'outside' };
  return { kind: 'file', path: target };
}
