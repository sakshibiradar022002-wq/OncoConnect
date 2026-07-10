// ChemoCure secure backend — the Express app.
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

import { initSchema } from './db/index.js';
import { errorHandler } from './middleware/validate.js';
import { authRouter } from './routes/auth.js';
import { syncRouter } from './routes/sync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Ensure DB & tables exist before serving.
await initSchema();

const app = express();
app.set('trust proxy', 1); // needed for correct req.ip behind cloud proxies

// ── Security headers ──────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'],
      // The prototype UIs use inline onclick= handlers; helmet defaults
      // script-src-attr to 'none', which silently breaks every button.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      manifestSrc: ["'self'"],
      workerSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '8mb' })); // lab file uploads (base64) can be large
app.use(cookieParser());

// ── Rate limiting ─────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,                    // 30 auth attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 300 });

// ── Health check (for cloud hosts) ────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── API routes ────────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/sync', apiLimiter, syncRouter);

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

app.use(errorHandler);

export { app };
