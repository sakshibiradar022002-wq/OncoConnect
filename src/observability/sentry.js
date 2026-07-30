// Sentry error tracking integration for OncoConnect.
// Optional dependency: if @sentry/node not installed, gracefully disables.

import { config } from '../config.js';

let Sentry = null;
let sentryEnabled = false;

try {
  // Try to load Sentry; if not installed, continue without it
  Sentry = await import('@sentry/node');
  sentryEnabled = config.isProd && process.env.SENTRY_DSN;
} catch (e) {
  // Package not installed; that's ok
}

export function initSentry() {
  if (!sentryEnabled || !Sentry) {
    if (config.isProd && process.env.SENTRY_DSN) {
      console.warn('[sentry] @sentry/node not installed — install via: npm install @sentry/node');
    } else if (config.isProd) {
      console.warn('[sentry] SENTRY_DSN not set — error tracking disabled');
    }
    return null;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: 'production',
    tracesSampleRate: 0.1,
    attachStacktrace: true,
    maxBreadcrumbs: 50,
  });

  console.log('[sentry] initialized');
  return Sentry;
}

export function sentryErrorHandler() {
  return sentryEnabled && Sentry ? Sentry.Handlers.errorHandler() : (err, req, res, next) => next(err);
}

export function sentryRequestHandler() {
  return sentryEnabled && Sentry ? Sentry.Handlers.requestHandler() : (req, res, next) => next();
}

export function captureException(error, context = {}) {
  if (!sentryEnabled || !Sentry) return;
  Sentry.captureException(error, { contexts: { app: context } });
}

export function captureMessage(message, level = 'info') {
  if (!sentryEnabled || !Sentry) return;
  Sentry.captureMessage(message, level);
}
