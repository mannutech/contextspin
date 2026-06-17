// src/sources/mcp.js — MCP source: a hand-rolled minimal MCP stdio JSON-RPC client (no SDK).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CLAUDE_USER_CONFIG_PATH } from '../config.js';

/**
 * Expand environment variable references inside a string.
 *
 * Supports three forms:
 *   - ${VAR}            -> value of VAR (empty string if unset)
 *   - ${VAR:-DEFAULT}   -> value of VAR, or DEFAULT when unset OR empty
 *   - $VAR              -> bare reference (value of VAR, empty if unset)
 *
 * Non-string inputs are returned unchanged. Pure.
 *
 * @param {*} str - The value to expand (only strings are processed).
 * @param {Object} [env] - Environment map (default process.env).
 * @returns {*} The expanded string, or the original value if not a string.
 */
export function expandEnv(str, env = process.env) {
  if (typeof str !== 'string') return str;

  // ${VAR} and ${VAR:-DEFAULT}
  let result = str.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, def) => {
    const value = env[name];
    if (def !== undefined) {
      // :-DEFAULT applies when the var is unset OR empty.
      return value === undefined || value === '' ? def : value;
    }
    return value === undefined ? '' : value;
  });

  // Bare $VAR (not followed by a brace).
  result = result.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name) => {
    const value = env[name];
    return value === undefined ? '' : value;
  });

  return result;
}

/**
 * Read and JSON-parse a file, returning null on any error (missing/parse).
 *
 * @param {string} filePath
 * @returns {Object|null}
 */
function readJsonSafe(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Apply expandEnv to a server definition's command, args, and env values.
 *
 * @param {Object} def - A raw server definition.
 * @param {Object} env - Environment map.
 * @returns {Object} A new, expanded server definition.
 */
function expandServerDef(def, env) {
  if (!def || typeof def !== 'object') return def;
  const out = { ...def };
  if (typeof out.command === 'string') {
    out.command = expandEnv(out.command, env);
  }
  if (Array.isArray(out.args)) {
    out.args = out.args.map((arg) => expandEnv(arg, env));
  }
  if (out.env && typeof out.env === 'object') {
    const expandedEnv = {};
    for (const [key, value] of Object.entries(out.env)) {
      expandedEnv[key] = typeof value === 'string' ? expandEnv(value, env) : value;
    }
    out.env = expandedEnv;
  }
  return out;
}

/**
 * Discover MCP server definitions across the supported config scopes.
 *
 * Sources and precedence (later wins): user < project < local.
 *   - USER:    ~/.claude.json  -> .mcpServers
 *   - LOCAL:   ~/.claude.json  -> .projects["<abs-cwd>"].mcpServers
 *   - PROJECT: <cwd>/.mcp.json -> .mcpServers
 *
 * (Precedence local > project > user; we layer user first, then project,
 * then local so local overwrites the others.) command, each arg, and each env
 * value string have environment references expanded. Any unreadable or
 * unparseable file is skipped silently. Plugin/managed scopes are ignored in
 * Stage 1.
 *
 * @param {{ cwd?: string, env?: Object }} [opts]
 * @returns {Object} Map of server name -> expanded server definition.
 */
export function discoverMcpServers(opts = {}) {
  // Resolve to an absolute path once so the PROJECT (.mcp.json) and LOCAL
  // (.projects["<abs-cwd>"]) scopes agree on the same cwd even if a relative
  // cwd was passed; ~/.claude.json project keys are always absolute.
  const cwd = path.resolve(opts.cwd || process.cwd());
  const env = opts.env || process.env;

  const merged = {};

  // USER scope: ~/.claude.json .mcpServers
  const userConfig = readJsonSafe(CLAUDE_USER_CONFIG_PATH);
  const userServers = userConfig && userConfig.mcpServers;
  if (userServers && typeof userServers === 'object') {
    for (const [name, def] of Object.entries(userServers)) {
      merged[name] = expandServerDef(def, env);
    }
  }

  // PROJECT scope: <cwd>/.mcp.json .mcpServers
  const projectConfig = readJsonSafe(path.join(cwd, '.mcp.json'));
  const projectServers = projectConfig && projectConfig.mcpServers;
  if (projectServers && typeof projectServers === 'object') {
    for (const [name, def] of Object.entries(projectServers)) {
      merged[name] = expandServerDef(def, env);
    }
  }

  // LOCAL scope: ~/.claude.json .projects["<abs-cwd>"].mcpServers
  const absCwd = path.resolve(cwd);
  const projects = userConfig && userConfig.projects;
  const localServers =
    projects && projects[absCwd] && projects[absCwd].mcpServers;
  if (localServers && typeof localServers === 'object') {
    for (const [name, def] of Object.entries(localServers)) {
      merged[name] = expandServerDef(def, env);
    }
  }

  return merged;
}

/**
 * Determine whether a server definition uses the stdio transport.
 * A definition is stdio if it has a command, or type is "stdio"/undefined.
 *
 * @param {Object} def
 * @returns {boolean}
 */
function isStdioServer(def) {
  if (!def || typeof def !== 'object') return false;
  if (typeof def.command === 'string' && def.command !== '') return true;
  return def.type === undefined || def.type === 'stdio';
}

/**
 * A minimal newline-delimited JSON-RPC 2.0 client over a child's stdio.
 * Each instance owns one spawned server process for its lifetime.
 */
class StdioMcpClient {
  /**
   * @param {Object} serverDef - The (expanded) stdio server definition.
   * @param {string} name - The server's name (for error messages).
   */
  constructor(serverDef, name) {
    this.serverDef = serverDef;
    this.name = name;
    this.child = null;
    this.nextId = 1;
    /** @type {Map<number, {resolve:Function, reject:Function}>} */
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
  }

  /**
   * Spawn the server process and wire up a line-buffered stdout reader.
   * Server stderr is treated as logs and ignored.
   */
  start() {
    const command = this.serverDef.command;
    const args = Array.isArray(this.serverDef.args) ? this.serverDef.args : [];
    const childEnv = { ...process.env, ...(this.serverDef.env || {}) };

    this.child = spawn(command, args, {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));

    // Drain stderr so the child never blocks; treat it as logs.
    if (this.child.stderr) {
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', () => {});
    }

    this.child.on('error', (err) => this._failAll(err));
    this.child.on('close', () => {
      this.closed = true;
      this._failAll(new Error(`mcp server "${this.name}" exited unexpectedly`));
    });
  }

  /**
   * Accumulate stdout and dispatch complete newline-delimited JSON messages.
   *
   * @param {string} chunk
   */
  _onStdout(chunk) {
    this.buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        // Non-JSON line on stdout: ignore defensively.
        continue;
      }
      this._dispatch(message);
    }
  }

  /**
   * Route a parsed message to its waiting request by id. Messages without an
   * id (server notifications/requests) are ignored.
   *
   * @param {Object} message
   */
  _dispatch(message) {
    if (message === null || typeof message !== 'object') return;
    if (message.id === undefined || message.id === null) {
      // Server notification or request: not something we wait on.
      return;
    }
    // Key pending requests by String(id) on both send and dispatch so a server
    // that echoes the id as a string ("1") still matches our numeric id (1).
    const key = String(message.id);
    const waiter = this.pending.get(key);
    if (!waiter) return;
    this.pending.delete(key);
    waiter.resolve(message);
  }

  /**
   * Reject every pending request (used on child error/close).
   *
   * @param {Error} err
   */
  _failAll(err) {
    for (const waiter of this.pending.values()) {
      waiter.reject(err);
    }
    this.pending.clear();
  }

  /**
   * Send a JSON-RPC request and resolve with the matching response message.
   *
   * @param {string} method
   * @param {Object} params
   * @returns {Promise<Object>} The full JSON-RPC response message.
   */
  request(method, params) {
    // Fail fast if the child already closed: otherwise the write is buffered to
    // a dead pipe and the request would stall until the outer timeout fires.
    if (this.closed) {
      return Promise.reject(
        new Error(`mcp server "${this.name}" is not connected`)
      );
    }
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this._write(message, reject);
    });
  }

  /**
   * Send a JSON-RPC notification (no id, no response expected).
   *
   * @param {string} method
   * @param {Object} [params]
   */
  notify(method, params) {
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    this._write(message);
  }

  /**
   * Write a single newline-delimited JSON message to the child's stdin.
   *
   * @param {Object} message
   * @param {Function} [reject] - Optional reject for a pending request.
   */
  _write(message, reject) {
    const line = JSON.stringify(message) + '\n';
    try {
      this.child.stdin.write(line);
    } catch (err) {
      if (reject) reject(err);
    }
  }

  /**
   * Perform the initialize handshake: initialize request, await result, then
   * send the notifications/initialized notification.
   *
   * @returns {Promise<Object>} The initialize result.
   */
  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'contextspin', version: '0.1.0' },
    });
    if (response.error) {
      throw new Error(response.error.message || 'mcp initialize failed');
    }
    // We accept whatever protocolVersion the server echoes back.
    this.notify('notifications/initialized');
    return response.result;
  }

  /**
   * Call tools/list and return the array of tools.
   *
   * @returns {Promise<Array<{name:string}>>}
   */
  async listTools() {
    const response = await this.request('tools/list', {});
    if (response.error) {
      throw new Error(response.error.message || 'mcp tools/list failed');
    }
    const result = response.result || {};
    return Array.isArray(result.tools) ? result.tools : [];
  }

  /**
   * Call a tool by its RAW name (not the mcp__server__tool form).
   *
   * @param {string} rawTool
   * @param {Object} args
   * @returns {Promise<Object>} The full JSON-RPC response message.
   */
  callTool(rawTool, args) {
    return this.request('tools/call', {
      name: rawTool,
      arguments: args || {},
    });
  }

  /**
   * Terminate the child process (best effort).
   */
  kill() {
    if (this.child && !this.closed) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Strip an mcp__<server>__<tool> prefix to recover the raw tool name and the
 * server name it implies.
 *
 * @param {string} tool
 * @returns {{ rawTool: string, serverName: string|null }}
 */
function parseToolName(tool) {
  if (typeof tool === 'string' && tool.startsWith('mcp__')) {
    const rest = tool.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep !== -1) {
      return {
        serverName: rest.slice(0, sep),
        rawTool: rest.slice(sep + 2),
      };
    }
    // Malformed prefix: treat the remainder as the raw tool.
    return { serverName: null, rawTool: rest };
  }
  return { serverName: null, rawTool: tool };
}

/**
 * Parse a tools/call response message into an array of record objects.
 *
 * Throws on a top-level JSON-RPC error or when result.isError is set.
 * Prefers result.structuredContent when present; otherwise iterates the
 * text content blocks (each parsed as JSON when possible).
 *
 * @param {Object} message - The JSON-RPC response message.
 * @param {string} rawTool - The tool name (for error context).
 * @returns {Array<object>}
 */
function parseToolResult(message, rawTool) {
  if (message.error) {
    throw new Error(message.error.message || `mcp tool "${rawTool}" error`);
  }

  const result = message.result || {};

  if (result.isError) {
    const firstText = firstTextBlock(result.content);
    throw new Error(firstText || `mcp tool "${rawTool}" returned an error`);
  }

  // Prefer structured content when the server provides it.
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    const sc = result.structuredContent;
    if (Array.isArray(sc)) return sc.slice();
    if (typeof sc === 'object') return [sc];
    // A primitive structuredContent: wrap it.
    return [{ value: sc, text: String(sc) }];
  }

  // Otherwise, walk the text content blocks.
  const records = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') {
      continue;
    }
    const text = block.text;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      records.push({ text });
      continue;
    }
    if (Array.isArray(parsed)) {
      records.push(...parsed);
    } else if (parsed !== null && typeof parsed === 'object') {
      records.push(parsed);
    } else {
      records.push({ text });
    }
  }

  return records;
}

/**
 * Return the text of the first text content block, if any.
 *
 * @param {Array} content
 * @returns {string|null}
 */
function firstTextBlock(content) {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return null;
}

/**
 * Fetch records from an MCP tool by acting as a minimal stdio JSON-RPC client.
 *
 * Resolution:
 *   - rawTool/serverName are derived from source.tool (stripping any
 *     mcp__<server>__ prefix); source.server overrides the inferred server.
 *   - If no server is known, every stdio server is connected and queried with
 *     tools/list; the first whose tool names include rawTool is used.
 *   - Remote transports (http/sse/ws) are unsupported in Stage 1 and throw.
 *
 * The chosen server's child process is ALWAYS killed in a finally block, and
 * a timeoutMs guard kills the child and rejects if the call hangs.
 *
 * @param {{ tool: string, server?: string, args?: Object }} source
 * @param {{ timeoutMs?: number, cwd?: string, env?: Object }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function fetchMcp(source, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const cwd = opts.cwd || process.cwd();

  const parsed = parseToolName(source.tool);
  const rawTool = parsed.rawTool;
  let serverName = source.server || parsed.serverName || null;

  const servers = discoverMcpServers({ cwd, env: opts.env });

  // If a specific server is named, validate its transport up front.
  if (serverName) {
    const def = servers[serverName];
    if (def && !isStdioServer(def)) {
      throw new Error(
        `mcp ${def.type} transport not supported in Stage 1 (stdio only); ` +
          `use a cli or http source instead. Server: ${serverName}`
      );
    }
  }

  // The whole call runs against a single timeout; the active client is tracked
  // so the timeout handler can kill it.
  let activeClient = null;

  const work = (async () => {
    if (serverName) {
      const def = servers[serverName];
      if (!def) {
        throw new Error(`mcp server "${serverName}" not found in any config`);
      }
      const client = new StdioMcpClient(def, serverName);
      activeClient = client;
      try {
        client.start();
        await client.initialize();
        const message = await client.callTool(rawTool, source.args);
        return parseToolResult(message, rawTool);
      } finally {
        client.kill();
      }
    }

    // No server named: probe stdio servers in turn for one exposing rawTool.
    const stdioNames = Object.keys(servers).filter((name) =>
      isStdioServer(servers[name])
    );

    for (const name of stdioNames) {
      const def = servers[name];
      const client = new StdioMcpClient(def, name);
      activeClient = client;
      let hasTool = false;
      try {
        client.start();
        await client.initialize();
        const tools = await client.listTools();
        hasTool = tools.some((t) => t && t.name === rawTool);
        if (hasTool) {
          const message = await client.callTool(rawTool, source.args);
          return parseToolResult(message, rawTool);
        }
      } catch (err) {
        // If we already matched the tool on THIS server, a failure here is a
        // genuine tool/protocol error from the matched server — surface it
        // rather than masking it as "tool not found". Otherwise the server just
        // failed to connect/list, so try the next candidate.
        if (hasTool) throw err;
      } finally {
        client.kill();
        activeClient = null;
      }
    }

    throw new Error(
      `mcp tool "${rawTool}" not found on any stdio MCP server`
    );
  })();

  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      if (activeClient) activeClient.kill();
      reject(new Error(`mcp source timed out after ${timeoutMs}ms (tool: ${rawTool})`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    if (activeClient) activeClient.kill();
  }
}

export default fetchMcp;
