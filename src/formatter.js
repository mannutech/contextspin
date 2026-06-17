// src/formatter.js — path resolution, template interpolation, and safe filter evaluation.

/**
 * Resolve a dot/bracket path (e.g. "a.b[0].c" or "results[0].value") against an
 * object. Returns undefined if any segment is missing. Pure.
 * @param {*} obj
 * @param {string} pathStr
 * @returns {*}
 */
export function getPath(obj, pathStr) {
  if (obj == null || typeof pathStr !== 'string' || pathStr === '') {
    return undefined;
  }

  // Normalize bracket notation (e.g. a[0].b) into dot segments (a.0.b).
  const normalized = pathStr.replace(/\[(\d+)\]/g, '.$1');
  const segments = normalized.split('.').filter((s) => s.length > 0);

  let current = obj;
  for (const segment of segments) {
    if (current == null) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Replace {{ token }} placeholders in a template against `data`.
 * A token of the form env.NAME resolves to env[NAME]; otherwise getPath(data, token).
 * undefined/null -> "", non-string -> String(value). Inner spaces are allowed.
 * @param {string} template
 * @param {*} data
 * @param {object} [env=process.env]
 * @returns {string}
 */
export function interpolate(template, data, env = process.env) {
  if (typeof template !== 'string') return '';

  return template.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_match, rawToken) => {
    const token = rawToken.trim();
    let value;
    if (token.startsWith('env.')) {
      value = env ? env[token.slice(4)] : undefined;
    } else {
      value = getPath(data, token);
    }
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : String(value);
  });
}

/**
 * Strip one layer of matching surrounding single or double quotes.
 * @param {string} s
 * @returns {string}
 */
function stripQuotes(s) {
  if (
    s.length >= 2 &&
    ((s[0] === '"' && s[s.length - 1] === '"') ||
      (s[0] === "'" && s[s.length - 1] === "'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Safely evaluate a filter expression against `data`.
 *
 * NO eval / NO Function constructor. The whole expression is first interpolated
 * against `data`, then parsed as a single `LEFT OP RIGHT` comparison where OP is
 * one of: == != >= <= > < or the word `includes`. Numeric comparison is used when
 * both sides are finite numbers, otherwise string comparison (== / != are loose).
 * With no operator, the expression is treated as truthy: non-empty AND not
 * "false"/"0" => true.
 *
 * LIMITATION: only a single comparison is supported — there is no support for
 * boolean operators (&&, ||), parentheses, or chained comparisons.
 *
 * @param {string|undefined|null} filterExpr
 * @param {*} data
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
export function applyFilter(filterExpr, data, env = process.env) {
  if (!filterExpr) return true;

  const expr = interpolate(filterExpr, data, env);

  // Operators ordered so multi-char operators are matched before single-char.
  const operators = ['==', '!=', '>=', '<=', '>', '<', 'includes'];

  let op = null;
  let opIndex = -1;
  for (const candidate of operators) {
    const pattern =
      candidate === 'includes'
        ? /\bincludes\b/
        : new RegExp(candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const match = pattern.exec(expr);
    if (match) {
      op = candidate;
      opIndex = match.index;
      break;
    }
  }

  if (op === null) {
    // No operator: treat as a truthiness check.
    const trimmed = expr.trim();
    return trimmed !== '' && trimmed !== 'false' && trimmed !== '0';
  }

  const leftRaw = expr.slice(0, opIndex).trim();
  const rightRaw = expr.slice(opIndex + op.length).trim();
  const left = stripQuotes(leftRaw);
  const right = stripQuotes(rightRaw);

  if (op === 'includes') {
    return left.includes(right);
  }

  const leftNum = Number(left);
  const rightNum = Number(right);
  const bothNumbers =
    left !== '' &&
    right !== '' &&
    Number.isFinite(leftNum) &&
    Number.isFinite(rightNum);

  if (bothNumbers) {
    switch (op) {
      case '==':
        return leftNum === rightNum;
      case '!=':
        return leftNum !== rightNum;
      case '>=':
        return leftNum >= rightNum;
      case '<=':
        return leftNum <= rightNum;
      case '>':
        return leftNum > rightNum;
      case '<':
        return leftNum < rightNum;
    }
  }

  // String comparison (== / != are loose equality on strings).
  switch (op) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '>=':
      return left >= right;
    case '<=':
      return left <= right;
    case '>':
      return left > right;
    case '<':
      return left < right;
  }

  return false;
}
