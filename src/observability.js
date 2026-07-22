// Lightweight observability with no external dependencies.
//
// - Correlation IDs: every request gets an X-Request-Id (honoured if the
//   client sent one), echoed on the response and attached to req for logs.
// - Structured logs: one JSON line per request with method, path, status,
//   latency, request id, and the actor/tenant when authenticated.
// - Metrics: in-memory counters + latency buckets for the critical oncology
//   flows, surfaced at /api/metrics (admin-only). Good enough to wire a
//   dashboard or scrape; swap for Prometheus/OpenTelemetry when you outgrow it.

import { randomUUID } from 'node:crypto';

const startedAt = Date.now();

// name -> { count, errors, totalMs, maxMs }
const flows = new Map();
// Maps a request path to a stable flow label for the critical oncology paths.
function flowFor(method, path) {
  if (path.startsWith('/api/sync/patient-login') || path.startsWith('/api/sync/lab-login')) return 'auth.portal_login';
  if (path.startsWith('/api/auth/login')) return 'auth.login';
  if (path.startsWith('/api/auth/register')) return 'auth.register';
  if (path.startsWith('/api/email/otp')) return 'email.otp';
  if (path.startsWith('/api/email/send')) return 'email.send';
  if (path.startsWith('/api/sync/patient')) return method === 'PUT' ? 'diary.patient_push' : 'sync.patient_pull';
  if (path.startsWith('/api/sync/lab')) return 'sync.lab';
  if (path.startsWith('/api/sync')) return method === 'PUT' ? 'sync.doctor_push' : 'sync.doctor_pull';
  if (path.startsWith('/api/push')) return 'push';
  if (path.startsWith('/api/admin')) return 'admin';
  return null; // uninteresting paths (static assets, health) are not counted
}

function record(flow, ms, isError) {
  let f = flows.get(flow);
  if (!f) { f = { count: 0, errors: 0, totalMs: 0, maxMs: 0 }; flows.set(flow, f); }
  f.count++;
  if (isError) f.errors++;
  f.totalMs += ms;
  if (ms > f.maxMs) f.maxMs = ms;
}

export function observability(req, res, next) {
  const rid = req.headers['x-request-id'] || randomUUID();
  req.requestId = rid;
  res.setHeader('X-Request-Id', rid);
  const start = process.hrtime.bigint();
  // Capture the path NOW: Express mutates req.path/req.url while routing
  // through sub-routers, so by res.finish it is the router-relative path.
  const method = req.method;
  const fullPath = req.originalUrl.split('?')[0];

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const flow = flowFor(method, fullPath);
    if (flow) record(flow, ms, res.statusCode >= 500);
    // One structured line per request. Never logs bodies (they hold PHI).
    const line = {
      t: new Date().toISOString(), rid,
      method, path: fullPath, status: res.statusCode,
      ms: Math.round(ms), flow: flow || undefined,
      actor: req.auth?.subjectId, role: req.auth?.role,
    };
    // 5xx to stderr, everything else to stdout — hosts split these streams.
    (res.statusCode >= 500 ? console.error : console.log)(JSON.stringify(line));
  });
  next();
}

export function metricsSnapshot() {
  const perFlow = {};
  for (const [name, f] of flows) {
    perFlow[name] = {
      count: f.count, errors: f.errors,
      errorRate: f.count ? +(f.errors / f.count).toFixed(4) : 0,
      avgMs: f.count ? Math.round(f.totalMs / f.count) : 0,
      maxMs: Math.round(f.maxMs),
    };
  }
  return {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    memory: process.memoryUsage().rss,
    flows: perFlow,
  };
}
