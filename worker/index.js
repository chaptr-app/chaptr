const SYSTEM_RECOMMEND = `You are the book recommendation engine for Chaptr, a reading-habit app.
Return ONLY a valid JSON array — no prose, no markdown fences, nothing else.
The array must contain exactly 3 objects with these fields:
[
  {
    "title": "Exact published book title",
    "author": "Author full name",
    "genre": "Literary|Thriller|Sci-fi|Non-fiction|Fantasy",
    "pages": 320,
    "why": "One sentence tailored to this reader — reference their pace, session length, genre history, or mood.",
    "signals": "The specific data points that drove this pick (e.g. WPM × genre × session length)"
  }
]
Rules:
- Only real, published titles
- Vary genres unless the query specifies one
- "why" must reference at least one reader DNA stat
- "pages" should be accurate`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Chaptr-User',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function isValidUserId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

// ---------- Clerk JWT verification (Phase 1C) ----------
// Cached at module scope; survives within a single isolate, refreshes hourly.
let _jwksCache = null;
let _jwksFetchedAt = 0;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getClerkJwks(env) {
  if (!env.CLERK_FRONTEND_API) throw new Error('CLERK_FRONTEND_API not configured');
  if (_jwksCache && (Date.now() - _jwksFetchedAt) < JWKS_TTL_MS) return _jwksCache;
  const url = `https://${env.CLERK_FRONTEND_API}/.well-known/jwks.json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('JWKS fetch failed: ' + resp.status);
  _jwksCache = await resp.json();
  _jwksFetchedAt = Date.now();
  return _jwksCache;
}

function base64UrlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function base64UrlToString(s) {
  const bytes = base64UrlToBytes(s);
  return new TextDecoder().decode(bytes);
}

async function verifyClerkToken(token, env) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');
  const [hB64, pB64, sB64] = parts;

  const header = JSON.parse(base64UrlToString(hB64));
  const payload = JSON.parse(base64UrlToString(pB64));

  if (header.alg !== 'RS256') throw new Error('Unsupported alg: ' + header.alg);
  if (!header.kid) throw new Error('Missing kid');

  const now = Math.floor(Date.now() / 1000);
  // 30s clock-skew leeway in both directions
  if (payload.exp && payload.exp + 30 < now) throw new Error('Token expired');
  if (payload.nbf && payload.nbf - 30 > now) throw new Error('Token not yet valid');

  const expectedIss = `https://${env.CLERK_FRONTEND_API}`;
  if (payload.iss !== expectedIss) throw new Error('Issuer mismatch: ' + payload.iss);

  const jwks = await getClerkJwks(env);
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('No JWKS key for kid ' + header.kid);

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const data = new TextEncoder().encode(hB64 + '.' + pB64);
  const signature = base64UrlToBytes(sB64);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, data);
  if (!ok) throw new Error('Bad signature');

  if (!payload.sub) throw new Error('Token has no sub');
  return payload;
}

// Resolve the authenticated user for a request. Returns { userId, verified, error? }.
// - Authorization: Bearer <token> → verified Clerk user
// - X-Chaptr-User → anonymous device ID (must NOT look like a clerk id without a token)
async function resolveUserId(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    try {
      const payload = await verifyClerkToken(token, env);
      const safeSub = payload.sub.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56);
      return { userId: 'clerk_' + safeSub, verified: true };
    } catch (e) {
      return { userId: null, verified: false, error: 'jwt: ' + e.message };
    }
  }

  const header = request.headers.get('X-Chaptr-User') || '';
  const queryId = (new URL(request.url)).searchParams.get('userId') || '';
  const candidate = header || queryId;
  if (!isValidUserId(candidate)) return { userId: null, verified: false, error: 'no auth' };
  // Block claims to a clerk id without a verified Bearer token.
  if (candidate.startsWith('clerk_')) {
    return { userId: null, verified: false, error: 'clerk_ ids require Bearer token' };
  }
  return { userId: candidate, verified: false };
}

async function handleRecommend(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { query, readerDna = {} } = body;
  if (!query?.trim()) return json({ error: 'Missing query' }, 400);

  const userMsg = `Reader DNA:
- Avg WPM: ${readerDna.wpm || 'unknown'}
- Avg session: ${readerDna.avgSession || 'unknown'} min
- Top genre: ${readerDna.topGenre || 'unknown'}
- Recent mood: ${readerDna.mood || 'unknown'}
- Books on shelves: ${readerDna.shelfCount || 0}

Request: "${query}"`;

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 900,
        system: SYSTEM_RECOMMEND,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
  } catch (e) {
    return json({ error: 'Failed to reach Claude API: ' + e.message }, 502);
  }

  if (!anthropicRes.ok) {
    const err = await anthropicRes.text().catch(() => 'unknown');
    return json({ error: 'Claude API error', status: anthropicRes.status, detail: err }, 502);
  }

  const data = await anthropicRes.json();
  const text = data.content?.[0]?.text || '[]';

  let books;
  try {
    const match = text.match(/\[[\s\S]*\]/);
    books = JSON.parse(match ? match[0] : text);
    if (!Array.isArray(books)) throw new Error('not an array');
  } catch {
    return json({ error: 'Could not parse Claude response', raw: text }, 502);
  }

  return json({ books });
}

// ---------- D1: snapshot sync ----------
async function ensureSchema(env) {
  if (!env.DB) throw new Error('D1 binding "DB" is not configured. Run wrangler d1 create + bind in wrangler.toml.');
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS snapshots (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS reviews (
      user_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      rating REAL,
      text TEXT,
      visibility TEXT NOT NULL DEFAULT 'private',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, book_id)
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_reviews_book_public ON reviews(book_id, visibility)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id, updated_at DESC)`).run();
}

async function handleMe(request, env) {
  const { userId, verified, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  await ensureSchema(env);
  const now = new Date().toISOString();
  const existing = await env.DB.prepare('SELECT id, created_at FROM users WHERE id = ?').bind(userId).first();
  if (existing) {
    await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, userId).run();
    return json({ id: userId, createdAt: existing.created_at, lastSeenAt: now, isNew: false });
  }
  await env.DB.prepare('INSERT INTO users (id, created_at, last_seen_at) VALUES (?, ?, ?)').bind(userId, now, now).run();
  return json({ id: userId, createdAt: now, lastSeenAt: now, isNew: true, verified });
}

async function handleLoad(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT data, version, updated_at FROM snapshots WHERE user_id = ?').bind(userId).first();
  if (!row) return json({ snapshot: null, version: 0, updatedAt: null });
  let snapshot;
  try { snapshot = JSON.parse(row.data); } catch { snapshot = null; }
  return json({ snapshot, version: row.version, updatedAt: row.updated_at });
}

async function handleSync(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }
  if (!body || typeof body !== 'object' || !body.snapshot || typeof body.snapshot !== 'object') {
    return json({ error: 'Missing snapshot object' }, 400);
  }

  // Size guard: payload is the whole client state. Cap at 1 MB to keep D1 happy.
  const dataStr = JSON.stringify(body.snapshot);
  if (dataStr.length > 1_000_000) return json({ error: 'Snapshot too large (>1MB)' }, 413);

  await ensureSchema(env);
  const now = new Date().toISOString();
  // Ensure user row exists
  await env.DB.prepare(`
    INSERT INTO users (id, created_at, last_seen_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).bind(userId, now, now).run();

  const existing = await env.DB.prepare('SELECT version FROM snapshots WHERE user_id = ?').bind(userId).first();
  const newVersion = (existing?.version || 0) + 1;
  await env.DB.prepare(`
    INSERT INTO snapshots (user_id, data, version, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      data = excluded.data,
      version = excluded.version,
      updated_at = excluded.updated_at
  `).bind(userId, dataStr, newVersion, now).run();

  return json({ ok: true, version: newVersion, updatedAt: now });
}

// ---------- Reviews (Phase 2A) ----------
const VISIBILITY = new Set(['private', 'friends', 'public']);

async function handleReviewUpsert(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { bookId, rating, text, visibility } = body || {};
  if (!bookId || typeof bookId !== 'string' || bookId.length > 128) return json({ error: 'Missing or bad bookId' }, 400);
  if (rating !== null && rating !== undefined && (typeof rating !== 'number' || rating < 0 || rating > 5)) {
    return json({ error: 'rating must be 0-5 or null' }, 400);
  }
  const cleanText = (text === null || text === undefined) ? null : String(text).slice(0, 5000);
  const v = VISIBILITY.has(visibility) ? visibility : 'private';
  // If review is effectively empty, delete it
  if ((rating === null || rating === undefined) && !cleanText) {
    await ensureSchema(env);
    await env.DB.prepare('DELETE FROM reviews WHERE user_id = ? AND book_id = ?').bind(userId, bookId).run();
    return json({ ok: true, deleted: true });
  }
  await ensureSchema(env);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO reviews (user_id, book_id, rating, text, visibility, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, book_id) DO UPDATE SET
      rating = excluded.rating,
      text = excluded.text,
      visibility = excluded.visibility,
      updated_at = excluded.updated_at
  `).bind(userId, bookId, rating ?? null, cleanText, v, now).run();
  return json({ ok: true, bookId, visibility: v, updatedAt: now });
}

async function handleReviewDelete(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  const url = new URL(request.url);
  const bookId = url.searchParams.get('bookId');
  if (!bookId) return json({ error: 'Missing bookId' }, 400);
  await ensureSchema(env);
  await env.DB.prepare('DELETE FROM reviews WHERE user_id = ? AND book_id = ?').bind(userId, bookId).run();
  return json({ ok: true });
}

async function handleReviewsMine(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  await ensureSchema(env);
  const rows = await env.DB.prepare(
    'SELECT book_id, rating, text, visibility, updated_at FROM reviews WHERE user_id = ? ORDER BY updated_at DESC'
  ).bind(userId).all();
  return json({ reviews: rows?.results || [] });
}

// Public stats for a book — anonymous, no auth required.
async function handleBookStats(request, env, bookId) {
  if (!bookId) return json({ error: 'Missing bookId' }, 400);
  await ensureSchema(env);
  const row = await env.DB.prepare(
    `SELECT AVG(rating) AS avg_rating, COUNT(*) AS cnt
     FROM reviews
     WHERE book_id = ? AND visibility = 'public' AND rating IS NOT NULL`
  ).bind(bookId).first();
  return json({
    bookId,
    avgRating: row?.avg_rating != null ? Math.round(row.avg_rating * 10) / 10 : null,
    count: row?.cnt || 0,
  });
}

// Recent public reviews — anonymous, no auth required. Useful for a community feed later.
async function handleReviewsPublic(request, env) {
  const url = new URL(request.url);
  const bookId = url.searchParams.get('bookId') || null;
  const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit'), 10) || 10));
  await ensureSchema(env);
  const query = bookId
    ? `SELECT user_id, book_id, rating, text, updated_at FROM reviews
       WHERE visibility = 'public' AND book_id = ?
       ORDER BY updated_at DESC LIMIT ?`
    : `SELECT user_id, book_id, rating, text, updated_at FROM reviews
       WHERE visibility = 'public'
       ORDER BY updated_at DESC LIMIT ?`;
  const stmt = bookId
    ? env.DB.prepare(query).bind(bookId, limit)
    : env.DB.prepare(query).bind(limit);
  const rows = await stmt.all();
  return json({ reviews: rows?.results || [] });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, ''); // strip trailing slash

    // Backward-compatible recommend endpoint at root.
    if ((path === '' || path === '/') && request.method === 'POST') {
      return handleRecommend(request, env);
    }
    if (path === '/me' && request.method === 'POST') return handleMe(request, env);
    if (path === '/load' && request.method === 'GET') return handleLoad(request, env);
    if (path === '/sync' && request.method === 'POST') return handleSync(request, env);

    // Reviews (Phase 2A)
    if (path === '/reviews' && request.method === 'POST') return handleReviewUpsert(request, env);
    if (path === '/reviews' && request.method === 'DELETE') return handleReviewDelete(request, env);
    if (path === '/reviews/mine' && request.method === 'GET') return handleReviewsMine(request, env);
    if (path === '/reviews/public' && request.method === 'GET') return handleReviewsPublic(request, env);
    // /books/<id>/stats
    const bookStatsMatch = path.match(/^\/books\/([^/]+)\/stats$/);
    if (bookStatsMatch && request.method === 'GET') return handleBookStats(request, env, decodeURIComponent(bookStatsMatch[1]));

    if (path === '/health') {
      return json({
        ok: true,
        hasDb: !!env.DB,
        hasClerk: !!env.CLERK_FRONTEND_API,
        clerkInstance: env.CLERK_FRONTEND_API || null,
      });
    }

    return json({ error: 'Not found', path, method: request.method }, 404);
  },
};
