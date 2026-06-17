// src/daemon-entry.js — the detached daemon entrypoint: starts the poll loop and logs any fatal error.

import { runDaemonLoop } from "./daemon.js";

runDaemonLoop().catch((err) => {
  console.error(`contextspin daemon crashed: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
