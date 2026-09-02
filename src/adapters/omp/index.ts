/**
 * adapters/omp — Oh My Pi (OMP) platform adapter.
 *
 * OMP integration facts (verified against can1357/oh-my-pi @ v3.20.1):
 *   - MCP config: `~/.omp/agent/mcp.json` (global) or `<project>/.omp/mcp.json`
 *     (project), per `packages/utils/src/dirs.ts` `getMCPConfigPath()` and
 *     `docs/mcp-config.md` "Preferred config locations".
 *   - Agent-dir env override: `PI_CODING_AGENT_DIR` — `packages/utils/src/dirs.ts`:
 *     `let dirs = new DirResolver(process.env.PI_CODING_AGENT_DIR);`
 *     (No `OMP_*` runtime env exists; `.env`-file `OMP_*` keys are mirrored to
 *     `PI_*` BEFORE process.env is read.)
 *   - System-prompt file: `SYSTEM.md` (project `.omp/SYSTEM.md` precedence,
 *     global `~/.omp/agent/SYSTEM.md` fallback). NOT `PI.md` — no `PI.md`
 *     loader exists upstream. OMP also auto-discovers `AGENTS.md` via
 *     `packages/coding-agent/src/discovery/agents-md.ts`.
 *   - Hook surface: OMP plugin.js registers pi.on(tool_call|tool_result|
 *     session_start|session_before_compact|context). Shared routePreToolUse
 *     (Claude PreToolUse) runs in-process. No ~/.omp/hooks directory.
 *
 * Why a dedicated adapter rather than reusing pi:
 *   OMP and Pi share a runtime surface but different storage roots
 *   (`~/.omp/agent/` vs `~/.pi/`). Without an OMP adapter, OMP users
 *   running through a Claude-installed harness silently land their
 *   context-mode data under `~/.claude/context-mode/` (issue #473).
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

import { BaseAdapter } from "../base.js";

import type {
  HookAdapter,
  HookParadigm,
  PlatformCapabilities,
  DiagnosticResult,
  PreToolUseEvent,
  PostToolUseEvent,
  PreCompactEvent,
  SessionStartEvent,
  PreToolUseResponse,
  PostToolUseResponse,
  PreCompactResponse,
  SessionStartResponse,
  HookRegistration,
} from "../types.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export class OMPAdapter extends BaseAdapter implements HookAdapter {
  constructor() {
    super([".omp"]);
  }

  readonly name = "OMP";
  readonly paradigm: HookParadigm = "ts-plugin";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true,
    sessionStart: true,
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true,
  };

  // Stdin JSON hooks unused. In-process plugin.js owns routing.

  parsePreToolUseInput(_raw: unknown): PreToolUseEvent {
    throw new Error("OMP uses in-process plugin.js, not stdin PreToolUse");
  }

  parsePostToolUseInput(_raw: unknown): PostToolUseEvent {
    throw new Error("OMP uses in-process plugin.js, not stdin PreToolUse");
  }

  parsePreCompactInput(_raw: unknown): PreCompactEvent {
    throw new Error("OMP uses in-process plugin.js, not stdin PreToolUse");
  }

  parseSessionStartInput(_raw: unknown): SessionStartEvent {
    throw new Error("OMP uses in-process plugin.js, not stdin PreToolUse");
  }


  // ── Response formatting ────────────────────────────────
  // Stdin hook responses unused. plugin.js returns {block, reason, input}.

  formatPreToolUseResponse(_response: PreToolUseResponse): unknown {
    return undefined;
  }

  formatPostToolUseResponse(_response: PostToolUseResponse): unknown {
    return undefined;
  }

  formatPreCompactResponse(_response: PreCompactResponse): unknown {
    return undefined;
  }

  formatSessionStartResponse(_response: SessionStartResponse): unknown {
    return undefined;
  }

  // ── Configuration ──────────────────────────────────────

  /**
   * Resolve OMP agent root, honoring `PI_CODING_AGENT_DIR` when set
   * (the upstream OMP convention — see `packages/utils/src/dirs.ts`)
   * and falling back to `~/.omp/agent`.
   */
  private getAgentDir(): string {
    return process.env.PI_CODING_AGENT_DIR
      ?? resolve(homedir(), ".omp", "agent");
  }

  getSettingsPath(): string {
    return resolve(this.getAgentDir(), "mcp.json");
  }

  /**
   * OMP nests its config under the agent dir. Always absolute.
   * `_projectDir` accepted for interface symmetry but unused — home-rooted.
   */
  getConfigDir(_projectDir?: string): string {
    return this.getAgentDir();
  }

  getInstructionFiles(): string[] {
    // SYSTEM.md is the OMP-native system-prompt file (see
    // can1357/oh-my-pi README "Custom System Prompt"). AGENTS.md is also
    // auto-discovered by the universal discovery layer.
    return ["SYSTEM.md", "AGENTS.md"];
  }

  generateHookConfig(_pluginRoot: string): HookRegistration {
    return {};
  }

  readSettings(): Record<string, unknown> | null {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  writeSettings(settings: Record<string, unknown>): void {
    const settingsPath = this.getSettingsPath();
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    return [
      {
        check: "Hook support",
        status: "pass",
        message:
          "OMP plugin.js owns tool_call routing in-process via shared routePreToolUse.",
      },
    ];
  }

  checkPluginRegistration(): DiagnosticResult {
    try {
      const raw = readFileSync(this.getSettingsPath(), "utf-8");
      const config = JSON.parse(raw);
      const mcpServers = (config as { mcpServers?: Record<string, unknown> })?.mcpServers ?? {};

      if ("context-mode" in mcpServers) {
        return {
          check: "MCP registration",
          status: "pass",
          message: "context-mode found in mcpServers config",
        };
      }

      return {
        check: "MCP registration",
        status: "fail",
        message: "context-mode not found in mcpServers",
        fix: `Add context-mode to mcpServers in ${this.getSettingsPath()}`,
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: `Could not read ${this.getSettingsPath()}`,
      };
    }
  }

  getInstalledVersion(): string {
    try {
      const pkgPath = resolve(
        this.getAgentDir(),
        "extensions",
        "context-mode",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      return pkg.version ?? "unknown";
    } catch {
      return "not installed";
    }
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(_pluginRoot: string): string[] {
    return [];
  }

  setHookPermissions(_pluginRoot: string): string[] {
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // OMP MCP server registry is managed via mcp.json
  }

  getRoutingInstructions(): string {
    return "# context-mode\n\nUse context-mode MCP tools (execute, execute_file, batch_execute, fetch_and_index, search) instead of run_command/view_file for data-heavy operations.";
  }
}
