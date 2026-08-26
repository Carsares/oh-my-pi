// Configuration data plane for the native Picot Settings → Configuration tab.
//
// The legacy `embedded-server.ts` served these operations over its own HTTP/WS
// server. In the native architecture there is no such server: the WebView talks
// to the Rust host, which forwards commands to pi over stdio RPC. pi's native
// RPC command set is fixed (see docs/rpc.md) and cannot be extended, so this
// module is invoked through a registered pi command (`/picot-config`) whose
// handler runs immediately without hitting the LLM or session history. Results
// are returned to the WebView via `ctx.ui.notify(JSON)`, correlated by request
// id (see public/native/config-gateway.js).
//
// All model-registry access (catalog, auth status, API keys, visibility,
// health) goes through the live `ctx.modelRegistry` — the same object the old
// embedded-server used — so we never re-implement pi's provider knowledge.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentRegistry,
  createAgentSession,
  type ExtensionContext,
  SessionManager,
  settings,
} from "@oh-my-pi/pi-coding-agent";
import {
  ConfigManagementService,
  type ConfigModelRegistry,
  isConfigManagementOperation,
} from "@oh-my-pi/pi-coding-agent/config/config-management-service";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { generateTitleForSession } from "./session-title";
import {
  buildSkillInventory,
  mutateSkillEnabled,
  type SkillScope,
  type SkillTarget,
} from "./skill-inventory";

type CatalogModel = {
  provider?: string;
  id?: string;
  name?: string;
  contextWindow?: number | null;
};

type NativeModel = NonNullable<ExtensionContext["model"]>;
type NativeModelRegistry = ExtensionContext["modelRegistry"];
type ConfigContext = {
  modelRegistry?: ConfigModelRegistry;
  cwd?: string;
  model?: ExtensionContext["model"] | CatalogModel;
  sessionManager?: {
    getSessionFile: () => string | undefined;
    getSessionId: () => string;
  };
  isProjectTrusted?: () => boolean;
};

type ListedSession = { path?: string };

async function renameHistoricalSession(filePath: unknown, requestedName: unknown) {
  if (typeof filePath !== "string" || typeof requestedName !== "string") {
    throw new Error("Session path and name are required.");
  }
  const name = requestedName.trim();
  if (!name) throw new Error("Session name cannot be empty.");
  if ([...name].length > 200) throw new Error("Session name cannot exceed 200 characters.");
  if (path.extname(filePath).toLowerCase() !== ".jsonl") {
    throw new Error("Session is not available.");
  }
  let canonicalTarget: string;
  try {
    canonicalTarget = fs.realpathSync.native(filePath);
  } catch {
    throw new Error("Session is not available.");
  }
  const sessions = (await SessionManager.listAll()) as ListedSession[];
  const managed = sessions.find((session) => {
    if (typeof session.path !== "string") return false;
    try {
      return fs.realpathSync.native(session.path) === canonicalTarget;
    } catch {
      return false;
    }
  });
  if (!managed) throw new Error("Session is not available.");
  const manager = await SessionManager.open(canonicalTarget);
  await manager.setSessionName(name, "user");
  return { filePath: canonicalTarget, name };
}

type SkillInventoryMutation = {
  scope?: unknown;
  target?: unknown;
  enabled?: unknown;
};

export type PicotConfigResult = { ok: true; data?: unknown } | { ok: false; error: string };

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function resolveHomeDir(): string {
  const candidates: string[] = [];
  const add = (value?: string) => {
    if (typeof value === "string" && value.trim()) candidates.push(path.resolve(value.trim()));
  };
  add(process.env.HOME);
  add(process.env.USERPROFILE);
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    add(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`);
  }
  add(os.homedir());
  return candidates[0] || os.homedir();
}

const HOME_DIR = resolveHomeDir();
const OMP_AGENT_ROOT = getAgentDir();
const SUPER_AGENT_ROOT = path.join(OMP_AGENT_ROOT, "super-agent");
const SUPER_AGENT_TASKS_PATH = path.join(SUPER_AGENT_ROOT, "tasks.json");
const PICOT_INSTANCES_DIR = path.join(OMP_AGENT_ROOT, "picot-instances");

function parseSkillScope(value: unknown): SkillScope {
  if (value === "global" || value === "project") return value;
  throw new Error("Invalid skill inventory scope");
}

function parseSkillTarget(value: unknown): SkillTarget {
  if (!value || typeof value !== "object") throw new Error("Invalid skill inventory mutation");
  const target = value as { kind?: unknown; id?: unknown };
  if (target.kind !== "skill" && target.kind !== "group") {
    throw new Error("Invalid skill inventory mutation");
  }
  if (typeof target.id !== "string" || target.id.length === 0) {
    throw new Error("Invalid skill inventory mutation");
  }
  return { kind: target.kind, id: target.id };
}

function skillInventoryOptions(scope: SkillScope, ctx: ConfigContext) {
  const cwd = typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
  return {
    scope,
    cwd,
    agentDir: OMP_AGENT_ROOT,
    homeDir: HOME_DIR,
    projectTrusted: Boolean(ctx.isProjectTrusted?.()),
    settingsRuntime: settings,
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

type SuperAgentProject = { name: string; cwd: string; status: string };

// The Runtime panel's project picker lists dispatch targets. In the native
// architecture the old `/api/super-agent/projects` HTTP endpoint no longer
// exists, so we reconstruct the list from the per-process instance records
// Picot writes to <agent-dir>/picot-instances/*.json (each has a `cwd`). The
// super-agent workspace itself is never a dispatch target.
function listSuperAgentProjects(): SuperAgentProject[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(PICOT_INSTANCES_DIR);
  } catch {
    return [];
  }
  const byCwd = new Map<string, SuperAgentProject>();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const record = readJsonFile(path.join(PICOT_INSTANCES_DIR, entry)) as
      | { cwd?: unknown }
      | undefined;
    const cwd = typeof record?.cwd === "string" ? record.cwd.replace(/\/+$/, "") : "";
    if (!cwd || path.resolve(cwd) === path.resolve(SUPER_AGENT_ROOT)) continue;
    byCwd.set(cwd, { name: cwd.split("/").pop() || cwd, cwd, status: "running" });
  }
  return [...byCwd.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function hasNativeModelRegistry(
  registry: ConfigModelRegistry,
): registry is ConfigModelRegistry & NativeModelRegistry {
  return typeof registry.getApiKey === "function" && typeof registry.resolver === "function";
}

// Dispatch a single Configuration operation. `ctx` is the extension command
// context; `ctx.modelRegistry` provides live provider/model/auth access.
export async function handlePicotConfig(
  op: string,
  params: Record<string, unknown>,
  ctx: ConfigContext,
): Promise<PicotConfigResult> {
  const registry = ctx.modelRegistry;

  const requireRegistry = (): ConfigModelRegistry => {
    if (!registry) throw new Error("Model registry not ready yet — try again in a moment.");
    return registry;
  };

  try {
    if (isConfigManagementOperation(op)) {
      return await new ConfigManagementService({
        modelRegistry: registry,
        settings,
        cwd: ctx.cwd,
        isProjectTrusted: ctx.isProjectTrusted,
        createAgentSession,
        createSessionManager: () => SessionManager.inMemory(ctx.cwd),
        createAgentRegistry: () => new AgentRegistry(),
      }).request(op, params);
    }
    switch (op) {
      case "rename_historical_session": {
        const result = await renameHistoricalSession(params.filePath, params.name);
        return { ok: true, data: result };
      }
      case "generate_session_title": {
        const sessionFile = ctx.sessionManager?.getSessionFile();
        if (!sessionFile) throw new Error("The active session has not been saved yet.");
        const registry = requireRegistry();
        if (!hasNativeModelRegistry(registry)) throw new Error("OMP model registry is unavailable");
        const title = await generateTitleForSession(sessionFile, {
          model: ctx.model as NativeModel | undefined,
          modelRegistry: registry,
          sessionId: ctx.sessionManager?.getSessionId(),
        });
        return { ok: true, data: { title } };
      }
      case "list_skill_inventory": {
        const scope = parseSkillScope(params.scope);
        return { ok: true, data: await buildSkillInventory(skillInventoryOptions(scope, ctx)) };
      }

      case "set_skill_enabled": {
        const mutation = params as SkillInventoryMutation;
        const scope = parseSkillScope(mutation.scope);
        const target = parseSkillTarget(mutation.target);
        if (typeof mutation.enabled !== "boolean") {
          throw new Error("Invalid skill inventory mutation");
        }
        const result = await mutateSkillEnabled({
          ...skillInventoryOptions(scope, ctx),
          target,
          enabled: mutation.enabled,
        });
        return { ok: true, data: result };
      }

      case "read_super_agent_tasks": {
        let content: string;
        if (fs.existsSync(SUPER_AGENT_TASKS_PATH)) {
          content = fs.readFileSync(SUPER_AGENT_TASKS_PATH, "utf8");
        } else {
          fs.mkdirSync(path.dirname(SUPER_AGENT_TASKS_PATH), { recursive: true });
          content = '{"tasks":[]}';
          fs.writeFileSync(SUPER_AGENT_TASKS_PATH, content, "utf8");
        }
        let tasks: unknown[] = [];
        try {
          const parsed = JSON.parse(content) as { tasks?: unknown[] };
          tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
        } catch {
          tasks = [];
        }
        return { ok: true, data: { tasks } };
      }

      case "write_super_agent_tasks": {
        const tasks = Array.isArray(params.tasks) ? params.tasks : [];
        fs.mkdirSync(path.dirname(SUPER_AGENT_TASKS_PATH), { recursive: true });
        fs.writeFileSync(SUPER_AGENT_TASKS_PATH, JSON.stringify({ tasks }, null, 2), "utf8");
        return { ok: true, data: { count: tasks.length } };
      }

      case "list_super_agent_projects": {
        return { ok: true, data: { projects: listSuperAgentProjects() } };
      }

      case "open_external": {
        const url = asString(params.url);
        if (!url) throw new Error("url is required");
        openExternal(url);
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown configuration operation: ${op}` };
    }
  } catch (e: unknown) {
    return { ok: false, error: errMessage(e) };
  }
}

function openExternal(url: string): void {
  const platform = process.platform;
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    execFile(command, args, () => {});
  } catch {
    // Best-effort; frontend falls back to window.open.
  }
}
