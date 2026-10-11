import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import * as core from './core.js';
import { llmsTxt, openapi, agentCard, mcpServerCard } from './discovery.js';
import { mcpHandler } from './mcp.js';
import { loadSecrets, initPersistence } from './persistence.js';

await loadSecrets();
initPersistence();
await core.restore();

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const bannedIps = new Set();
const requestLog = [];                       // ring buffer, newest last
const LOG_MAX = 500;

export const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));

const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

// ---- security headers, logging, global gates ------------------------------------------------------

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  next();
});

app.use((req, res, next) => {
  res.on('finish', () => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/mcp') && !req.path.startsWith('/admin')) return;
    requestLog.push({ t: Date.now(), ip: req.ip, method: req.method, path: req.path, status: res.statusCode, ua: (req.get('user-agent') || '').slice(0, 80) });
    if (requestLog.length > LOG_MAX) requestLog.shift();
  });
  next();
});

app.use((req, res, next) => (bannedIps.has(req.ip) ? res.status(403).json({ error: 'blocked' }) : next()));

app.use(express.json({ limit: '2kb', type: 'application/json' }));
app.use((err, _req, res, next) => {          // malformed / oversized JSON
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'body too large' });
  if (err instanceof SyntaxError || err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  next(err);
});

const limiter = (windowMs, limit, message) => rateLimit({
  windowMs, limit, standardHeaders: true, legacyHeaders: false,
  message: { error: message },
});
const readLimit = limiter(60e3, 240, 'rate limit: too many requests, slow down');
const writeLimit = limiter(60e3, 60, 'rate limit: too many write requests, slow down');
const registerLimit = limiter(3600e3, 20, 'rate limit: too many registrations from this address this hour');

const gate = (_req, res, next) => (core.platform.paused ? res.status(503).json({ error: 'platform temporarily paused by operator' }) : next());
const requireAuth = (req, res, next) => {
  const r = core.authenticate(req.get('authorization'));
  if (r.error) return send(res, r.error);
  req.agent = r.agent;
  next();
};
const send = (res, { status, body }) => res.status(status).json(body);

// ---- discovery ---------------------------------------------------------------------------------------

app.get('/llms.txt', (req, res) => res.type('text/plain').send(llmsTxt(baseUrl(req))));
app.get('/openapi.json', (req, res) => res.json(openapi(baseUrl(req))));
app.get('/.well-known/agent.json', (req, res) => res.json(agentCard(baseUrl(req))));
app.get('/.well-known/agent-card.json', (req, res) => res.json(agentCard(baseUrl(req))));
app.get('/.well-known/mcp.json', (req, res) => res.json(mcpServerCard(baseUrl(req))));
app.get('/.well-known/mcp/server-card.json', (req, res) => res.json(mcpServerCard(baseUrl(req))));
app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\n\n# Agents: start at ${baseUrl(req)}/llms.txt\nSitemap: ${baseUrl(req)}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => {
  const b = baseUrl(req);
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${['/', '/llms.txt', '/openapi.json', '/.well-known/agent.json', '/.well-known/mcp.json', '/api'].map((p) => `  <url><loc>${b}${p}</loc></url>`).join('\n')}\n</urlset>\n`);
});

// ---- REST API -----------------------------------------------------------------------------------------

const api = express.Router();
api.use(readLimit);
api.get('/', (req, res) => res.type('text/plain').send(llmsTxt(baseUrl(req))));
api.get('/health', (_req, res) => res.json({ status: 'ok' }));

api.post('/register', registerLimit, gate, (req, res) => send(res, core.register(req.body?.name)));
api.get('/seeks', (_req, res) => send(res, core.listSeeks()));
api.get('/games', (_req, res) => send(res, core.listGames()));
api.get('/leaderboard', (_req, res) => send(res, core.leaderboard()));
api.get('/stats', (_req, res) => send(res, core.stats()));
api.get('/me', requireAuth, (req, res) => send(res, core.me(req.agent)));

api.get('/games/:id', (req, res) => {
  const a = req.get('authorization') ? core.authenticate(req.get('authorization')).agent : null;
  send(res, core.getGame(req.params.id.slice(0, 32), a ?? null));
});

api.post('/play', writeLimit, gate, requireAuth, (req, res) => send(res, core.play(req.agent, req.body?.hoursPerMove)));
api.post('/seek', writeLimit, gate, requireAuth, (req, res) => send(res, core.seek(req.agent, req.body?.hoursPerMove)));
api.post('/seeks/:id/accept', writeLimit, gate, requireAuth, (req, res) => send(res, core.acceptSeek(req.agent, req.params.id.slice(0, 32))));
api.post('/games/:id/move', writeLimit, gate, requireAuth, (req, res) => send(res, core.move(req.agent, req.params.id.slice(0, 32), req.body?.move)));
api.post('/games/:id/resign', writeLimit, gate, requireAuth, (req, res) => send(res, core.resign(req.agent, req.params.id.slice(0, 32))));
api.use((_req, res) => res.status(404).json({ error: 'not found; see /llms.txt' }));
app.use('/api', api);

app.get('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'POST JSON-RPC to /mcp' }));
app.post('/mcp', readLimit, (req, res, next) => (core.platform.paused ? res.status(503).json({ error: 'paused' }) : next()), mcpHandler);

// ---- operator admin (needs ADMIN_TOKEN from Secrets Manager) ----------------------------------------------------

const admin = express.Router();
admin.use(limiter(60e3, 60, 'rate limit'));
admin.use((req, res, next) => {
  const given = Buffer.from((req.get('authorization') || '').replace(/^Bearer /, ''));
  const want = Buffer.from(ADMIN_TOKEN);
  if (!ADMIN_TOKEN || given.length !== want.length || !timingSafeEqual(given, want)) return res.status(404).json({ error: 'not found' });
  next();
});
admin.get('/overview', (_req, res) => res.json({ ...core.adminOverview(), bannedIps: [...bannedIps], recentRequests: requestLog.slice(-100).reverse() }));
admin.post('/pause', (req, res) => { core.platform.paused = !!req.body?.paused; res.json({ paused: core.platform.paused }); });
admin.post('/ban-agent', (req, res) => send(res, core.banAgent(String(req.body?.agentId ?? ''), req.body?.banned !== false)));
admin.post('/ban-ip', (req, res) => { const ip = String(req.body?.ip ?? ''); if (ip) { req.body.unban ? bannedIps.delete(ip) : bannedIps.add(ip); } res.json({ bannedIps: [...bannedIps] }); });
// Site-visit log: tail of Caddy's JSON access log (mounted read-only into the container).
admin.get('/visits', (req, res) => {
  const file = process.env.ACCESS_LOG;
  if (!file) return res.status(501).json({ error: 'ACCESS_LOG not configured' });
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 1.5 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const rows = [];
    for (const line of buf.toString('utf8').split('\n').slice(size > len ? 1 : 0)) {
      try {
        const j = JSON.parse(line);
        const r = j.request ?? {};
        rows.push({
          t: Math.round(j.ts * 1000), ip: r.client_ip || r.remote_ip, method: r.method, host: r.host,
          uri: r.uri, status: j.status, ua: (r.headers?.['User-Agent']?.[0] || '').slice(0, 120),
        });
      } catch { /* partial or non-JSON line */ }
    }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const count = (key) => Object.entries(rows.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {}))
      .sort((a, b) => b[1] - a[1]).slice(0, 15);
    res.json({
      note: 'user agents are self-reported and can be spoofed',
      windowRequests: rows.length, uniqueIps: new Set(rows.map((r) => r.ip)).size,
      topPaths: count('uri'), topIps: count('ip'), topUserAgents: count('ua'), statuses: count('status'),
      recent: rows.slice(-limit).reverse(),
    });
  } catch (err) {
    res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: err.code === 'ENOENT' ? 'no access log yet' : 'cannot read log' });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
});
app.use('/admin/api', admin);

// ---- spectator site -----------------------------------------------------------------------------------------------

app.use(express.static(CLIENT_DIR, { maxAge: '5m' }));
app.use((_req, res) => res.status(404).type('text/plain').send('Not found. Agents: see /llms.txt'));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'internal error' }); });

if (process.env.NODE_ENV !== 'test-import') {
  const server = http.createServer(app);
  setInterval(() => core.sweep(), 30e3).unref();
  server.listen(PORT, '0.0.0.0', () => console.log(`AI Chess Arena listening on http://0.0.0.0:${PORT}`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}
