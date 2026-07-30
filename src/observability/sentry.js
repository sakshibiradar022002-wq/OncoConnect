// Sentry error tracking integration for OncoConnect.
// Captures unhandled exceptions, performance issues, and operational errors.

import * as Sentry from '@sentry/node';
import { config } from '../config.js';

export function initSentry() {
  // Only initialize in production with explicit DSN
  if (!config.isProd || !process.env.SENTRY_DSN) {
    if (config.isProd) {
      console.warn('[sentry] SENTRY_DSN not set — error tracking disabled');
    }
    return null;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: config.isProd ? 'production' : 'development',
    tracesSampleRate: 0.1, // Sample 10% of transactions for performance
    attachStacktrace: true,
    maxBreadcrumbs: 50,
    integrations: [
      // Express integration
      new Sentry.Integrations.Express({
        app: true,
        request: true,
        serverName: true,
        transaction: 'path',
        version: true,
      }),
      // Database operations
      new Sentry.Integrations.Postgres(),
    ],
  });

  console.log('[sentry] initialized (DSN configured)');
  return Sentry;
}

export function sentryErrorHandler() {
  if (!process.env.SENTRY_DSN) return (err, req, res, next) => next(err);
  return Sentry.Handlers.errorHandler();
}

export function sentryRequestHandler() {
  if (!process.env.SENTRY_DSN) return (req, res, next) => next();
  return Sentry.Handlers.requestHandler();
}

export function captureException(error, context = {}) {
  if (!process.env.SENTRY_DSN) return;
  Sentry.captureException(error, { contexts: { app: context } });
}

export function captureMessage(message, level = 'info', context = {}) {
  if (!process.env.SENTRY_DSN) return;
  Sentry.captureMessage(message, level);
}
