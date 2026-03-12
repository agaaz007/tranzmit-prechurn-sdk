/**
 * Exit Button Backend Service
 *
 * Fetches PostHog session replays and analyzes user behavior for exit interviews
 */

import { config } from './config';
import { logger } from './lib/logger';
import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { analyzeUserSessions, PostHogCredentials } from './lib/posthog-session-analysis';
import { InitiateRequestSchema, CompleteRequestSchema, PrefetchRequestSchema } from './lib/validation';
import { authenticate } from './middleware/auth';
import { globalRateLimit, initiateRateLimit, completeRateLimit, prefetchRateLimit } from './middleware/rate-limit';
import { prefetchKey, prefetchGet, prefetchSetPending } from './lib/prefetch-cache';
import { db, sessions, pool } from './db';
import { eq } from 'drizzle-orm';

const app: express.Express = express();

// Request logging
app.use(pinoHttp({ logger, autoLogging: { ignore: (req: any) => req.url === '/api/health' } }));

// Global rate limit
app.use(globalRateLimit);

// CORS — allow all origins for now; per-tenant CORS will use tenant.allowed_origins from DB
app.use(cors());
app.use(express.json());

/**
 * Get signed URL from ElevenLabs for private agent access
 */
async function getElevenLabsSignedUrl(agentId: string, elevenLabsApiKey: string): Promise<string> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
    {
      headers: {
        'xi-api-key': elevenLabsApiKey,
      },
    }
  );

  if (!response.ok) {
    throw new Error('Failed to get signed URL from ElevenLabs');
  }

  const data = (await response.json()) as any;
  return data.signed_url;
}

// ============ Embed SDK ============

let cachedEmbedJs: string | null = null;

app.get('/embed.js', (_req, res) => {
  if (!cachedEmbedJs) {
    const paths = [
      resolve(__dirname, '../../embed/dist/index.global.js'),
      resolve(process.cwd(), 'packages/embed/dist/index.global.js'),
    ];
    for (const p of paths) {
      if (existsSync(p)) {
        cachedEmbedJs = readFileSync(p, 'utf-8');
        break;
      }
    }
  }

  if (cachedEmbedJs) {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(cachedEmbedJs);
  } else {
    res.status(404).send('// embed.js not found — run pnpm build first');
  }
});

// ============ API Endpoints ============

/**
 * POST /api/exit-session/prefetch
 *
 * Kicks off PostHog session analysis ahead of time so /initiate is fast.
 * No DB session is created, no signed URL is fetched.
 */
app.post('/api/exit-session/prefetch', authenticate, prefetchRateLimit, async (req, res) => {
  try {
    const parsed = PrefetchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`);
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    const { userId, planName, mrr, accountAge, sessionAnalysis } = parsed.data;

    // Client explicitly opted out of session analysis
    if (sessionAnalysis === false) {
      return res.json({ status: 'cached' });
    }

    const tenantId = req.tenant?.id || 'default';
    const key = prefetchKey(tenantId, userId);

    // Check if we already have a result or in-flight request
    const existing = prefetchGet(key);
    if (existing.hit) {
      if (existing.data) {
        return res.json({ status: 'cached' });
      }
      if (existing.pending) {
        return res.json({ status: 'in_progress' });
      }
    }

    // Build PostHog credentials from tenant config
    const tenantConfig = req.tenant!.config;
    const posthogCreds: PostHogCredentials = {
      apiKey: tenantConfig.posthogApiKey || '',
      projectId: tenantConfig.posthogProjectId || '',
      host: tenantConfig.posthogHost,
    };
    const hasPosthog = !!(posthogCreds.apiKey && posthogCreds.projectId);

    if (!hasPosthog) {
      return res.json({ status: 'cached' }); // nothing to prefetch
    }

    // Start analysis and cache the promise
    const promise = analyzeUserSessions(posthogCreds, userId, { planName, mrr, accountAge });
    prefetchSetPending(key, promise);

    logger.info({ tenantId, userId }, 'Prefetch started');
    res.json({ status: 'started' });
  } catch (error) {
    logger.error({ err: error }, 'Failed to start prefetch');
    res.status(500).json({ error: 'Failed to start prefetch' });
  }
});

/**
 * POST /api/exit-session/initiate
 *
 * Runs PostHog analysis + AI + signed URL all in parallel where possible.
 */
app.post('/api/exit-session/initiate', authenticate, initiateRateLimit, async (req, res) => {
  try {
    const parsed = InitiateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`);
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    const { userId: rawUserId, planName, mrr, accountAge, sessionAnalysis } = parsed.data;
    const userId = rawUserId || `anon_${Date.now()}`;

    const sessionId = `exit_${Date.now()}_${userId}`;
    const startTime = Date.now();
    logger.info({ userId, sessionId }, 'Initiating exit session');

    // Get tenant-specific credentials
    const tenantConfig = req.tenant!.config;
    const agentId = tenantConfig.interventionAgentId;
    const chatAgentId = tenantConfig.chatAgentId;
    const elevenLabsApiKey = tenantConfig.elevenLabsApiKey;

    // Build PostHog credentials from tenant config
    const posthogCreds: PostHogCredentials = {
      apiKey: tenantConfig.posthogApiKey || '',
      projectId: tenantConfig.posthogProjectId || '',
      host: tenantConfig.posthogHost,
    };
    // Skip session analysis if client explicitly opted out
    const hasPosthog = sessionAnalysis !== false && !!(posthogCreds.apiKey && posthogCreds.projectId);

    // Check prefetch cache before running PostHog analysis
    const tenantId = req.tenant?.id || 'default';
    const cacheKey = prefetchKey(tenantId, userId);
    const cached = prefetchGet(cacheKey);
    let prefetchCacheHit = false;

    // Run signed URL fetch AND session analysis IN PARALLEL
    const tSignedUrl = Date.now();
    let signedUrl_ms = 0;

    const [signedUrlResult, chatSignedUrlResult, analysisResult] = await Promise.all([
      // Task 1a: Get signed URL for voice agent
      (agentId && elevenLabsApiKey)
        ? getElevenLabsSignedUrl(agentId, elevenLabsApiKey)
            .then(url => { signedUrl_ms = Date.now() - tSignedUrl; return url; })
            .catch(e => {
              signedUrl_ms = Date.now() - tSignedUrl;
              logger.warn({ err: e.message }, 'Could not get signed URL');
              return null;
            })
        : Promise.resolve(null).then(() => { signedUrl_ms = 0; return null; }),

      // Task 1b: Get signed URL for chat agent (if different from voice)
      (chatAgentId && elevenLabsApiKey && chatAgentId !== agentId)
        ? getElevenLabsSignedUrl(chatAgentId, elevenLabsApiKey)
            .catch(e => {
              logger.warn({ err: e.message }, 'Could not get chat signed URL');
              return null;
            })
        : Promise.resolve(null),

      // Task 2: Full session analysis — try prefetch cache first
      ((): Promise<any> => {
        // Cache hit with completed data
        if (cached.hit && cached.data) {
          prefetchCacheHit = true;
          logger.info({ userId }, 'Prefetch cache hit');
          return Promise.resolve(cached.data);
        }
        // In-flight prefetch — await the same promise
        if (cached.hit && cached.pending) {
          prefetchCacheHit = true;
          logger.info({ userId }, 'Awaiting in-flight prefetch');
          return cached.pending;
        }
        // Cache miss — run analysis normally
        if (!hasPosthog) {
          return Promise.resolve({ recordings: [] as any[], aiAnalysis: null, contextForAgent: '', timing: { personUuid_ms: 0, recordingsList_ms: 0, analyticsEvents_ms: 0, posthogParallel_ms: 0, elementExtraction_ms: 0, blobFetch_ms: 0, rrwebParse_ms: 0, enrichment_ms: 0, aiAnalysis_ms: 0, contextGen_ms: 0, total_ms: 0 } });
        }
        return analyzeUserSessions(posthogCreds, userId, { planName, mrr, accountAge });
      })(),
    ]);

    const { recordings, aiAnalysis, contextForAgent, timing } = analysisResult;
    const elapsed = Date.now() - startTime;

    logger.info({ signedUrl_ms, elapsed, recordingsCount: recordings.length }, 'Exit session analysis complete');
    if (aiAnalysis) {
      logger.info({ churnRisk: aiAnalysis.churn_risk, uxRating: aiAnalysis.ux_rating }, 'AI analysis result');
    }

    const fullContext = contextForAgent;

    // Build dynamic variables
    const frustrationPointsText = aiAnalysis?.frustration_points
      ?.map((fp: any) => `- [${fp.timestamp}] ${fp.issue}`)
      .join('\n') || 'No specific frustration points detected';

    const dropOffPointsText = aiAnalysis?.frustration_points
      ?.filter((fp: any) => fp.issue.toLowerCase().includes('abandon') || fp.issue.toLowerCase().includes('left') || fp.issue.toLowerCase().includes('exit'))
      .map((fp: any) => `- [${fp.timestamp}] ${fp.issue}`)
      .join('\n') || 'No drop-off points detected';

    const dynamicVariables = {
      user_name: userId,
      company_name: planName || 'Unknown',
      plan_name: planName || 'Unknown',
      mrr: String(mrr || 0),
      account_age: accountAge || 'Unknown',
      session_insights: fullContext,
      summary: aiAnalysis?.summary || 'No session analysis available',
      user_intent: aiAnalysis?.user_intent || 'Unknown',
      churn_risk: aiAnalysis?.churn_risk || 'unknown',
      ux_rating: String(aiAnalysis?.ux_rating || 'N/A'),
      recommended_offer: aiAnalysis?.recommended_offer || 'Standard retention offer',
      frustration_points: frustrationPointsText,
      drop_off_points: dropOffPointsText,
      user_journey: aiAnalysis?.description || 'No journey data available',
      went_well: aiAnalysis?.went_well?.join(', ') || 'Unable to determine',
      tags: aiAnalysis?.tags?.join(', ') || 'No tags',
      opening_line: aiAnalysis?.opening_line || '',
      probing_questions: aiAnalysis?.probing_questions?.join(' | ') || '',
      value_hooks: aiAnalysis?.value_hooks?.join(' | ') || '',
      unasked_needs: aiAnalysis?.unasked_needs?.join(' | ') || '',
    };

    // Persist session to database if available
    if (db) {
      try {
        await db.insert(sessions).values({
          id: sessionId,
          tenantId: req.tenant?.id !== 'default' ? req.tenant?.id : null,
          userId,
          status: 'initiated',
          agentId: agentId || null,
          context: fullContext,
          dynamicVariables,
          aiAnalysis,
          timing: { ...timing, signedUrl_ms, total_ms: elapsed },
        });
      } catch (e) {
        logger.warn({ err: e }, 'Failed to persist session to DB (non-fatal)');
      }
    }

    res.json({
      sessionId,
      agentId: agentId || null,
      signedUrl: signedUrlResult,
      chatAgentId: chatAgentId || null,
      chatSignedUrl: chatSignedUrlResult,
      context: fullContext,
      dynamicVariables,
      elapsed_ms: elapsed,
      timing: {
        ...timing,
        signedUrl_ms,
        prefetchCacheHit,
        total_ms: elapsed,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to initiate exit session');
    res.status(500).json({ error: 'Failed to initiate session' });
  }
});

/**
 * POST /api/exit-session/complete
 *
 * Records the outcome of an exit interview
 */
app.post('/api/exit-session/complete', authenticate, completeRateLimit, async (req, res) => {
  try {
    const parsed = CompleteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`);
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    const { sessionId, userId, outcome, acceptedOffer, transcript } = parsed.data;

    logger.info({ sessionId, outcome }, 'Completing exit session');

    // Update session in database if available
    if (db) {
      try {
        await db.update(sessions)
          .set({
            status: outcome || 'completed',
            outcome,
            offers: acceptedOffer ? [acceptedOffer] : null,
            transcript,
            completedAt: new Date(),
          })
          .where(eq(sessions.id, sessionId));
      } catch (e) {
        logger.warn({ err: e }, 'Failed to update session in DB (non-fatal)');
      }
    }

    // Send event to PostHog using tenant's credentials
    const tenantConfig = req.tenant?.config;
    const phApiKey = tenantConfig?.posthogApiKey;
    const phHost = tenantConfig?.posthogHost || 'https://app.posthog.com';

    if (phApiKey) {
      try {
        await fetch(`${phHost}/capture/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: phApiKey,
            event: outcome === 'retained' ? 'user_retained' : 'user_churned',
            distinct_id: userId,
            properties: {
              session_id: sessionId,
              accepted_offer: acceptedOffer,
              transcript_length: transcript?.length || 0,
            },
          }),
        });
      } catch (e) {
        logger.warn({ err: e }, 'Failed to send event to PostHog (non-fatal)');
      }
    }

    res.json({
      success: true,
      sessionId,
      outcome,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to complete exit session');
    res.status(500).json({ error: 'Failed to complete session' });
  }
});

/**
 * GET /api/exit-session/:sessionId
 *
 * Get session details from database
 */
app.get('/api/exit-session/:sessionId', authenticate, async (req, res) => {
  const sessionId = req.params.sessionId as string;

  if (!db) {
    return res.status(503).json({ error: 'Database not configured', sessionId });
  }

  try {
    const result = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (result.length === 0) {
      return res.status(404).json({ error: 'Session not found', sessionId });
    }
    res.json(result[0]);
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch session');
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

/**
 * GET /api/health
 */
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    database: db ? 'connected' : 'not configured',
  });
});

// ============ Global Error Handler ============

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'Unhandled route error');
  res.status(500).json({ error: 'Internal server error' });
});

// ============ Graceful Shutdown ============

let server: ReturnType<typeof app.listen>;

function shutdown(signal: string) {
  logger.info({ signal }, 'Received shutdown signal, closing server...');
  server?.close(async () => {
    if (pool) {
      await pool.end();
      logger.info('Database pool closed');
    }
    logger.info('Server closed');
    process.exit(0);
  });
  // Force exit after 10 seconds
  setTimeout(() => {
    logger.warn('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

// ============ Start Server ============

// Only listen when running directly (not on Vercel serverless)
if (!process.env.VERCEL) {
  server = app.listen(config.port, () => {
    logger.info({
      port: config.port,
      env: config.nodeEnv,
      database: db ? 'connected' : 'not configured',
    }, 'Exit Button Backend started');
  });
}

export default app;

// ============ Widget Endpoints ============

const WIDGET_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-tranzmit-api-key',
};

/**
 * Serve the built prechurn-widget script
 */
let cachedWidgetJs: string | null = null;

app.get('/widget.js', (_req, res) => {
  if (!cachedWidgetJs) {
    const paths = [
      resolve(__dirname, '../../widget/dist/index.global.js'),
      resolve(process.cwd(), 'packages/widget/dist/index.global.js'),
    ];
    for (const p of paths) {
      if (existsSync(p)) {
        cachedWidgetJs = readFileSync(p, 'utf-8');
        break;
      }
    }
  }

  if (cachedWidgetJs) {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(cachedWidgetJs);
  } else {
    res.status(404).send('// widget.js not found — run pnpm build first');
  }
});

/**
 * Lightweight API key auth for widget browser endpoints.
 * Accepts key via ?key= query param, x-tranzmit-api-key header, or Authorization: Bearer.
 */
async function authenticateWidget(req: express.Request, res: express.Response): Promise<string | null> {
  const keyFromQuery  = req.query.key as string | undefined;
  const keyFromHeader = (req.headers['x-tranzmit-api-key'] as string | undefined)
    || (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : undefined);
  const key = keyFromQuery || keyFromHeader;

  if (!key || key.length < 20 || (!key.startsWith('eb_live_') && !key.startsWith('eb_test_'))) {
    res.status(401).json({ error: 'Invalid API key' });
    return null;
  }

  return key.substring(0, 12); // tenant key prefix
}

app.options('/api/widget/*', (req, res) => {
  res.set(WIDGET_CORS_HEADERS).status(204).end();
});

/**
 * POST /api/widget/trigger
 * Dashboard → backend: queue a voice interview invite for one or more users.
 * Auth: standard Bearer token (dashboard-to-server).
 */
app.post('/api/widget/trigger', authenticate, async (req, res) => {
  try {
    const { distinctIds, userName } = req.body as {
      distinctIds: string[];
      userName?: string;
    };

    if (!Array.isArray(distinctIds) || distinctIds.length === 0) {
      return res.status(400).json({ error: 'distinctIds must be a non-empty array' });
    }

    if (!db) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const { widgetTriggers } = await import('./db/schema');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30-minute window

    const triggers = await Promise.all(
      distinctIds.map(async (distinctId: string) => {
        // Upsert: reset any existing pending trigger for this user
        const existing = await db!.select()
          .from(widgetTriggers)
          .where(
            (await import('drizzle-orm')).and(
              (await import('drizzle-orm')).eq(widgetTriggers.tenantId, req.tenant!.id !== 'default' ? req.tenant!.id : null as any),
              (await import('drizzle-orm')).eq(widgetTriggers.distinctId, distinctId),
              (await import('drizzle-orm')).eq(widgetTriggers.status, 'pending'),
            )
          )
          .limit(1);

        if (existing.length > 0) {
          const [updated] = await db!.update(widgetTriggers)
            .set({ expiresAt, userName: userName ?? existing[0]!.userName, updatedAt: new Date() })
            .where((await import('drizzle-orm')).eq(widgetTriggers.id, existing[0]!.id))
            .returning();
          return updated;
        }

        const [created] = await db!.insert(widgetTriggers)
          .values({
            tenantId: req.tenant!.id !== 'default' ? req.tenant!.id : undefined,
            distinctId,
            userName,
            expiresAt,
          })
          .returning();
        return created;
      })
    );

    logger.info({ count: triggers.length }, 'Widget triggers created');
    return res.json({ ok: true, count: triggers.length });
  } catch (error) {
    logger.error({ err: error }, 'Failed to create widget trigger');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/widget/check
 * Widget (browser) → backend: has a trigger been queued for this user?
 * Returns { show: true, triggerId, userName, interviewApiKey } or { show: false }.
 * Auth: ?key= query param or x-tranzmit-api-key header.
 */
app.get('/api/widget/check', async (req, res) => {
  res.set(WIDGET_CORS_HEADERS);
  const keyPrefix = await authenticateWidget(req, res);
  if (!keyPrefix) return;

  const distinctId = req.query.distinctId as string | undefined;
  if (!distinctId) {
    return res.json({ show: false });
  }

  if (!db) {
    return res.json({ show: false });
  }

  try {
    const { widgetTriggers } = await import('./db/schema');
    const drizzle = await import('drizzle-orm');

    // Look up tenant by key prefix
    const { apiKeys, tenants } = await import('./db/schema');
    const tenantRows = await db.select({ id: tenants.id })
      .from(apiKeys)
      .innerJoin(tenants, drizzle.eq(apiKeys.tenantId, tenants.id))
      .where(drizzle.eq(apiKeys.keyPrefix, keyPrefix))
      .limit(1);

    const tenantId = tenantRows[0]?.id ?? null;

    const whereClause = tenantId
      ? drizzle.and(
          drizzle.eq(widgetTriggers.tenantId, tenantId),
          drizzle.eq(widgetTriggers.distinctId, distinctId),
          drizzle.eq(widgetTriggers.status, 'pending'),
          drizzle.gt(widgetTriggers.expiresAt, new Date()),
        )
      : drizzle.and(
          drizzle.eq(widgetTriggers.distinctId, distinctId),
          drizzle.eq(widgetTriggers.status, 'pending'),
          drizzle.gt(widgetTriggers.expiresAt, new Date()),
        );

    const results = await db.select()
      .from(widgetTriggers)
      .where(whereClause)
      .orderBy(drizzle.desc(widgetTriggers.createdAt))
      .limit(1);

    if (results.length === 0) {
      return res.json({ show: false });
    }

    const trigger = results[0]!;

    // Mark as shown
    await db.update(widgetTriggers)
      .set({ status: 'shown', shownAt: new Date(), updatedAt: new Date() })
      .where(drizzle.eq(widgetTriggers.id, trigger.id));

    return res.json({
      show: true,
      triggerId: trigger.id,
      userName: trigger.userName,
    });
  } catch (error) {
    logger.error({ err: error }, '[Widget Check] Error');
    return res.json({ show: false });
  }
});

/**
 * POST /api/widget/complete
 * Widget (browser) → backend: record the outcome (clicked | dismissed).
 * No auth required — triggerId acts as a secret.
 */
app.post('/api/widget/complete', async (req, res) => {
  res.set(WIDGET_CORS_HEADERS);

  const { triggerId, outcome } = req.body as { triggerId?: string; outcome?: string };
  if (!triggerId || !outcome) {
    return res.status(400).json({ error: 'triggerId and outcome are required' });
  }

  if (!db) {
    return res.json({ ok: true }); // non-fatal if no DB
  }

  try {
    const { widgetTriggers } = await import('./db/schema');
    const { eq } = await import('drizzle-orm');

    await db.update(widgetTriggers)
      .set({ status: outcome, updatedAt: new Date() })
      .where(eq(widgetTriggers.id, triggerId));

    return res.json({ ok: true });
  } catch (error) {
    logger.error({ err: error }, '[Widget Complete] Error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});
