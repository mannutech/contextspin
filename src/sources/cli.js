// src/sources/cli.js — CLI source: run a shell command and turn its stdout into records.

import { spawn } from 'node:child_process';

/**
 * Run a CLI command and parse its stdout into an array of record objects.
 *
 * The command is spawned with a shell so users can write normal shell strings
 * (pipes, flags, quotes). stdout and stderr are buffered. A timeout kills the
 * child (SIGTERM, then SIGKILL after a short grace period).
 *
 * Parsing rules for stdout (after trimming):
 *   - "" (empty) -> []
 *   - valid JSON array  -> each element mapped (object kept as-is;
 *                          primitive -> { value: el, text: String(el) })
 *   - valid JSON object -> [obj]
 *   - valid JSON primitive -> [{ value: parsed, text: String(parsed) }]
 *   - not JSON -> split into non-empty trimmed lines;
 *                 each line -> { text: line, line, value: line }
 *
 * @param {{ command: string }} source - The CLI source definition.
 * @param {{ timeoutMs?: number }} [opts] - Options (timeoutMs default 15000).
 * @returns {Promise<Array<object>>} Parsed records.
 */
export async function fetchCli(source, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const command = source.command;

  const { stdout } = await runCommand(command, timeoutMs);
  return parseCliStdout(stdout);
}

/**
 * Spawn a shell command, buffer stdout/stderr, and enforce a timeout.
 *
 * @param {string} command - The shell command to run.
 * @param {number} timeoutMs - Timeout in milliseconds.
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runCommand(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;
    let graceTimer = null;

    const clearTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
    };

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    killTimer = setTimeout(() => {
      // Ask nicely first, then force-kill after a short grace period.
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      graceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 2000);
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (code !== 0) {
        const detail = stderr.trim() || command;
        reject(new Error(`cli source failed (exit ${code}): ${detail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Parse a CLI stdout string into an array of records (see fetchCli docs).
 *
 * @param {string} stdout - Raw stdout from the command.
 * @returns {Array<object>}
 */
function parseCliStdout(stdout) {
  const trimmed = String(stdout).trim();
  if (trimmed === '') return [];

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON: fall back to line-based parsing.
    return trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => ({ text: line, line, value: line }));
  }

  if (Array.isArray(parsed)) {
    return parsed.map((el) =>
      isPlainObject(el) ? el : { value: el, text: String(el) }
    );
  }
  if (isPlainObject(parsed)) {
    return [parsed];
  }
  return [{ value: parsed, text: String(parsed) }];
}

/**
 * True for non-null, non-array objects.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export default fetchCli;
