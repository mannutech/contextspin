// src/refresh-entry.js — detached one-shot refresh for the DAEMONLESS engine.
//
// The statusline render spawns this (fire-and-forget) when a source is due. It
// is lock-guarded so frequent renders can never spawn overlapping refreshes:
// it acquires REFRESH_LOCK_PATH atomically (overriding a stale lock), runs one
// refresh pass, and releases the lock. If the lock is held and fresh, it exits
// immediately without doing anything.

import fs from "node:fs";
import { REFRESH_LOCK_PATH, REFRESH_LOCK_TTL_MS } from "./config.js";
import { runRefreshOnce } from "./daemon.js";

/**
 * Try to acquire the refresh lock. Uses an exclusive create ("wx"); if the lock
 * exists but is older than the TTL it is treated as stale and overridden.
 * @returns {boolean} true if acquired.
 */
function acquireLock() {
  try {
    fs.writeFileSync(REFRESH_LOCK_PATH, String(Date.now()), { flag: "wx" });
    return true;
  } catch {
    // Lock exists — override it only if stale.
    try {
      const age = Date.now() - Number(fs.readFileSync(REFRESH_LOCK_PATH, "utf8")) || 0;
      if (age >= REFRESH_LOCK_TTL_MS) {
        fs.writeFileSync(REFRESH_LOCK_PATH, String(Date.now()));
        return true;
      }
    } catch {
      // unreadable lock — leave it; another runner owns it
    }
    return false;
  }
}

/** Release the refresh lock (best-effort). */
function releaseLock() {
  try {
    fs.rmSync(REFRESH_LOCK_PATH, { force: true });
  } catch {
    // ignore
  }
}

if (!acquireLock()) {
  // A fresh refresh is already in flight; nothing to do.
  process.exit(0);
}

runRefreshOnce({})
  .catch((err) => {
    console.error(`contextspin refresh failed: ${err && err.message ? err.message : err}`);
  })
  .finally(() => {
    releaseLock();
    process.exit(0);
  });
