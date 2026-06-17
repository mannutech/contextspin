// src/runner.js — dispatches a configured source to its fetcher, then filters/formats/slices into Snippets.

import fetchCli from "./sources/cli.js";
import fetchHttp from "./sources/http.js";
import fetchMcp from "./sources/mcp.js";
import { interpolate, applyFilter } from "./formatter.js";

/**
 * A Snippet is the unit ContextSpin caches and injects.
 * @typedef {object} Snippet
 * @property {string} text       Rendered, human-readable one-liner (from source.format).
 * @property {string} source     The source label (source.label).
 * @property {number} sourceId   The source's index/id within the config.
 * @property {string} fetchedAt  ISO-8601 timestamp of when it was produced.
 * @property {number} shownCount How many times it has been shown (starts at 0).
 */

/**
 * Current time as an ISO-8601 string.
 * @returns {string}
 */
export function nowISO() {
  return new Date().toISOString();
}

/**
 * Fetch a single source, filter + format its records, and return capped Snippets.
 *
 * Dispatches by source.type to the matching fetcher (cli|http|mcp), passing opts
 * through. Each returned record is kept only when applyFilter(source.filter, record)
 * is true; its text is interpolate(source.format, record); empty text is skipped.
 * The resulting array is sliced to source.maxSnippets. Errors propagate to the caller.
 *
 * @param {object} source - Normalized source definition (has type, format, label, id, maxSnippets).
 * @param {object} [opts] - Passed through to the underlying fetcher (e.g. timeoutMs, cwd, env).
 * @returns {Promise<Snippet[]>}
 */
export async function runSource(source, opts = {}) {
  let records;
  switch (source.type) {
    case "cli":
      records = await fetchCli(source, opts);
      break;
    case "http":
      records = await fetchHttp(source, opts);
      break;
    case "mcp":
      records = await fetchMcp(source, opts);
      break;
    default:
      throw new Error(`Unknown source type: ${source.type}`);
  }

  const snippets = [];
  for (const record of records) {
    if (!applyFilter(source.filter, record)) continue;
    const text = interpolate(source.format, record);
    if (text.trim() === "") continue;
    snippets.push({
      text,
      source: source.label,
      sourceId: source.id,
      fetchedAt: nowISO(),
      shownCount: 0,
    });
  }

  return snippets.slice(0, source.maxSnippets);
}
