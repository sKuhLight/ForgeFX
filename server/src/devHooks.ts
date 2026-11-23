// Development hooks: environment variables that change what the server serves or walks, for an acceptance run or a
// test session only — `FORGEFX_WALK_SCOPE_OVERRIDE` (services/walkScope.ts), `FORGEFX_DEFS_HIDE_FAMILY` (devices.ts)
// and `FORGEFX_DEFS_FORCE_GENERIC` (drivers/gen3.ts). Every hook reads its value through `devHookValue`, which
// ignores it unless the environment ALSO opts in explicitly with `FORGEFX_DEV_HOOKS=1`, and always when
// `NODE_ENV=production`. The opt-in matters because the packaged desktop app never sets `NODE_ENV` (it tells a
// release build apart by other means), so a production check alone would leave the hooks live in a release.
// An ignored hook is announced with one warning line per hook and distinct value.
//
// Pure and browser-safe: no imports at all (the device profiles, the gen-3 driver and the walk-scope gates use it).
// A browser runtime has no process environment (`processEnv()` is undefined there), so it never reads a hook.

/** Name of the explicit opt-in every development hook needs (value `1`). */
export const DEV_HOOKS_ENV = 'FORGEFX_DEV_HOOKS';

/** An environment to read hooks from (`process.env`, or a test's own record). */
export type HookEnv = Readonly<Record<string, string | undefined>>;

/** The Node process environment, through a guarded access: undefined in a browser runtime. */
export function processEnv(): HookEnv | undefined {
  return typeof process !== 'undefined' && process && typeof process.env === 'object' ? process.env : undefined;
}

/** Why a set hook is not used, or that it is. */
type HookState = 'production' | 'no-opt-in' | 'active';

/** Is the explicit opt-in set (`FORGEFX_DEV_HOOKS=1`, surrounding whitespace ignored)? */
const optedIn = (env: HookEnv): boolean => env[DEV_HOOKS_ENV]?.trim() === '1';

/** Development hooks are usable in `env`: the explicit opt-in is set and `NODE_ENV` is not `production`. */
export function devHooksEnabled(env: HookEnv | undefined): boolean {
  return !!env && env.NODE_ENV !== 'production' && optedIn(env);
}

/** The last state seen per hook (a warning is printed only when it changes into an ignored one). */
const lastSeen = new Map<string, string>();

/**
 * The raw value of the development hook `name` in `env`: undefined when it is unset or blank, and when it is
 * ignored — under `NODE_ENV=production`, or without the explicit opt-in `FORGEFX_DEV_HOOKS=1`. A set hook that is
 * ignored is announced with one warning line per distinct (value, reason); an active one is the hook's own business
 * to announce. The value is returned as set (the hook trims and parses it).
 */
export function devHookValue(env: HookEnv | undefined, name: string): string | undefined {
  const raw = env?.[name];
  if (!env || raw === undefined || raw.trim() === '') return undefined;
  const state: HookState = env.NODE_ENV === 'production' ? 'production' : optedIn(env) ? 'active' : 'no-opt-in';
  const key = `${state}|${raw}`;
  if (lastSeen.get(name) !== key) {
    lastSeen.set(name, key);
    if (state === 'production') console.warn(`[forgefx] ${name} is ignored in production`);
    else if (state === 'no-opt-in') console.warn(`[forgefx] ${name} is ignored: development hooks need ${DEV_HOOKS_ENV}=1`);
  }
  return state === 'active' ? raw : undefined;
}
