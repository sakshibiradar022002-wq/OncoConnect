// OncoConnect secure backend — the Express app.
//
// Exported without .listen() so the same app runs everywhere:
//   - src/server.js  starts a normal long-lived server (local, Docker, Render)
//   - api/index.js   exposes it as a serverless function (Vercel free tier)

import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { initSchema, initTestData } from './db/index.js';
import { errorHandler } from './middleware/validate.js';
import { authenticate } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { syncRouter } from './routes/sync.js';
import { adminRouter } from './routes/admin.js';
import { teamRouter } from './routes/team.js';
import { pushRouter } from './routes/push.js';
import { emailRouter } from './routes/email.js';
import { initPush } from './push.js';
import { observability, metricsSnapshot, metricsPrometheus } from './observability.js';
import { initRateLimitStore, limiterStore, rateLimitMode } from './rateLimitStore.js';
import { initSentry, sentryRequestHandler, sentryErrorHandler } from './observability/sentry.js';
import { db } from './db/index.js';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Ensure DB & tables exist before serving.
await initSchema();
await initTestData(); // Auto-populate test data if using ephemeral DB
await initPush();
initSentry(); // Initialize error tracking (no-op if SENTRY_DSN not set)
// Shared rate-limit counters when REDIS_URL is set; per-instance otherwise.
await initRateLimitStore();

const app = express();
app.set('trust proxy', 1); // needed for correct req.ip behind cloud proxies

// ── Error tracking (Sentry) ────────────────────────────────────────
app.use(sentryRequestHandler()); // Capture request metadata

// ── Security headers ──────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'],
      // No inline event attributes anywhere: every control declares
      // data-click="fn(args)" and is resolved by the delegated dispatcher in
      // public/js/dispatch.js. Inline event attributes are script, so allowing
      // them weakened XSS defence on a system holding PHI. 'none' is enforced
      // in CI by scripts/check-handlers.mjs, which fails the build if any
      // on*= attribute reappears in a live document.
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      // api.emailjs.com: the EmailJS fallback sender XHRs there — without
      // this entry the browser silently blocks every EmailJS send.
      connectSrc: ["'self'", 'https://api.emailjs.com'],
      manifestSrc: ["'self'"],
      workerSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(observability); // correlation IDs + structured logs + flow metrics
app.use(express.json({ limit: '8mb' })); // lab file uploads (base64) can be large
app.use(cookieParser());

// ── CSRF guard: state-changing API calls must come from our own origin ──
// (Hosting proxies may rewrite the session cookie to SameSite=None, which
// would otherwise let cross-site pages fire authenticated writes.)
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser clients (curl, tests) send no Origin
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try {
    if (new URL(origin).host !== host) {
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    }
  } catch { return res.status(403).json({ error: 'Invalid Origin header' }); }
  next();
});

// ── Rate limiting ─────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,                    // 30 auth attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
  ...limiterStore(),          // shared across replicas when REDIS_URL is set
});
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, ...limiterStore() });

// ── Health check (for cloud hosts) ────────────────────────────────
// Shallow by default (fast, for load-balancer pings); ?deep=1 also checks
// the database so a broken DB surfaces as unhealthy instead of silently 200.
app.get('/health', async (req, res) => {
  if (req.query.deep === '1') {
    try {
      await db.prepare('SELECT 1 AS ok').get();
    } catch (e) {
      return res.status(503).json({ ok: false, db: false, error: 'database unreachable' });
    }
    return res.json({ ok: true, db: true, ts: new Date().toISOString() });
  }
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── Metrics (admin-only): per-flow count / error rate / latency ───
app.get('/api/metrics', apiLimiter, authenticate, async (req, res) => {
  if (req.auth.role !== 'admin') {
    const first = await db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get();
    if (!first || first.id !== req.auth.subjectId) return res.status(403).json({ error: 'Admin access required' });
  }
  res.json({ ...metricsSnapshot(), rateLimitMode: rateLimitMode() });
});

// Prometheus scrape target. Same admin gate as /api/metrics — flow names and
// error rates describe clinical activity and are not public.
app.get('/api/metrics/prometheus', apiLimiter, authenticate, async (req, res) => {
  if (req.auth.role !== 'admin') {
    const first = await db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get();
    if (!first || first.id !== req.auth.subjectId) return res.status(403).json({ error: 'Admin access required' });
  }
  res.set('Content-Type', 'text/plain; version=0.0.4').send(metricsPrometheus());
});

// ── Swagger UI / OpenAPI documentation ────────────────────────────
app.use('/api/docs', swaggerUi.serve);
app.get('/api/docs', swaggerUi.setup(swaggerSpec, {
  swaggerOptions: { persistAuthorization: true },
  customCss: `
    .topbar { background-color: #1a1f2e; }
    .topbar h1 { color: #00d4b4; }
    .scheme-container { background: #0f131b; border: 1px solid #1e3a5a; }
    button { background: #00d4b4; color: #0a0e16; }
  `
}));
app.get('/api/docs.json', (req, res) => {
  res.json(swaggerSpec);
});

// ── API routes ────────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/sync', apiLimiter, syncRouter);
app.use('/api/team', apiLimiter, teamRouter);
app.use('/api/admin', apiLimiter, adminRouter);
app.use('/api/push', apiLimiter, pushRouter);
app.use('/api/email', emailRouter); // has its own per-route limiters

// ── PWA assets: correct headers for manifests & service workers ───
// One sw.js serves both apps; it reads its own URL to pick cache + shell.
app.get(['/sw-doctor.js', '/sw-patient.js'], (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Service-Worker-Allowed', req.path.includes('doctor') ? '/' : '/patient.html');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(join(__dirname, '..', 'public', 'sw.js'));
});
app.get('/:name.webmanifest', (req, res, next) => {
  res.set('Content-Type', 'application/manifest+json');
  next();
});

// ── Serve the frontend (built HTML apps) ──────────────────────────
app.use(express.static(join(__dirname, '..', 'public')));

// SPA-ish fallback: send the doctor app for unknown non-API GETs.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});

// ── Error handlers (order matters: Sentry before custom) ────────────
app.use(sentryErrorHandler()); // Sentry error handler
app.use(errorHandler);         // Custom error handler

export { app };
