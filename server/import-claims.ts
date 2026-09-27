// Shared by the dump import (server/dump-import.ts), which heartbeats its
// segment claims, and the hunt (server/hunt.ts), which checks for live ones.
// Kept apart from dump-import.ts so the hunt needn't load it (and its pool).

/** A segment claim whose heartbeat is older than this is taken to be abandoned. */
export const STALE_CLAIM_SECONDS = 600;
