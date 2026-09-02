/**
 * Oh My Pi (OMP) plugin entry point for context-mode.
 *
 *   - session_start          — initialize the session row in our DB
 *   - tool_call              — shared routePreToolUse (Claude PreToolUse)
 *   - context                — inject queued routing guidance
 *   - tool_result            — extract structured events into the session DB
 *   - session_before_compact — persist a resume snapshot before compaction
 *
 * Loaded by OMP via the `omp` (or `pi`) field in package.json — see
 * upstream loader at refs/platforms/oh-my-pi/packages/coding-agent/src/
 * extensibility/plugins/loader.ts:75:
 *   `const manifest: PluginManifest | undefined = pluginPkg.omp || pluginPkg.pi;`
 * Hook factory contract from refs/.../extensibility/hooks/types.ts:809:
 *   `export type HookFactory = (pi: HookAPI) => void;`
 *
 * OMP differs from Pi in two ways that justify a dedicated plugin file:
 *   1. Storage roots at ~/.omp/context-mode/ via OMPAdapter, not ~/.pi/
 *   2. OMP has native MCP support (mcp.json), so no MCP bridge is needed
 *      — the bridge that Pi's extension ships (mcp-bridge.ts) is dead weight
 *      under OMP and is intentionally omitted here.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveSessionDbPath, SessionDB } from "../../session/db.js";
import { extractEvents, buildAgentUsageEvent } from "../../session/extract.js";
import type { HookInput } from "../../session/extract.js";
import { buildResumeSnapshot } from "../../session/snapshot.js";
import type { SessionEvent } from "../../types.js";
import { OMPAdapter } from "./index.js";
import { parseOmpUsage } from "./usage.js";

const OMP_TOOL_MAP: Record<string, string> = {
  bash: "Bash",
  edit: "Edit",
  read: "Read",
  write: "Write",
  list: "Glob",
  glob: "Glob",
  grep: "Grep",
  view: "Read",
  task: "Agent",
  eval: "Bash",
};

let _db: SessionDB | null = null;
let _dbPath = "";
let _sessionId = "";
let _pendingContext = "";

const _ompAdapter = new OMPAdapter();
const _pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

if (process.env.CONTEXT_MODE_ASSUME_MCP_READY !== "0") {
  process.env.CONTEXT_MODE_ASSUME_MCP_READY = "1";
}

type Decision = {
  action: string;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
};

type RoutingMods = {
  routePreToolUse: (
    toolName: string,
    toolInput: Record<string, unknown>,
    projectDir?: string,
    platform?: string,
    sessionId?: string,
    extra?: { mcpToolsAvailable?: boolean },
  ) => Decision | null;
  initSecurity: (root: string) => Promise<unknown>;
  isStructurallyBounded: (command: string) => boolean;
  createRoutingBlock: (
    t: (bare: string) => string,
    options?: { includeCommands?: boolean },
  ) => string;
  createToolNamer: (platform: string) => (bare: string) => string;
};

let _routing: RoutingMods | null = null;
let _routingPromise: Promise<RoutingMods> | null = null;

async function loadRouting(): Promise<RoutingMods> {
  if (_routing) return _routing;
  if (_routingPromise) return _routingPromise;
  // hooks/ lives outside tsc rootDir (src/). Same pattern as OpenClaw plugin.
  _routingPromise = (async () => {
    const routing = await import(
      pathToFileURL(resolve(_pluginRoot, "hooks/core/routing.mjs")).href
    ) as RoutingMods & Record<string, unknown>;
    const block = await import(
      pathToFileURL(resolve(_pluginRoot, "hooks/routing-block.mjs")).href
    ) as { createRoutingBlock: RoutingMods["createRoutingBlock"] };
    const naming = await import(
      pathToFileURL(resolve(_pluginRoot, "hooks/core/tool-naming.mjs")).href
    ) as { createToolNamer: RoutingMods["createToolNamer"] };
    await routing.initSecurity(resolve(_pluginRoot, "build")).catch(() => {});
    _routing = {
      routePreToolUse: routing.routePreToolUse,
      initSecurity: routing.initSecurity,
      isStructurallyBounded: routing.isStructurallyBounded,
      createRoutingBlock: block.createRoutingBlock,
      createToolNamer: naming.createToolNamer,
    };
    return _routing;
  })();
  return _routingPromise;
}

void loadRouting();

function queueContext(text: string): void {
  if (!text) return;
  _pendingContext = _pendingContext ? `${_pendingContext}\n\n${text}` : text;
}

function unwrapOmpBashCommand(command: string): string {
  let s = String(command ?? "").trim();
  for (let i = 0; i < 4; i++) {
    const next = s
      .replace(/^(?:rtk|timeout(?:\s+\d+(?:\.\d+)?)?)\s+/i, "")
      .trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

function prepareToolInput(
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  const name = String(toolName).toLowerCase();
  if (name === "eval") {
    const lang = String(toolInput.language ?? "");
    const code = String(toolInput.code ?? "");
    if (
      (lang === "js" || lang === "javascript" || lang === "ts" || lang === "typescript") &&
      /\bfetch\s*\(/.test(code)
    ) {
      return { command: code };
    }
    return toolInput;
  }
  if (name === "bash" && typeof toolInput.command === "string") {
    const unwrapped = unwrapOmpBashCommand(toolInput.command);
    if (unwrapped !== toolInput.command) {
      return { ...toolInput, command: unwrapped };
    }
  }
  return toolInput;
}

const OMP_TASK_MARKER = "context-mode: OMP task inherit";
const OMP_CHILD_ANALYSIS_MARKER = "context-mode: child analysis";
const OMP_FAIL_CLOSED_REASON =
  "context-mode: use ctx_execute / ctx_execute_file / ctx_batch_execute — native tool would dump into context.";
const OMP_CHILD_READ_REASON =
  "context-mode: subagent analysis Read blocked. Use ctx_execute_file / ctx_execute — native Read dumps source into context.";
const OMP_TRANSCRIPT_REASON =
  "context-mode: history:// and agent:// dump child transcripts into context. Use the yielded JSON or hub send.";
const OMP_FAT_MCP_REASON =
  "context-mode: this MCP payload dumps into context. Use ctx_execute (glab / codegraph explore) and console.log only findings.";
const FAT_MCP_WRITE =
  /mcp__(?:gitlab_get_mr_discussions|gitlab_get_merge_request_diffs|codegraph_explore)\b/i;

function injectOmpTaskRouting(
  toolName: string,
  toolInput: Record<string, unknown>,
  routing: RoutingMods,
): Record<string, unknown> {
  if (String(toolName).toLowerCase() !== "task" || !toolInput) return toolInput;
  const already = (s: unknown) => typeof s === "string" && s.includes(OMP_TASK_MARKER);
  const tasks = toolInput.tasks;
  if (already(toolInput.context) && (!Array.isArray(tasks) || tasks.every((t) => already((t as { task?: unknown })?.task)))) {
    return toolInput;
  }
  const block =
    "\n\n<!-- " + OMP_TASK_MARKER + " -->\n" +
    routing.createRoutingBlock(routing.createToolNamer("omp"), { includeCommands: false }) +
    "\n<!-- " + OMP_CHILD_ANALYSIS_MARKER + " -->\n" +
    "FORBIDDEN on this subagent: native Read, Grep, unbounded bash, history://, agent://, codegraph_explore, gitlab get_mr_discussions / get_merge_request_diffs. " +
    "Use ctx_execute_file / ctx_execute / ctx_batch_execute. Yield JSON findings only. Native Read is for Edit on the parent, not here.\n";
  const next: Record<string, unknown> = { ...toolInput };
  if (typeof next.context === "string" && !already(next.context)) {
    next.context = next.context + block;
  }
  if (Array.isArray(tasks)) {
    next.tasks = tasks.map((item) => {
      if (!item || typeof item !== "object") return item;
      const rec = item as Record<string, unknown>;
      if (typeof rec.task !== "string" || already(rec.task)) return item;
      return { ...rec, task: rec.task + block };
    });
  }
  return next;
}

function readPath(input: Record<string, unknown> | undefined): string {
  return String(input?.path ?? input?.file_path ?? "").trim();
}

function isSandboxInternalUri(p: string): boolean {
  return /^(skill|xd|artifact|local|memory):\/\//i.test(p);
}

function isTranscriptUri(p: string): boolean {
  return /^(history|agent):\/\//i.test(p);
}

function isInternalUri(p: string): boolean {
  return isSandboxInternalUri(p) || isTranscriptUri(p) || /^ssh:\/\//i.test(p);
}

function isLargeRead(input: Record<string, unknown> | undefined): boolean {
  const p = readPath(input);
  if (!p || isInternalUri(p)) return false;
  try {
    const st = statSync(p);
    return st.isFile() && st.size > 50_000;
  } catch {
    return false;
  }
}

function fatMcpWrite(input: Record<string, unknown> | undefined): boolean {
  return FAT_MCP_WRITE.test(readPath(input));
}

function looksLikeChildAgent(...roots: unknown[]): boolean {
  const seen = new Set<object>();
  function walk(obj: unknown, depth: number): boolean {
    if (!obj || typeof obj !== "object" || depth > 4) return false;
    if (seen.has(obj)) return false;
    seen.add(obj);
    const rec = obj as Record<string, unknown>;
    if (rec.parentToolCallId || rec.subagentEventBus || rec.isSubagent === true) return true;
    const agent = rec.agent ?? rec.agentName ?? rec.agentId;
    if (typeof agent === "string" && agent.length > 0 && !/^main$/i.test(agent)) return true;
    return walk(rec.runner, depth + 1)
      || walk(rec.parent, depth + 1)
      || walk(rec.context, depth + 1)
      || walk(rec.toolCall, depth + 1)
      || walk(rec.subagentEventBus, depth + 1);
  }
  return roots.some((root) => walk(root, 0));
}

function isChildExecuteContext(wrapper: unknown, context: unknown): boolean {
  const runner = (wrapper as { runner?: { hasHandlers?: (name: string) => boolean } } | undefined)?.runner;
  if (!runner?.hasHandlers?.("tool_call")) return true;
  return looksLikeChildAgent(wrapper, context, (context as { toolCall?: unknown } | undefined)?.toolCall);
}

type OmpToolResult = { block?: boolean; reason?: string; input?: Record<string, unknown> };

function decisionToOmpResult(
  decision: Decision | null,
  event: { toolName?: string; input?: Record<string, unknown> },
  routing: RoutingMods,
): OmpToolResult | undefined {
  if (!decision) return undefined;
  if (decision.action === "deny") {
    return { block: true, reason: decision.reason || "Blocked by context-mode" };
  }
  if (decision.action === "modify" && decision.updatedInput && typeof decision.updatedInput === "object") {
    return { input: { ...(event?.input ?? {}), ...decision.updatedInput } };
  }
  if (decision.action === "context" && decision.additionalContext) {
    const tool = String(event?.toolName ?? "").toLowerCase();
    const input = (event?.input && typeof event.input === "object") ? event.input : {};
    if (tool === "read" || tool === "view") {
      if (isLargeRead(input) || isTranscriptUri(readPath(input))) {
        return { block: true, reason: decision.additionalContext };
      }
      queueContext(decision.additionalContext);
      return undefined;
    }
    if (tool === "grep") return { block: true, reason: decision.additionalContext };
    if (tool === "bash") {
      const cmd = String(input.command ?? "");
      if (routing.isStructurallyBounded(cmd)) return undefined;
      return { block: true, reason: decision.additionalContext };
    }
    return undefined;
  }
  return undefined;
}

function failClosedOmp(
  toolName: string,
  input: Record<string, unknown> | undefined,
  opts: { child?: boolean } = {},
  routing: RoutingMods,
): OmpToolResult | undefined {
  const tool = String(toolName ?? "").toLowerCase();
  const child = opts.child === true;
  if (tool === "grep") return { block: true, reason: OMP_FAIL_CLOSED_REASON };
  if (tool === "read" || tool === "view") {
    const p = readPath(input);
    if (isTranscriptUri(p)) return { block: true, reason: OMP_TRANSCRIPT_REASON };
    if (child && p && !isSandboxInternalUri(p)) return { block: true, reason: OMP_CHILD_READ_REASON };
    if (isLargeRead(input)) return { block: true, reason: OMP_FAIL_CLOSED_REASON };
    return undefined;
  }
  if (tool === "write" && fatMcpWrite(input)) return { block: true, reason: OMP_FAT_MCP_REASON };
  if (tool === "bash") {
    const cmd = String(input?.command ?? "");
    if (!cmd || routing.isStructurallyBounded(cmd)) return undefined;
    return { block: true, reason: OMP_FAIL_CLOSED_REASON };
  }
  return undefined;
}

async function routeOmpToolCall(
  toolName: string,
  rawInput: unknown,
  rawEvent: unknown,
  rawCtx: unknown,
): Promise<OmpToolResult | undefined> {
  const routing = await loadRouting();
  const toolInput0 = (rawInput && typeof rawInput === "object")
    ? rawInput as Record<string, unknown>
    : {};
  const prepared = prepareToolInput(toolName, toolInput0);
  const routedName = prepared !== toolInput0 && String(toolName).toLowerCase() === "eval" ? "bash" : toolName;
  let toolInput = prepared;
  let event = { toolName, input: toolInput };
  if (String(toolName).toLowerCase() === "task") {
    toolInput = injectOmpTaskRouting(toolName, toolInput, routing);
    event = { toolName, input: toolInput };
  }
  const decision = routing.routePreToolUse(
    routedName,
    toolInput,
    process.env.PI_PROJECT_DIR || process.cwd(),
    "omp",
    _sessionId,
    { mcpToolsAvailable: true },
  );
  const mapped = decisionToOmpResult(decision, event, routing);
  if (mapped?.block || mapped?.input) {
    if (String(toolName).toLowerCase() === "task" && mapped.input) {
      return { ...mapped, input: injectOmpTaskRouting(toolName, mapped.input, routing) };
    }
    return mapped;
  }
  if (String(toolName).toLowerCase() === "task") return { input: toolInput };
  const child = (rawEvent as { child?: boolean } | undefined)?.child === true
    || looksLikeChildAgent(rawEvent, rawCtx);
  const closed = failClosedOmp(
    routedName === "bash" && String(toolName).toLowerCase() === "eval" ? "bash" : toolName,
    toolInput,
    { child },
    routing,
  );
  if (closed) return closed;
  if (prepared !== toolInput0) return { input: prepared };
  return mapped;
}

type WrapperInstance = {
  name?: string;
  tool?: { name?: string };
  runner?: { hasHandlers?: (n: string) => boolean };
};
type WrapperExecute = ((
  this: unknown,
  toolCallId: unknown,
  params: unknown,
  signal: unknown,
  onUpdate: unknown,
  context: unknown,
) => Promise<unknown>) & { __cmGate?: boolean };
type WrapperCtor = { prototype: { execute: WrapperExecute } };

function resolveExtensionToolWrapper(api: unknown): WrapperCtor | null {
  const rec = api as { pi?: { ExtensionToolWrapper?: WrapperCtor } } | null;
  const pi = rec?.pi;
  if (typeof pi?.ExtensionToolWrapper?.prototype?.execute === "function") {
    return pi.ExtensionToolWrapper;
  }
  if (!api || typeof api !== "object") return null;
  for (const v of Object.values(api as Record<string, unknown>)) {
    const ctor = v as WrapperCtor;
    if (typeof v === "function" && v.name === "ExtensionToolWrapper" && typeof ctor.prototype?.execute === "function") {
      return ctor;
    }
  }
  return null;
}

function installRestrictedChildExecuteGate(api: unknown): void {
  const Ctor = resolveExtensionToolWrapper(api);
  if (!Ctor?.prototype?.execute || Ctor.prototype.execute.__cmGate) return;
  const orig = Ctor.prototype.execute;
  const gated: WrapperExecute = async function gated(
    this: unknown,
    toolCallId: unknown,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    context: unknown,
  ): Promise<unknown> {
    const self = this as WrapperInstance;
    try {
      const toolName = self.name || self.tool?.name || "";
      const child = isChildExecuteContext(self, context);
      const routing = await loadRouting();
      const closed = failClosedOmp(
        toolName,
        (params && typeof params === "object") ? params as Record<string, unknown> : {},
        { child },
        routing,
      );
      if (closed?.block) throw new Error(closed.reason);
      if (!self.runner?.hasHandlers?.("tool_call")) {
        const mapped = await routeOmpToolCall(toolName, params, { child: true }, context);
        if (mapped?.block) throw new Error(mapped.reason || "Blocked by context-mode");
        if (mapped?.input) params = mapped.input;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/context-mode|Blocked by/i.test(msg)) throw err;
    }
    return orig.call(this, toolCallId, params, signal, onUpdate, context);
  };
  gated.__cmGate = true;
  Ctor.prototype.execute = gated;
}

const MCP_SERVER_NAME = "context-mode";
const SERVER_BUNDLE_RELATIVE = "../../../server.bundle.mjs";

function resolveServerBundle(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const bundle = resolve(here, SERVER_BUNDLE_RELATIVE);
    return existsSync(bundle) ? bundle : null;
  } catch {
    return null;
  }
}

function ensureMcpServerRegistered(): void {
  try {
    const bundle = resolveServerBundle();
    if (!bundle) return;

    const settings = _ompAdapter.readSettings() ?? {};
    const mcpServers =
      (settings.mcpServers as Record<string, unknown> | undefined) ?? {};
    if (MCP_SERVER_NAME in mcpServers) return;

    mcpServers[MCP_SERVER_NAME] = {
      type: "stdio",
      command: "node",
      args: [bundle],
      env: { CONTEXT_MODE_PLATFORM: "omp" },
    };
    settings.mcpServers = mcpServers;
    _ompAdapter.writeSettings(settings as Record<string, unknown>);
  } catch {
    // best effort — a registration failure must never break plugin load
  }
}

function getSessionDir(): string {
  const dir = _ompAdapter.getSessionDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getDBPath(projectDir: string): string {
  return resolveSessionDbPath({ projectDir, sessionsDir: getSessionDir() });
}

function getOrCreateDB(projectDir: string): SessionDB {
  const dbPath = getDBPath(projectDir);
  if (!_db || _dbPath !== dbPath) {
    if (_db) {
      try { _db.close(); } catch { /* best effort */ }
    }
    _db = new SessionDB({ dbPath });
    _dbPath = dbPath;
  }
  return _db;
}

function deriveSessionId(ctx: Record<string, unknown> | undefined): string {
  try {
    const sessionManager = (ctx as { sessionManager?: { getSessionFile?: () => string } } | undefined)
      ?.sessionManager;
    const sessionFile = sessionManager?.getSessionFile?.();
    if (sessionFile && typeof sessionFile === "string") {
      return createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
    }
  } catch {
    // best effort
  }
  return `omp-${Date.now()}`;
}

export function _resetOmpPluginStateForTests(): void {
  if (_db) {
    try { _db.close(); } catch { /* best effort */ }
  }
  _db = null;
  _dbPath = "";
  _sessionId = "";
  _pendingContext = "";
}

export function _getOmpPluginSessionIdForTests(): string {
  return _sessionId;
}

export async function _failClosedOmpForTests(
  toolName: string,
  input: Record<string, unknown> | undefined,
  opts?: { child?: boolean },
): Promise<OmpToolResult | undefined> {
  return failClosedOmp(toolName, input, opts, await loadRouting());
}

export function _looksLikeChildAgentForTests(...roots: unknown[]): boolean {
  return looksLikeChildAgent(...roots);
}

type ToolCallEvent = { toolName: string; toolCallId?: string; input?: Record<string, unknown> };
type ToolResultEvent = {
  toolName: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
};
type ToolCallEventResult = { block?: boolean; reason?: string; input?: Record<string, unknown> };
type TurnEndEvent = {
  type?: string;
  message?: unknown;
  messages?: unknown;
};
type HookEventCtx = Record<string, unknown> | undefined;
type HookHandler<E, R = void> = (event: E, ctx: HookEventCtx) => R | undefined | Promise<R | undefined>;

export interface MinimalHookAPI {
  on(event: "session_start", handler: HookHandler<{ type: "session_start" }>): void;
  on(event: "session_before_compact", handler: HookHandler<{ type: "session_before_compact" }>): void;
  on(event: "tool_call", handler: HookHandler<ToolCallEvent, ToolCallEventResult>): void;
  on(event: "tool_result", handler: HookHandler<ToolResultEvent>): void;
  on(event: "turn_end", handler: HookHandler<TurnEndEvent>): void;
  on(event: "context", handler: HookHandler<{ messages?: Array<{ role: string; content: string }> }, { messages: Array<{ role: string; content: string }> }>): void;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
}

export default function ompPlugin(pi: MinimalHookAPI): void {
  const projectDir = process.env.PI_PROJECT_DIR || process.cwd();

  ensureMcpServerRegistered();
  installRestrictedChildExecuteGate(pi);

  const db = getOrCreateDB(projectDir);

  pi.on("session_start", (_event, ctx) => {
    try {
      _sessionId = deriveSessionId(ctx);
      db.ensureSession(_sessionId, projectDir);
      db.cleanupOldSessions(7);
    } catch {
      if (!_sessionId) {
        _sessionId = `omp-${Date.now()}`;
      }
    }
    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      return await routeOmpToolCall(String(event?.toolName ?? ""), event?.input, event, ctx);
    } catch {
      return undefined;
    }
  });

  pi.on("context", (event) => {
    try {
      if (!_pendingContext) return undefined;
      const ctx = _pendingContext;
      _pendingContext = "";
      const messages = Array.isArray(event?.messages) ? event.messages : [];
      messages.push({ role: "user", content: ctx });
      return { messages };
    } catch {
      return undefined;
    }
  });

  pi.on("tool_result", (event) => {
    try {
      if (!_sessionId) return undefined;

      const rawToolName = String(event?.toolName ?? "");
      const mappedToolName = OMP_TOOL_MAP[rawToolName.toLowerCase()] ?? rawToolName;

      const content = Array.isArray(event?.content) ? event.content : [];
      const textParts = content
        .filter((c): c is { type: string; text: string } => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text);
      const resultStr = textParts.join("\n");

      const hookInput: HookInput = {
        tool_name: mappedToolName,
        tool_input: (event?.input as Record<string, unknown>) ?? {},
        tool_response: resultStr,
        tool_output: event?.isError ? { isError: true } : undefined,
      };

      const events = extractEvents(hookInput);
      for (const ev of events) {
        db.insertEvent(_sessionId, ev as SessionEvent, "PostToolUse");
      }
    } catch {
      // best effort
    }
    return undefined;
  });

  pi.on("session_before_compact", () => {
    try {
      if (!_sessionId) return undefined;
      const events = db.getEvents(_sessionId);
      const snapshot = buildResumeSnapshot(events);
      db.upsertResume(_sessionId, snapshot, events.length);
      db.incrementCompactCount(_sessionId);
    } catch {
      // best effort
    }
    return undefined;
  });

  pi.on("turn_end", (event) => {
    try {
      if (!_sessionId) return undefined;
      const counts = parseOmpUsage(event);
      if (counts === null) return undefined;
      const usageEvent = buildAgentUsageEvent(counts);
      if (usageEvent === null) return undefined;
      db.insertEvent(_sessionId, usageEvent as SessionEvent, "PostToolUse");
    } catch {
      // best effort — never break the turn on cost capture
    }
    return undefined;
  });
}

