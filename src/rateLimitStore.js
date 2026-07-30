// Rate-limit backing store.
//
// express-rate-limit defaults to counting in process memory. That is correct
// for a single instance and quietly wrong for several: each replica keeps its
// own tally, so N replicas grant N× the configured attempts. On endpoints that
// guard credentials, that is a security regression that appears the moment
// someone scales out — with no error and nothing in the logs to show for it.
//
// Set REDIS_URL and every instance shares one counter. Leave it unset and
// behaviour is exactly as before.
//
//   REDIS_URL=redis://localhost:6379

import { config } from './config.js';

let store = null;
let mode = 'memory';

export async function initRateLimitStore() {
  const url = process.env.REDIS_URL;
  if (!url) {
    // Only a warning in production, and only when it actually matters: a
    // single instance with in-memory counters is a supported configuration.
    if (config.isProd) {
      console.warn(JSON.stringify({
        t: new Date().toISOString(),
        level: 'warn',
        msg: 'REDIS_URL not set — rate limits are per-instance. Safe on one instance; ' +
             'running multiple replicas multiplies the effective limit by the replica count.',
      }));
    }
    return null;
  }

  try {
    // Imported lazily so the dependency stays optional — the app must still
    // boot without it installed.
    const [{ default: RedisStore }, { createClient }] = await Promise.all([
      import('rate-limit-redis'),
      import('redis'),
    ]);
    const client = createClient({ url });
    client.on('error', (e) => {
      console.error(JSON.stringify({
        t: new Date().toISOString(), level: 'error',
        msg: 'redis error for rate-limit store', err: String(e && e.message || e),
      }));
    });
    await client.connect();
    store = new RedisStore({ sendCommand: (...args) => client.sendCommand(args) });
    mode = 'redis';
    console.log(JSON.stringify({
      t: new Date().toISOString(), level: 'info',
      msg: 'rate limits are shared across instances via redis',
    }));
    return store;
  } catch (e) {
    // A missing package or an unreachable Redis must not take the app down —
    // fall back to per-instance counting and say so loudly.
    console.error(JSON.stringify({
      t: new Date().toISOString(), level: 'error',
      msg: 'could not initialise the shared rate-limit store; falling back to per-instance counters',
      err: String(e && e.message || e),
    }));
    return null;
  }
}

// Spread into a rateLimit({...}) config. Returns {} when no shared store is
// configured, which leaves express-rate-limit on its own default.
export function limiterStore() {
  return store ? { store } : {};
}

export function rateLimitMode() {
  return mode;
}
