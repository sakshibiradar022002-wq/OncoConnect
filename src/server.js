// ChemoCure secure backend — entry point.

import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config } from './config.js';
import { initSchema } from './db/index.js';
import { errorHandler } from './middleware/validate.js';
import { authRouter } from './routes/auth.js';
import { patientsRouter } from './routes/patients.js';
import { labsRouter } from './routes/labs.js';
import { clinicalRouter } from './routes/clinical.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Ensure DB & tables exist before serving.
initSchema();

const app = express();
app.set('trust proxy', 1); // needed for correct req.ip behind cloud proxies

// ── Security headers ──────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'],
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

// ── CORS (only if explicit origins configured) ────────────────────
if (config.allowedOrigins.length) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

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
app.use('/api/patients', apiLimiter, patientsRouter);
app.use('/api/labs', apiLimiter, labsRouter);
app.use('/api/clinical', apiLimiter, clinicalRouter);

// ── PWA assets: correct headers for manifests & service workers ───
app.get('/sw-doctor.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Service-Worker-Allowed', '/');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(join(__dirname, '..', 'public', 'sw-doctor.js'));
});
app.get('/sw-patient.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Service-Worker-Allowed', '/patient.html');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(join(__dirname, '..', 'public', 'sw-patient.js'));
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

app.listen(config.port, () => {
  console.log(`\n  ChemoCure server running on port ${config.port}`);
  console.log(`  Environment: ${config.isProd ? 'production' : 'development'}`);
  console.log(`  Health: http://localhost:${config.port}/health\n`);
});
