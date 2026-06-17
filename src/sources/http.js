// src/sources/http.js — HTTP source: fetch a URL and turn the response into records.

import { interpolate } from '../formatter.js';

/**
 * Minimal jq-style path evaluator (a tiny subset of jq).
 *
 * Supported subset:
 *   - identity: "."  -> returns the input unchanged
 *   - leading dot:   ".a", ".a.b"
 *   - dot keys:      "a.b" (a leading dot is optional)
 *   - bracket index: ".a[0]", ".a.b[2]"
 *   - iteration:     ".[]" or ".a[]" yields an array of the elements; if a
 *                    later key follows an iterated array, the key is mapped
 *                    over each element (".a[].b")
 *   - pipe:          "|" chains expressions left-to-right (".a | .b[]")
 *
 * Anything outside this subset (unknown syntax) returns the input UNCHANGED
 * rather than throwing, so a misconfigured jq expression degrades gracefully.
 *
 * @param {*} data - The parsed JSON input.
 * @param {string} expr - The jq-style expression.
 * @returns {*} The selected value (often an array when iteration is used).
 */
export function jqPath(data, expr) {
  if (typeof expr !== 'string') return data;
  const trimmed = expr.trim();
  if (trimmed === '' || trimmed === '.') return data;

  // Pipe: evaluate each stage left-to-right.
  if (trimmed.includes('|')) {
    return trimmed
      .split('|')
      .reduce((acc, stage) => jqPath(acc, stage.trim()), data);
  }

  const tokens = tokenizeJq(trimmed);
  if (tokens === null) {
    // Unsupported expression: return input unchanged.
    return data;
  }

  let current = data;
  let iterating = false; // whether `current` is a list produced by `[]`

  for (const token of tokens) {
    if (token.type === 'key') {
      if (iterating) {
        // Map the key over each element of the iterated array.
        if (!Array.isArray(current)) return undefined;
        current = current.map((item) => readKey(item, token.name));
        // Result of mapping a key stays a plain array value, not iteration.
        iterating = false;
      } else {
        current = readKey(current, token.name);
      }
    } else if (token.type === 'index') {
      if (iterating) {
        if (!Array.isArray(current)) return undefined;
        current = current.map((item) =>
          Array.isArray(item) ? item[token.index] : undefined
        );
        iterating = false;
      } else {
        current = Array.isArray(current) ? current[token.index] : undefined;
      }
    } else if (token.type === 'iterate') {
      // Produce an array of the current value's elements.
      if (iterating) {
        // Flatten one level of an already-iterated array.
        if (!Array.isArray(current)) return undefined;
        const flat = [];
        for (const item of current) {
          if (Array.isArray(item)) flat.push(...item);
        }
        current = flat;
      } else {
        if (!Array.isArray(current)) return undefined;
        current = current.slice();
      }
      iterating = true;
    }
  }

  return current;
}

/**
 * Read a key from an object, tolerating null/undefined.
 *
 * @param {*} obj
 * @param {string} key
 * @returns {*}
 */
function readKey(obj, key) {
  if (obj === null || obj === undefined) return undefined;
  return obj[key];
}

/**
 * Tokenize a single (non-piped) jq expression into key/index/iterate tokens.
 * Returns null if the expression uses unsupported syntax.
 *
 * @param {string} expr
 * @returns {Array<{type:string,name?:string,index?:number}>|null}
 */
function tokenizeJq(expr) {
  // Strip an optional leading dot, then walk the string.
  let s = expr.startsWith('.') ? expr.slice(1) : expr;
  const tokens = [];

  // Each segment is either a key, a [index], or [] (iterate), separated by
  // dots. We hand-parse to support things like `a[0].b[]`.
  let i = 0;
  const n = s.length;

  // Helper to read an identifier (key) starting at i.
  const readIdent = () => {
    let start = i;
    while (i < n) {
      const ch = s[i];
      if (ch === '.' || ch === '[') break;
      i += 1;
    }
    return s.slice(start, i);
  };

  // Leading-dot-only forms like ".[]" become s = "[]".
  while (i < n) {
    const ch = s[i];
    if (ch === '.') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      const close = s.indexOf(']', i);
      if (close === -1) return null;
      const inner = s.slice(i + 1, close).trim();
      if (inner === '') {
        tokens.push({ type: 'iterate' });
      } else if (/^\d+$/.test(inner)) {
        tokens.push({ type: 'index', index: Number(inner) });
      } else {
        // Quoted keys or anything else: unsupported.
        return null;
      }
      i = close + 1;
      continue;
    }
    // Otherwise, an identifier key.
    const ident = readIdent();
    if (ident === '') return null;
    // Keys must be simple identifiers in this subset.
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(ident)) return null;
    tokens.push({ type: 'key', name: ident });
  }

  return tokens;
}

/**
 * Fetch an HTTP(S) endpoint and normalize the response into records.
 *
 * The URL and header values are interpolated (so `{{ env.TOKEN }}` works).
 * The body, if an object, is JSON-stringified and content-type is set. The
 * request is aborted after timeoutMs. A non-OK status throws. The response is
 * parsed as JSON when possible; if JSON parsing fails the raw text is returned
 * as a single `{ text }` record. When `source.jq` is present it is applied to
 * the parsed JSON before normalization.
 *
 * Normalization to an array:
 *   - array  -> elements (objects kept; primitive -> { value, text:String })
 *   - object -> [object]
 *   - primitive -> [{ value, text: String(value) }]
 *
 * @param {{ url: string, method?: string, headers?: Object, body?: *, jq?: string }} source
 * @param {{ timeoutMs?: number, env?: Object }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function fetchHttp(source, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const env = opts.env ?? process.env;

  const url = interpolate(source.url, {}, env);

  // Interpolate header values (keys are taken literally).
  const headers = {};
  if (source.headers && typeof source.headers === 'object') {
    for (const [key, value] of Object.entries(source.headers)) {
      headers[key] = interpolate(String(value), {}, env);
    }
  }

  const method = source.method || 'GET';

  let body;
  if (source.body !== undefined && source.body !== null) {
    if (typeof source.body === 'object') {
      body = JSON.stringify(source.body);
      if (!hasHeader(headers, 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    } else {
      body = source.body;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Keep the abort timer armed across BOTH the fetch and the body read: fetch()
  // resolves as soon as the response HEADERS arrive, so a stalled or slow body
  // would otherwise hang past timeoutMs. We clear the timer only once the body
  // has been fully read (or the request has failed).
  let bodyText = '';
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`http source failed: ${res.status} ${url}`);
    }
    // Read the body once as text, then attempt to parse it as JSON. (Calling
    // res.json() then falling back to res.text() does not work: the body stream
    // is already consumed, so the fallback would be empty.)
    bodyText = await res.text();
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`http source timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    // Body was not JSON: return the raw text as a single record.
    return [{ text: bodyText }];
  }

  const data = source.jq ? jqPath(json, source.jq) : json;
  // A null/undefined selection (e.g. a jq path that matched nothing) yields no
  // records, rather than a junk { text: "undefined" } snippet.
  if (data === undefined || data === null) return [];
  return normalizeToRecords(data);
}

/**
 * Case-insensitive check for whether a header is already present.
 *
 * @param {Object} headers
 * @param {string} name
 * @returns {boolean}
 */
function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/**
 * Normalize an arbitrary value into an array of record objects.
 *
 * @param {*} data
 * @returns {Array<object>}
 */
function normalizeToRecords(data) {
  if (Array.isArray(data)) {
    return data.map((el) =>
      isPlainObject(el) ? el : { value: el, text: String(el) }
    );
  }
  if (isPlainObject(data)) {
    return [data];
  }
  return [{ value: data, text: String(data) }];
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

export default fetchHttp;
