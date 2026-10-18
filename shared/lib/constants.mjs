// Canonical timing, port and lock constants for both plugins.
//
// Every value here was previously duplicated in at least one plugin, and the
// copies disagreed often enough to produce real bugs (an injector that never
// retired, a lock taken over while its owner still swept). A shared value is
// only useful if it is the SAME value everywhere, so this module is copied
// verbatim into each plugin by scripts/sync-shared.mjs.

export const DEFAULT_SIDECAR_PORT = 7427;
export const DEFAULT_CDP_PORT = 9229;

export const DEFAULT_WINDOW = 10;
export const DEFAULT_REFRESH_MS = 900;
export const MIN_REFRESH_MS = 100;
export const MAX_REFRESH_MS = 60_000;

export const LOCK_STALE_MS = 45_000;
export const LOCK_TOUCH_MS = 15_000;
export const SWEEP_MS = 10_000;
export const INJECTOR_RESTART_MS = 60_000;

export const HTTP_TIMEOUT_MS = 2000;
export const WS_OPEN_TIMEOUT_MS = 4000;
export const CDP_ATTACH_TIMEOUT_MS = 8000;
export const CDP_PROBE_TIMEOUT_MS = 15_000;
export const CDP_INJECT_TIMEOUT_MS = 30_000;
export const CDP_DETACH_TIMEOUT_MS = 2000;
export const STDIN_TIMEOUT_MS = 1500;

export const PILL_ATTACH_TTL_MS = 90_000;
export const SIDECAR_IDLE_MS = 60_000;
export const DASHBOARD_EXTRAS_TTL_MS = 4000;
export const DASHBOARD_EXTRAS_IDLE_MS = 30_000;
