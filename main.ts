// main.ts — the entry's lifecycle against the harness env.
//
// The env is a second server the harness runs beside this one. It tells the entry
// when the trial is over, and it is the only thing the entry talks to besides its
// own clients. The whole process is: bind a port, hand it to the env, then wait
// until the env says the trial is done, and leave.
//
//   1. Read MAKEFUN_ENV_URL. It names the env's origin; in a trial container that
//      is http://store:8080, and under the process driver it is a loopback URL the
//      driver hands out. With no URL there is no env to talk to, so exit 1.
//   2. Bind an ephemeral port with listen(0) and let the kernel choose. Port 8080
//      is the env's own; never bind it.
//   3. POST the bound port to $MAKEFUN_ENV_URL/register as {"port": N}. The env
//      records the request's source address plus N and dials the entry there from
//      then on. The first register wins; a later one gets 409 and changes nothing.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The env
//      answers every poll at once — {"done": false} while the suite runs — so this
//      is a short poll with backoff, never a request held open.
//   5. Close the server and exit 0. The harness stops the env afterwards; the env
//      writes the state export the scorer reads.
//
// The boot budget is 20 seconds from process start to a successful register, and
// the env probes GET /healthz twice in the 10 seconds after that. Nothing here
// does work that could eat into either budget: no I/O beyond the two endpoints,
// no model call, no dependency to load. The server itself lives in app.ts; this
// file only drives the handshake around it.

import { createApp } from './app.ts';

// The env's origin, with any trailing slashes stripped so /register and /done join cleanly.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin.length === 0) {
  process.stderr.write('entry: MAKEFUN_ENV_URL is not set, so there is no env to register with\n');
  process.exit(1);
}

// One register or done request gets this long before it is abandoned and retried.
const CALL_TIMEOUT_MS = 30_000;
// Retries start at this wait and double, up to the cap below.
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

// Wait `ms` milliseconds; the only timer in the lifecycle.
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// How long to wait after the `n`th failed attempt (0-based): doubling from the
// start value, capped, so a still-starting env is retried gently.
function backoffMs(n: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(n, 8));
}

// POST the bound port until the env accepts it. A 200 is the normal answer and a
// 409 means some earlier register already won, which is not this process's to fix,
// so both count as done. A 400 or 405 means the request itself is wrong, so the
// program ends instead of looping. A network error, a timeout, or any other status
// is retried, since the env may still be starting.
async function registerPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused: HTTP ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused: ')) throw err;
    }
    await pause(backoffMs(attempt));
  }
}

// Poll GET /done until it answers {"done": true}; never return before that. A
// failed or slow poll just means the env is not answering yet, so poll again.
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await pause(backoffMs(attempt));
  }
}

// Bind the port, register it, then wait for the env: the whole life of the process.
async function boot(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`entry: listening on port ${bound.port}\n`);

  await registerPort(bound.port);
  process.stdout.write('entry: registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('entry: done\n');
}

try {
  await boot();
  process.exit(0);
} catch (err) {
  process.stderr.write(`entry: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
