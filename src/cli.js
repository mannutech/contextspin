#!/usr/bin/env node
// src/cli.js — Commander-based command-line interface for ContextSpin.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import {
  CONFIG_PATH,
  STATUSLINE_SH,
  CLAUDE_SETTINGS_PATH,
  configExists,
  loadConfig,
  saveConfig,
  normalizeConfig,
  defaultConfig,
} from './config.js';
import {
  startDaemonDetached,
  stopDaemon,
  isDaemonRunning,
  readCache,
} from './daemon.js';
import { installStatusline, uninstallStatusline } from './inject/statusline.js';
import { installPatcher, restorePatcher } from './inject/patcher.js';
import { detectSources } from './detect.js';

/** Absolute path to this module's directory. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Absolute path to the package root (one level up from src/). */
const ROOT = path.resolve(HERE, '..');

/**
 * Read the package version from package.json, resolved relative to this module
 * (never hard-coded). Falls back to "0.1.0" if it cannot be read.
 * @returns {string}
 */
function readVersion() {
  try {
    const pkgPath = path.join(ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || '0.1.0';
  } catch {
    return '0.1.0';
  }
}

/**
 * Wrap an async command action so any thrown error prints a single clean line
 * and exits with code 1.
 * @param {(...args:any[])=>Promise<void>} fn
 * @returns {(...args:any[])=>Promise<void>}
 */
function action(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.error(`contextspin: ${message}`);
      process.exit(1);
    }
  };
}

/**
 * Format a millisecond age into a short human string (e.g. "12s", "3m", "2h").
 * @param {number} ms
 * @returns {string}
 */
function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/**
 * Print the "next steps" hint shown when no config is present.
 * @returns {void}
 */
function printSetupHint() {
  console.error('No ContextSpin config found.');
  console.error('Run: contextspin setup');
}

/**
 * Run the setup command: create a config either non-interactively (a REAL
 * config built from detected sources) or via an interactive prompt.
 * @param {{ yes?: boolean }} opts
 * @returns {Promise<void>}
 */
async function runSetup(opts = {}) {
  const interactive = process.stdin.isTTY && !opts.yes;

  if (!interactive) {
    // Non-TTY or --yes: write a real detected config unless one already exists.
    if (configExists()) {
      console.log(`Config already exists at ${CONFIG_PATH} (left unchanged).`);
    } else {
      const cfg = normalizeConfig(defaultConfig(await detectSources()));
      await saveConfig(cfg, CONFIG_PATH);
      console.log(`Wrote a detected config to ${CONFIG_PATH}`);
    }
    console.log('');
    console.log('Next steps:');
    console.log('  contextspin start    # start the background daemon');
    console.log('  contextspin inject   # wire up your Claude Code status bar');
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    if (configExists()) {
      const ans = (
        await rl.question(
          `A config already exists at ${CONFIG_PATH}. Overwrite? (y/N) `,
        )
      )
        .trim()
        .toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        console.log('Keeping the existing config. Nothing changed.');
        return;
      }
    }

    const modeRaw = (
      await rl.question('Injection mode? statusline / patcher / both [statusline]: ')
    )
      .trim()
      .toLowerCase();
    const mode = ['statusline', 'patcher', 'both'].includes(modeRaw)
      ? modeRaw
      : 'statusline';

    const refreshRaw = (
      await rl.question('Refresh interval in seconds [30]: ')
    ).trim();
    const refreshParsed = Number.parseInt(refreshRaw, 10);
    const refresh = Number.isFinite(refreshParsed) && refreshParsed > 0
      ? refreshParsed
      : 30;

    /** @type {Array<object>} */
    let sources = [];
    const seedAns = (
      await rl.question(
        'Seed the safe starter sources detected for your environment? (Y/n) ',
      )
    )
      .trim()
      .toLowerCase();
    if (seedAns !== 'n' && seedAns !== 'no') {
      // Read-only starters detected from the local environment (gh/glab).
      sources = await detectSources();
    }

    const config = normalizeConfig({
      ...defaultConfig(sources),
      injection: { mode, refresh },
    });
    await saveConfig(config, CONFIG_PATH);
    console.log(`Saved config to ${CONFIG_PATH}`);
    console.log('');
    console.log('Next steps:');
    console.log('  contextspin start    # start the background daemon');
    console.log('  contextspin inject   # wire up your Claude Code status bar');
  } finally {
    rl.close();
  }
}

/**
 * Whether the Claude Code statusLine is already pointing at our wrapper.
 * Best-effort: any read/parse/missing-file error -> false.
 * @returns {boolean}
 */
function statuslineIsOurs() {
  try {
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return false;
    const parsed = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    const sl = parsed && parsed.statusLine;
    return !!(sl && typeof sl === 'object' && sl.command === STATUSLINE_SH);
  } catch {
    return false;
  }
}

/**
 * The ENSURE flow: idempotent, non-interactive, safe to run every session
 * (this is what the plugin SessionStart hook invokes). It:
 *   (a) creates a detected config if none exists,
 *   (b) wires the statusline if the mode is statusline/both and it is not
 *       already pointing at our wrapper, and
 *   (c) starts the daemon if it is not already running.
 * Prints a concise one-line summary. Never throws on the normal paths; any
 * error prints a clean line and the process still exits 0 (the hook depends on
 * this — a non-zero exit would surface an error to the user every session).
 * @returns {Promise<void>}
 */
async function runEnsure() {
  /** @type {string[]} */
  const did = [];
  try {
    let createdConfig = false;
    if (!configExists()) {
      const cfg = normalizeConfig(defaultConfig(await detectSources()));
      await saveConfig(cfg, CONFIG_PATH);
      createdConfig = true;
      did.push('created config');
    }

    const config = await loadConfig();
    const mode =
      config && config.injection && config.injection.mode
        ? config.injection.mode
        : 'statusline';

    if ((mode === 'statusline' || mode === 'both') && !statuslineIsOurs()) {
      await installStatusline(config);
      did.push('wired statusline');
    }

    if (!isDaemonRunning().running) {
      startDaemonDetached();
      did.push('started daemon');
    }

    if (did.length === 0) {
      console.log('ContextSpin: already set up.');
    } else {
      console.log(
        `ContextSpin: ${did.join(', ')}.` +
          (createdConfig ? ` Edit ${CONFIG_PATH} to add your own sources.` : ''),
      );
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    // Never break the session-start hook: report and exit 0.
    console.log(`ContextSpin: setup skipped (${message}).`);
  }
}

/**
 * Start the background daemon. Requires a valid config.
 * @returns {Promise<void>}
 */
async function runStart() {
  if (!configExists()) {
    printSetupHint();
    process.exit(1);
    return;
  }
  // loadConfig validates; surfaces a clean error if the config is broken.
  await loadConfig();
  const res = await startDaemonDetached();
  if (res.already) {
    console.log(`ContextSpin daemon already running (pid ${res.pid}).`);
  } else {
    console.log(`ContextSpin daemon started (pid ${res.pid}).`);
  }
}

/**
 * Stop the background daemon.
 * @returns {Promise<void>}
 */
async function runStop() {
  const res = await stopDaemon();
  if (res.stopped) {
    console.log(`ContextSpin daemon stopped (pid ${res.pid}).`);
  } else {
    console.log('ContextSpin daemon was not running.');
  }
}

/**
 * Restart the background daemon: stop then start.
 * @returns {Promise<void>}
 */
async function runRestart() {
  await runStop();
  await runStart();
}

/**
 * Print the daemon running state plus the current cache contents.
 * @returns {Promise<void>}
 */
async function runStatus() {
  const { running, pid } = isDaemonRunning();
  if (running) {
    console.log(`Daemon: running (pid ${pid})`);
  } else {
    console.log('Daemon: stopped');
  }

  const cache = await readCache();
  const snippets = Array.isArray(cache.snippets) ? cache.snippets : [];
  if (cache.updatedAt) {
    console.log(`Cache updated: ${cache.updatedAt}`);
  }

  if (snippets.length === 0) {
    console.log('No snippets cached yet.');
    if (!running) {
      console.log('Hint: run `contextspin start` to begin collecting context.');
    }
    return;
  }

  const now = Date.now();
  console.log('');
  console.log('Snippets:');
  for (const snip of snippets) {
    const fetched = Date.parse(snip.fetchedAt);
    const age = Number.isFinite(fetched) ? formatAge(now - fetched) : '?';
    const src = snip.source || `#${snip.sourceId}`;
    const shown = Number.isFinite(snip.shownCount) ? snip.shownCount : 0;
    console.log(`  [${src}] ${snip.text}  (age ${age}, shown ${shown})`);
  }
}

/**
 * Resolve the injection mode from a CLI option or the config default.
 * @param {string|undefined} optionMode
 * @param {object} config
 * @returns {string}
 */
function resolveMode(optionMode, config) {
  if (optionMode) return optionMode;
  return config && config.injection && config.injection.mode
    ? config.injection.mode
    : 'statusline';
}

/**
 * Run the inject command for the chosen mode (statusline / patcher / both).
 * @param {{ mode?: string }} opts
 * @returns {Promise<void>}
 */
async function runInject(opts = {}) {
  const config = await loadConfig();
  const mode = resolveMode(opts.mode, config);
  if (!['statusline', 'patcher', 'both'].includes(mode)) {
    throw new Error(
      `unknown injection mode "${mode}" (expected statusline, patcher, or both)`,
    );
  }

  if (mode === 'statusline' || mode === 'both') {
    const res = await installStatusline(config);
    console.log('Statusline installed:');
    console.log(`  script:   ${res.statuslineSh}`);
    console.log(`  renderer: ${res.statuslineJs}`);
    console.log(`  settings: ${res.settingsPath}`);
    if (res.backedUp) {
      console.log('  (backed up your previous statusLine setting)');
    }
    if (res.warning) {
      console.log(`  warning: ${res.warning}`);
    }
  }

  if (mode === 'patcher' || mode === 'both') {
    const res = await installPatcher(config);
    if (res.warning) {
      console.log(`Patcher: ${res.warning}`);
    }
    const patched = Array.isArray(res.patched) ? res.patched : [];
    if (patched.length > 0) {
      console.log('Patcher applied to:');
      for (const p of patched) {
        const status = p.patched ? 'patched' : 'skipped';
        const note = p.note ? ` — ${p.note}` : '';
        console.log(`  [${status}] ${p.path}${note}`);
      }
    }
    if (res.wrapper) {
      console.log(`Wrapper script: ${res.wrapper}`);
    }
    if (res.note) {
      console.log(res.note);
    }
  }
}

/**
 * Run the uninject command, reversing whichever injection mode is selected.
 * @param {{ mode?: string }} opts
 * @returns {Promise<void>}
 */
async function runUninject(opts = {}) {
  const config = await loadConfig();
  const mode = resolveMode(opts.mode, config);
  if (!['statusline', 'patcher', 'both'].includes(mode)) {
    throw new Error(
      `unknown injection mode "${mode}" (expected statusline, patcher, or both)`,
    );
  }

  if (mode === 'statusline' || mode === 'both') {
    const res = await uninstallStatusline();
    if (res.removed) {
      console.log(
        res.restored
          ? 'Statusline removed (restored your previous settings).'
          : 'Statusline removed.',
      );
    } else {
      console.log('Statusline: nothing to remove.');
    }
    if (res.note) console.log(`  ${res.note}`);
  }

  if (mode === 'patcher' || mode === 'both') {
    const res = await restorePatcher();
    const restored = Array.isArray(res.restored) ? res.restored : [];
    if (restored.length > 0) {
      console.log('Patcher restore:');
      for (const r of restored) {
        const status = r.restored ? 'restored' : 'failed';
        const note = r.note ? ` — ${r.note}` : '';
        console.log(`  [${status}] ${r.path}${note}`);
      }
    } else {
      console.log('Patcher: no patched installs with backups found.');
    }
  }
}

/**
 * The default action when no subcommand is given: set up if there is no config,
 * otherwise start the daemon and inject per the configured mode.
 * @returns {Promise<void>}
 */
async function runDefault() {
  if (!configExists()) {
    await runSetup({});
    return;
  }
  await runStart();
  const config = await loadConfig();
  await runInject({ mode: config.injection.mode });
}

/**
 * Build and configure the Commander program.
 * @returns {Command}
 */
function buildProgram() {
  const program = new Command();

  program
    .name('contextspin')
    .description(
      'Replace your Claude Code spinner/statusline with live org context.',
    )
    .version(readVersion())
    .showHelpAfterError();

  program
    .command('setup')
    .description('Create a ContextSpin config (interactive, or --yes for a detected config)')
    .option('--yes', 'skip prompts and write a detected config')
    .action(action(async (opts) => runSetup(opts)));

  program
    .command('ensure')
    .description(
      'One-shot, idempotent setup (create config + wire statusline + start daemon)',
    )
    .action(async () => runEnsure());

  program
    .command('start')
    .description('Start the background daemon')
    .action(action(async () => runStart()));

  program
    .command('stop')
    .description('Stop the background daemon')
    .action(action(async () => runStop()));

  program
    .command('restart')
    .description('Restart the background daemon')
    .action(action(async () => runRestart()));

  program
    .command('status')
    .description('Show daemon state and cached snippets')
    .action(action(async () => runStatus()));

  program
    .command('inject')
    .description('Wire ContextSpin into Claude Code (statusline/patcher/both)')
    .option('--mode <m>', 'injection mode: statusline, patcher, or both')
    .action(action(async (opts) => runInject(opts)));

  program
    .command('uninject')
    .description('Remove ContextSpin from Claude Code')
    .option('--mode <m>', 'injection mode: statusline, patcher, or both')
    .action(action(async (opts) => runUninject(opts)));

  // Default action: run when no subcommand is provided. Any leftover operand
  // means the user typed an unrecognized command (e.g. a typo) — error on it
  // rather than silently running the (potentially destructive) default.
  program.action(
    action(async (_opts, command) => {
      const operands = (command && command.args) || [];
      if (operands.length > 0) {
        command.error(`unknown command '${operands[0]}'`);
        return;
      }
      await runDefault();
    }),
  );

  return program;
}

const program = buildProgram();
program.parseAsync(process.argv).catch((err) => {
  const message = err && err.message ? err.message : String(err);
  console.error(`contextspin: ${message}`);
  process.exit(1);
});
