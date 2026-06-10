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
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Chaptr-User, Authorization',
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
      username TEXT,
      display_name TEXT,
      avatar_hue INTEGER,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `).run();
  // Backfill columns if the users table existed before Phase 2B.
  for (const col of [
    ['username', 'TEXT'],
    ['display_name', 'TEXT'],
    ['avatar_hue', 'INTEGER'],
  ]) {
    try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN ${col[0]} ${col[1]}`).run(); } catch {}
  }
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL`).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL,
      followee_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (follower_id, followee_id)
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id)`).run();
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
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS book_finishes (
      user_id TEXT NOT NULL,
      book_id TEXT NOT NULL,
      total_minutes INTEGER NOT NULL,
      finished_at TEXT NOT NULL,
      PRIMARY KEY (user_id, book_id)
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_finishes_book ON book_finishes(book_id)`).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS custom_shelves (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      books TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_shelves_owner_vis ON custom_shelves(owner_id, visibility)`).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS shelf_members (
      shelf_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      added_at TEXT NOT NULL,
      PRIMARY KEY (shelf_id, user_id)
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sm_user ON shelf_members(user_id)`).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS pair_reads (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      inviter_id TEXT NOT NULL,
      invitee_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pair_inviter ON pair_reads(inviter_id, status)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pair_invitee ON pair_reads(invitee_id, status)`).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS pair_read_messages (
      id TEXT PRIMARY KEY,
      pair_read_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pr_messages_pair ON pair_read_messages(pair_read_id, created_at)`).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS friend_challenges (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      target INTEGER NOT NULL,
      deadline TEXT,
      created_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_fc_owner ON friend_challenges(owner_id)`).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS friend_challenge_members (
      challenge_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'invited',
      joined_at TEXT NOT NULL,
      PRIMARY KEY (challenge_id, user_id)
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_fcm_user ON friend_challenge_members(user_id, status)`).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS coach_usage (
      scope TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (scope, day)
    )
  `).run();
  // Analytics events — first-party product event log.
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      device_id TEXT,
      name TEXT NOT NULL,
      props TEXT,
      created_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_events_name_date ON events(name, created_at)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_events_user_date ON events(user_id, created_at)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_events_device_date ON events(device_id, created_at)`).run();
}

// ---------- Claude rate limits (V4 polish) ----------
// Per-IP cap (default 50/day) catches both anon and signed-in abuse.
// Global cap (default 1000/day, ~$3/day at Haiku pricing) bounds worst-case spend.
function rateLimitScope(request) {
  const ip = request.headers.get('CF-Connecting-IP')
          || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
          || request.headers.get('X-Real-IP')
          || 'unknown';
  return 'ip_' + ip;
}

async function enforceClaudeLimits(request, env) {
  await ensureSchema(env);
  const day = new Date().toISOString().slice(0, 10);
  const perIp = parseInt(env.USER_DAILY_CAP, 10) || 50;
  const globalCap = parseInt(env.GLOBAL_DAILY_CAP, 10) || 1000;
  const scope = rateLimitScope(request);

  // Global check first — if the whole app is over budget, no one calls Claude.
  const g = await env.DB.prepare('SELECT count FROM coach_usage WHERE scope = ? AND day = ?').bind('global', day).first();
  if (g && g.count >= globalCap) {
    return {
      ok: false, status: 503,
      headers: { 'X-RateLimit-Scope': 'global', 'X-RateLimit-Remaining': '0' },
      error: 'Claude is napping for the day — global usage cap reached. Try again tomorrow.',
    };
  }
  // Per-IP check.
  const u = await env.DB.prepare('SELECT count FROM coach_usage WHERE scope = ? AND day = ?').bind(scope, day).first();
  const used = u?.count || 0;
  if (used >= perIp) {
    return {
      ok: false, status: 429,
      headers: { 'X-RateLimit-Scope': 'ip', 'X-RateLimit-Limit': String(perIp), 'X-RateLimit-Remaining': '0' },
      error: `You've used ${perIp} Claude requests today. The limit resets at midnight UTC.`,
    };
  }
  // Increment both counters.
  await env.DB.prepare(`
    INSERT INTO coach_usage (scope, day, count) VALUES (?, ?, 1)
    ON CONFLICT(scope, day) DO UPDATE SET count = count + 1
  `).bind('global', day).run();
  await env.DB.prepare(`
    INSERT INTO coach_usage (scope, day, count) VALUES (?, ?, 1)
    ON CONFLICT(scope, day) DO UPDATE SET count = count + 1
  `).bind(scope, day).run();

  return {
    ok: true,
    headers: {
      'X-RateLimit-Scope': 'ip',
      'X-RateLimit-Limit': String(perIp),
      'X-RateLimit-Remaining': String(Math.max(0, perIp - used - 1)),
    },
  };
}

// Lightweight per-IP daily cap for cheap endpoints (/event, /me). Uses the
// same coach_usage table with a separate scope namespace so we don't pollute
// the Claude counters. Default 5000/day per IP — way above legit usage but
// stops a flood from filling up the free-tier D1 write quota.
async function enforceCheapLimits(request, env, kind, cap = 5000) {
  await ensureSchema(env);
  const day = new Date().toISOString().slice(0, 10);
  const scope = `${kind}_${rateLimitScope(request)}`;
  const row = await env.DB.prepare(
    'SELECT count FROM coach_usage WHERE scope = ? AND day = ?'
  ).bind(scope, day).first();
  if ((row?.count || 0) >= cap) {
    return { ok: false, status: 429, error: 'Too many requests today. Try again tomorrow.' };
  }
  await env.DB.prepare(`
    INSERT INTO coach_usage (scope, day, count) VALUES (?, ?, 1)
    ON CONFLICT(scope, day) DO UPDATE SET count = count + 1
  `).bind(scope, day).run();
  return { ok: true };
}

function withCheapLimits(handler, kind, cap) {
  return async (request, env) => {
    const gate = await enforceCheapLimits(request, env, kind, cap);
    if (!gate.ok) {
      return new Response(JSON.stringify({ error: gate.error }), {
        status: gate.status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    return handler(request, env);
  };
}

// Wrap an existing Claude handler so it short-circuits on cap and adds rate-limit headers on success.
function withClaudeLimits(handler) {
  return async (request, env) => {
    const gate = await enforceClaudeLimits(request, env);
    if (!gate.ok) {
      return new Response(JSON.stringify({ error: gate.error }), {
        status: gate.status,
        headers: { ...CORS, 'Content-Type': 'application/json', ...gate.headers },
      });
    }
    const resp = await handler(request, env);
    const out = new Response(resp.body, resp);
    for (const [k, v] of Object.entries(gate.headers || {})) out.headers.set(k, v);
    return out;
  };
}

// Helper: is requester (or anonymous) allowed to view a row with this visibility owned by ownerId?
async function canViewVisibility(env, requesterId, ownerId, visibility) {
  if (visibility === 'public') return true;
  if (!requesterId) return false;
  if (requesterId === ownerId) return true;
  if (visibility !== 'friends') return false;
  // friends = either side follows the other
  const row = await env.DB.prepare(`
    SELECT 1 FROM follows
    WHERE (follower_id = ? AND followee_id = ?)
       OR (follower_id = ? AND followee_id = ?)
    LIMIT 1
  `).bind(requesterId, ownerId, ownerId, requesterId).first();
  return !!row;
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

// ---------- Profiles + follow graph (Phase 2B) ----------
const USERNAME_RE = /^[A-Za-z0-9_-]{3,24}$/;

function publicProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username || null,
    displayName: row.display_name || null,
    avatarHue: row.avatar_hue ?? null,
  };
}

async function handleMyProfileGet(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  await ensureSchema(env);
  const row = await env.DB.prepare(
    'SELECT id, username, display_name, avatar_hue FROM users WHERE id = ?'
  ).bind(userId).first();
  return json({ profile: publicProfile(row || { id: userId }) });
}

// Strip HTML-significant characters and control bytes from display names.
// Defense in depth: the client also escapes on render, but normalising here
// means a sanitized value lands in D1 once and stays clean for every reader.
function sanitizeDisplayName(s) {
  if (s == null) return null;
  return String(s)
    // drop control chars (incl. NUL, tabs, line breaks beyond regular spaces)
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    // drop angle brackets and ampersands so no markup ever reaches the page
    .replace(/[<>&]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

async function handleMyProfilePut(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const username = body?.username == null ? null : String(body.username).trim().toLowerCase();
  const displayName = sanitizeDisplayName(body?.displayName);
  const avatarHue = body?.avatarHue == null ? null : Math.max(0, Math.min(359, parseInt(body.avatarHue, 10) || 0));
  if (username !== null && !USERNAME_RE.test(username)) {
    return json({ error: 'Username must be 3-24 chars, letters/numbers/_-' }, 400);
  }
  await ensureSchema(env);
  const now = new Date().toISOString();
  // Ensure user row exists, then update profile fields. Unique username collision returns 409.
  await env.DB.prepare(`
    INSERT INTO users (id, created_at, last_seen_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).bind(userId, now, now).run();
  try {
    await env.DB.prepare(`
      UPDATE users SET username = ?, display_name = ?, avatar_hue = ? WHERE id = ?
    `).bind(username, displayName, avatarHue, userId).run();
  } catch (e) {
    const msg = String(e?.message || e);
    if (/UNIQUE/i.test(msg) || /constraint/i.test(msg)) {
      return json({ error: 'Username already taken' }, 409);
    }
    return json({ error: 'Profile update failed: ' + msg }, 500);
  }
  return json({ ok: true });
}

async function handleUserSearch(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (!q || q.length < 2) return json({ users: [] });
  await ensureSchema(env);
  const like = '%' + q.replace(/[%_]/g, '') + '%';
  const rows = await env.DB.prepare(`
    SELECT id, username, display_name, avatar_hue
    FROM users
    WHERE id != ? AND (LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?)
    ORDER BY (CASE WHEN username = ? THEN 0 ELSE 1 END), username
    LIMIT 20
  `).bind(userId, like, like, q).all();
  // Also include follow state so the UI can toggle buttons immediately.
  const followingRows = await env.DB.prepare(
    'SELECT followee_id FROM follows WHERE follower_id = ?'
  ).bind(userId).all();
  const following = new Set((followingRows?.results || []).map(r => r.followee_id));
  return json({
    users: (rows?.results || []).map(r => ({ ...publicProfile(r), youFollow: following.has(r.id) })),
  });
}

async function handleUserPublicProfile(request, env, username) {
  if (!username || !USERNAME_RE.test(username)) return json({ error: 'Bad username' }, 400);
  await ensureSchema(env);
  const row = await env.DB.prepare(
    'SELECT id, username, display_name, avatar_hue FROM users WHERE username = ?'
  ).bind(username).first();
  if (!row) return json({ error: 'Not found' }, 404);
  const reviewsRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM reviews WHERE user_id = ? AND visibility = 'public'`
  ).bind(row.id).first();
  return json({
    profile: publicProfile(row),
    publicReviewCount: reviewsRow?.c || 0,
  });
}

async function handleFollow(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const targetUsername = (body?.username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(targetUsername)) return json({ error: 'Bad username' }, 400);
  await ensureSchema(env);
  const target = await env.DB.prepare(
    'SELECT id FROM users WHERE username = ?'
  ).bind(targetUsername).first();
  if (!target) return json({ error: 'User not found' }, 404);
  if (target.id === userId) return json({ error: 'Cannot follow yourself' }, 400);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO follows (follower_id, followee_id, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(follower_id, followee_id) DO NOTHING
  `).bind(userId, target.id, now).run();
  return json({ ok: true, followee: targetUsername });
}

async function handleUnfollow(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  const url = new URL(request.url);
  const targetUsername = (url.searchParams.get('username') || '').trim().toLowerCase();
  if (!USERNAME_RE.test(targetUsername)) return json({ error: 'Bad username' }, 400);
  await ensureSchema(env);
  const target = await env.DB.prepare(
    'SELECT id FROM users WHERE username = ?'
  ).bind(targetUsername).first();
  if (!target) return json({ ok: true }); // idempotent
  await env.DB.prepare(
    'DELETE FROM follows WHERE follower_id = ? AND followee_id = ?'
  ).bind(userId, target.id).run();
  return json({ ok: true });
}

async function handleMyFollows(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  await ensureSchema(env);
  const following = await env.DB.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_hue
    FROM follows f
    JOIN users u ON u.id = f.followee_id
    WHERE f.follower_id = ?
    ORDER BY f.created_at DESC
  `).bind(userId).all();
  const followers = await env.DB.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_hue
    FROM follows f
    JOIN users u ON u.id = f.follower_id
    WHERE f.followee_id = ?
    ORDER BY f.created_at DESC
  `).bind(userId).all();
  return json({
    following: (following?.results || []).map(publicProfile),
    followers: (followers?.results || []).map(publicProfile),
  });
}

async function handleFeed(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  await ensureSchema(env);
  const rows = await env.DB.prepare(`
    SELECT r.user_id, r.book_id, r.rating, r.text, r.visibility, r.updated_at,
           u.username, u.display_name, u.avatar_hue
    FROM reviews r
    JOIN follows f ON f.followee_id = r.user_id
    JOIN users u ON u.id = r.user_id
    WHERE f.follower_id = ?
      AND r.visibility IN ('public', 'friends')
    ORDER BY r.updated_at DESC
    LIMIT 30
  `).bind(userId).all();
  return json({
    items: (rows?.results || []).map(r => ({
      verb: 'reviewed',
      user: publicProfile(r),
      bookId: r.book_id,
      rating: r.rating,
      text: r.text,
      visibility: r.visibility,
      updatedAt: r.updated_at,
    })),
  });
}

// ---------- book finishes + timing (Phase 3A) ----------
async function handleFinishUpsert(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { bookId, totalMinutes } = body || {};
  if (!bookId || typeof bookId !== 'string' || bookId.length > 128) return json({ error: 'Missing bookId' }, 400);
  const minutes = parseInt(totalMinutes, 10);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1000000) return json({ error: 'Bad totalMinutes' }, 400);
  await ensureSchema(env);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO book_finishes (user_id, book_id, total_minutes, finished_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, book_id) DO UPDATE SET
      total_minutes = excluded.total_minutes,
      finished_at = excluded.finished_at
  `).bind(userId, bookId, minutes, now).run();
  return json({ ok: true, totalMinutes: minutes });
}

async function handleBookTiming(request, env, bookId) {
  if (!bookId) return json({ error: 'Missing bookId' }, 400);
  await ensureSchema(env);
  const row = await env.DB.prepare(
    `SELECT AVG(total_minutes) AS avg_min, COUNT(*) AS cnt
     FROM book_finishes WHERE book_id = ?`
  ).bind(bookId).first();
  const cnt = row?.cnt || 0;
  return json({
    bookId,
    avgMinutes: cnt > 0 ? Math.round(row.avg_min) : null,
    avgHours: cnt > 0 ? Math.round((row.avg_min / 60) * 10) / 10 : null,
    count: cnt,
  });
}

// ---------- Trending (Phase 3D) ----------
async function handleTrending(request, env) {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(20, parseInt(url.searchParams.get('limit'), 10) || 8));
  await ensureSchema(env);
  // Past 30 days of public reviews, ranked by review count then recency.
  const rows = await env.DB.prepare(`
    SELECT book_id,
           COUNT(*) AS activity,
           AVG(rating) AS avg_rating,
           MAX(updated_at) AS most_recent
    FROM reviews
    WHERE visibility = 'public'
      AND updated_at > datetime('now', '-30 days')
      AND rating IS NOT NULL
    GROUP BY book_id
    ORDER BY activity DESC, most_recent DESC
    LIMIT ?
  `).bind(limit).all();
  return json({
    books: (rows?.results || []).map(r => ({
      bookId: r.book_id,
      activity: r.activity,
      avgRating: r.avg_rating != null ? Math.round(r.avg_rating * 10) / 10 : null,
      mostRecent: r.most_recent,
    })),
  });
}

// ---------- Analytics events (first-party) ----------
// Records product events to D1. Designed to be tolerant: accepts requests with
// or without auth, never blocks the client on failure, caps payload size, and
// enforces a small allowlist of event names so the table can't be spammed.
const ALLOWED_EVENT_NAMES = new Set([
  'page_view',
  'app_open',
  'signup',
  'signin',
  'session_started',
  'session_finished',
  'book_added',
  'book_finished',
  'review_written',
  'shelf_created',
  'oauth_attempt',
]);

async function handleEvent(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON' }, 400);  }

  const { name, props, deviceId } = body || {};
  if (typeof name !== 'string' || !ALLOWED_EVENT_NAMES.has(name)) {
    return json({ ok: false, error: 'Unknown event' }, 400);
  }
  const propsStr = props ? JSON.stringify(props).slice(0, 2000) : null;
  const device = (typeof deviceId === 'string' && deviceId.length <= 64) ? deviceId : null;

  // Best-effort user attribution. Don't block on missing/invalid auth.
  let userId = null;
  try {
    const r = await resolveUserId(request, env);
    if (r.verified) userId = r.userId;
  } catch {}

  try {
    await ensureSchema(env);
    await env.DB.prepare(
      'INSERT INTO events (user_id, device_id, name, props, created_at) VALUES (?, ?, ?, ?, datetime("now"))'
    ).bind(userId, device, name, propsStr).run();
  } catch (e) {
    // Log but don't blow up the client.
    console.warn('[events] insert failed:', e.message);
  }
  return json({ ok: true });
}

// Aggregated dashboard JSON. No auth needed — only returns aggregate counts,
// never any user-identifiable rows. Hit /stats from a browser to spot-check.
async function handleStats(request, env) {
  await ensureSchema(env);
  const url = new URL(request.url);
  const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days'), 10) || 30));

  const [dauRow, mauRow, totalRow, byName, signupsByDay] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(DISTINCT COALESCE(user_id, device_id)) AS n
       FROM events WHERE created_at > datetime('now', '-1 day')`
    ).first(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT COALESCE(user_id, device_id)) AS n
       FROM events WHERE created_at > datetime('now', '-30 days')`
    ).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM events`).first(),
    env.DB.prepare(
      `SELECT name, COUNT(*) AS n
       FROM events WHERE created_at > datetime('now', '-' || ? || ' days')
       GROUP BY name ORDER BY n DESC`
    ).bind(days).all(),
    env.DB.prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
       FROM events WHERE name = 'signup' AND created_at > datetime('now', '-' || ? || ' days')
       GROUP BY day ORDER BY day`
    ).bind(days).all(),
  ]);

  return json({
    windowDays: days,
    totalEvents: totalRow?.n || 0,
    dau: dauRow?.n || 0,
    mau: mauRow?.n || 0,
    eventsByName: (byName?.results || []),
    signupsByDay: (signupsByDay?.results || []),
  });
}

// ---------- Custom shelves (Phase 3E) ----------
const SHELF_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

async function handleShelfUpsert(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { id, name, books, visibility } = body || {};
  if (!id || !SHELF_ID_RE.test(id)) return json({ error: 'Bad shelf id' }, 400);
  if (!name || typeof name !== 'string') return json({ error: 'Missing name' }, 400);
  const cleanName = String(name).slice(0, 80);
  const arr = Array.isArray(books) ? books.filter(b => typeof b === 'string').slice(0, 500) : [];
  const v = VISIBILITY.has(visibility) ? visibility : 'public';
  if (v === 'private') return json({ error: 'Private shelves stay local; do not upload.' }, 400);

  await ensureSchema(env);
  const now = new Date().toISOString();
  // Permission check: owner OR member with editor role can upsert.
  const existing = await env.DB.prepare('SELECT owner_id, created_at FROM custom_shelves WHERE id = ?').bind(id).first();
  if (existing && existing.owner_id !== userId) {
    const member = await env.DB.prepare(
      `SELECT role FROM shelf_members WHERE shelf_id = ? AND user_id = ?`
    ).bind(id, userId).first();
    if (!member || member.role !== 'editor') return json({ error: 'Not allowed to edit this shelf' }, 403);
    // Editor edit: keep the original owner_id, only update mutable fields.
    await env.DB.prepare(`
      UPDATE custom_shelves SET name = ?, books = ?, visibility = ?, updated_at = ? WHERE id = ?
    `).bind(cleanName, JSON.stringify(arr), v, now, id).run();
    return json({ ok: true, id, visibility: v, updatedAt: now, role: 'editor' });
  }
  const createdAt = existing?.created_at || now;
  await env.DB.prepare(`
    INSERT INTO custom_shelves (id, owner_id, name, books, visibility, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      books = excluded.books,
      visibility = excluded.visibility,
      updated_at = excluded.updated_at
  `).bind(id, userId, cleanName, JSON.stringify(arr), v, createdAt, now).run();
  return json({ ok: true, id, visibility: v, updatedAt: now, role: 'owner' });
}

async function handleShelfDelete(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id || !SHELF_ID_RE.test(id)) return json({ error: 'Bad shelf id' }, 400);
  await ensureSchema(env);
  await env.DB.prepare('DELETE FROM custom_shelves WHERE id = ? AND owner_id = ?').bind(id, userId).run();
  await env.DB.prepare('DELETE FROM shelf_members WHERE shelf_id = ?').bind(id).run();
  return json({ ok: true });
}

// ---------- Collaborative shelf members (Phase V3) ----------
async function handleShelfMemberAdd(request, env, shelfId) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  if (!SHELF_ID_RE.test(shelfId)) return json({ error: 'Bad shelf id' }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const username = String(body?.username || '').toLowerCase();
  if (!USERNAME_RE.test(username)) return json({ error: 'Bad username' }, 400);
  await ensureSchema(env);
  const shelf = await env.DB.prepare('SELECT owner_id FROM custom_shelves WHERE id = ?').bind(shelfId).first();
  if (!shelf) return json({ error: 'Shelf not found' }, 404);
  if (shelf.owner_id !== userId) return json({ error: 'Only the owner can add editors' }, 403);
  const target = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (!target) return json({ error: 'User not found' }, 404);
  if (target.id === userId) return json({ error: 'You already own this shelf' }, 400);
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`
      INSERT INTO shelf_members (shelf_id, user_id, role, added_at)
      VALUES (?, ?, 'editor', ?)
    `).bind(shelfId, target.id, now).run();
  } catch {
    return json({ error: 'Already an editor' }, 409);
  }
  return json({ ok: true });
}

async function handleShelfMemberRemove(request, env, shelfId) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  if (!SHELF_ID_RE.test(shelfId)) return json({ error: 'Bad shelf id' }, 400);
  const url = new URL(request.url);
  const username = String(url.searchParams.get('username') || '').toLowerCase();
  if (!USERNAME_RE.test(username)) return json({ error: 'Bad username' }, 400);
  await ensureSchema(env);
  const shelf = await env.DB.prepare('SELECT owner_id FROM custom_shelves WHERE id = ?').bind(shelfId).first();
  if (!shelf) return json({ error: 'Shelf not found' }, 404);
  // Allow either: owner kicks anyone, or editor self-removes.
  const target = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (!target) return json({ error: 'User not found' }, 404);
  if (shelf.owner_id !== userId && target.id !== userId) return json({ error: 'Not allowed' }, 403);
  await env.DB.prepare('DELETE FROM shelf_members WHERE shelf_id = ? AND user_id = ?').bind(shelfId, target.id).run();
  return json({ ok: true });
}

async function handleShelfMembers(request, env, shelfId) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  if (!SHELF_ID_RE.test(shelfId)) return json({ error: 'Bad shelf id' }, 400);
  await ensureSchema(env);
  const shelf = await env.DB.prepare(
    `SELECT cs.owner_id, u.username, u.display_name, u.avatar_hue
     FROM custom_shelves cs
     LEFT JOIN users u ON u.id = cs.owner_id
     WHERE cs.id = ?`
  ).bind(shelfId).first();
  if (!shelf) return json({ error: 'Shelf not found' }, 404);
  // Caller must be owner or editor.
  if (shelf.owner_id !== userId) {
    const m = await env.DB.prepare(
      'SELECT role FROM shelf_members WHERE shelf_id = ? AND user_id = ?'
    ).bind(shelfId, userId).first();
    if (!m) return json({ error: 'Not allowed' }, 403);
  }
  const editors = await env.DB.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_hue, m.added_at
    FROM shelf_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.shelf_id = ?
    ORDER BY m.added_at
  `).bind(shelfId).all();
  return json({
    owner: publicProfile({ id: shelf.owner_id, username: shelf.username, display_name: shelf.display_name, avatar_hue: shelf.avatar_hue }),
    editors: (editors?.results || []).map(publicProfile),
  });
}

async function handleMyShelves(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  await ensureSchema(env);
  // Owned + ones I'm an editor on.
  const rows = await env.DB.prepare(`
    SELECT cs.id, cs.owner_id, cs.name, cs.books, cs.visibility, cs.updated_at,
           u.username AS owner_username, u.display_name AS owner_display, u.avatar_hue AS owner_hue,
           CASE WHEN cs.owner_id = ? THEN 'owner' ELSE 'editor' END AS my_role
    FROM custom_shelves cs
    LEFT JOIN users u ON u.id = cs.owner_id
    WHERE cs.owner_id = ?
       OR cs.id IN (SELECT shelf_id FROM shelf_members WHERE user_id = ?)
    ORDER BY cs.updated_at DESC
  `).bind(userId, userId, userId).all();
  return json({
    shelves: (rows?.results || []).map(r => {
      let books = [];
      try { books = JSON.parse(r.books); } catch {}
      return {
        id: r.id,
        name: r.name,
        books,
        visibility: r.visibility,
        updatedAt: r.updated_at,
        myRole: r.my_role,
        owner: { id: r.owner_id, username: r.owner_username, displayName: r.owner_display, avatarHue: r.owner_hue },
      };
    }),
  });
}

async function handleUserShelves(request, env, username) {
  if (!username || !USERNAME_RE.test(username)) return json({ error: 'Bad username' }, 400);
  const { userId: requesterId } = await resolveUserId(request, env);
  await ensureSchema(env);
  const owner = await env.DB.prepare(
    'SELECT id, username, display_name, avatar_hue FROM users WHERE username = ?'
  ).bind(username).first();
  if (!owner) return json({ error: 'Not found' }, 404);
  const rows = await env.DB.prepare(`
    SELECT id, name, books, visibility, updated_at FROM custom_shelves
    WHERE owner_id = ? ORDER BY updated_at DESC
  `).bind(owner.id).all();
  const shelves = [];
  for (const r of (rows?.results || [])) {
    if (await canViewVisibility(env, requesterId, owner.id, r.visibility)) {
      let books = [];
      try { books = JSON.parse(r.books); } catch {}
      shelves.push({
        id: r.id, name: r.name, books, visibility: r.visibility, updatedAt: r.updated_at,
      });
    }
  }
  return json({
    profile: publicProfile(owner),
    shelves,
  });
}

async function handleUserReviews(request, env, username) {
  if (!username || !USERNAME_RE.test(username)) return json({ error: 'Bad username' }, 400);
  const { userId: requesterId } = await resolveUserId(request, env);
  await ensureSchema(env);
  const owner = await env.DB.prepare(
    'SELECT id, username, display_name, avatar_hue FROM users WHERE username = ?'
  ).bind(username).first();
  if (!owner) return json({ error: 'Not found' }, 404);
  const rows = await env.DB.prepare(`
    SELECT book_id, rating, text, visibility, updated_at
    FROM reviews
    WHERE user_id = ?
    ORDER BY updated_at DESC
    LIMIT 100
  `).bind(owner.id).all();
  const reviews = [];
  for (const r of (rows?.results || [])) {
    if (await canViewVisibility(env, requesterId, owner.id, r.visibility)) {
      reviews.push({
        bookId: r.book_id, rating: r.rating, text: r.text,
        visibility: r.visibility, updatedAt: r.updated_at,
      });
    }
  }
  return json({ profile: publicProfile(owner), reviews });
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

// ---------- Coach: Claude-generated insights (Phase V3) ----------
async function callClaudeText(env, system, user) {
  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
  } catch (e) { throw new Error('Claude unreachable: ' + e.message); }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => 'unknown');
    throw new Error('Claude ' + resp.status + ': ' + detail.slice(0, 300));
  }
  const data = await resp.json();
  return (data.content?.[0]?.text || '').trim();
}

const PERSONA_SYSTEM = `You are the Reader Persona writer for Chaptr, a reading-habit app.
Generate ONE short paragraph (2-3 sentences) describing this reader's profile based
on their data. Be specific and warm, never generic. Reference at least two stats
explicitly (e.g. WPM, top genre, peak time, mood, session length, completion rate).
End with a single recommendation about what to read next or when to read.
Return only the paragraph — no headings, no JSON, no markdown.`;

async function handleCoachPersona(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Anthropic key not configured' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const dna = body?.dna || {};
  const userMsg = `Reader DNA:
- Average WPM: ${dna.wpm ?? 'unknown'}
- Average session length: ${dna.avgSession ?? 'unknown'} minutes
- Total sessions: ${dna.sessionCount ?? 'unknown'}
- Top genre: ${dna.topGenre ?? 'unknown'}
- Recent dominant mood: ${dna.mood ?? 'unknown'}
- Books touched (last 30d): ${dna.recentBooks ?? 'unknown'}
- Day streak: ${dna.streak ?? 'unknown'}
- Books finished this year: ${dna.booksFinishedYear ?? 'unknown'}
- Pace by genre (WPM): ${dna.paceByGenre ? JSON.stringify(dna.paceByGenre) : 'unknown'}

Write the persona paragraph.`;
  try {
    const text = await callClaudeText(env, PERSONA_SYSTEM, userMsg);
    return json({ text });
  } catch (e) { return json({ error: e.message }, 502); }
}

const STALL_SYSTEM = `You are a reading coach for Chaptr. The user stalled on a book
they were enjoying and wants help getting back in. Output exactly two short paragraphs:

1. RECAP: 2-3 sentences setting the scene at their stall point — major characters,
   the central tension, the recent emotional beat. Keep it spoiler-aware (only
   spoil up to their last page). If you don't know the book well, give a more
   abstract "where you likely left off" recap.

2. RE-ENTRY: 2 sentences with a specific tactic to re-engage — a chapter to
   re-read, a question to hold in mind, or a bite-sized goal for tonight.

Plain prose only — no headings, no labels like "RECAP:" or "RE-ENTRY:", no markdown.
Two paragraphs separated by a blank line.`;

async function handleCoachStallRecovery(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Anthropic key not configured' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { title, author, currentPage, totalPages, daysAway } = body || {};
  if (!title || !author) return json({ error: 'Missing title or author' }, 400);
  const userMsg = `Book: "${title}" by ${author}
Total pages: ${totalPages || 'unknown'}
Reader stalled at page: ${currentPage || 'unknown'}
Days since last session: ${daysAway || 'unknown'}

Write the recap + re-entry response.`;
  try {
    const text = await callClaudeText(env, STALL_SYSTEM, userMsg);
    return json({ text });
  } catch (e) { return json({ error: e.message }, 502); }
}

// ---------- "What just happened?" chapter recap (Phase V4) ----------
const CHAPTER_RECAP_SYSTEM = `You are Chaptr's mid-book reading coach. The reader is
returning to a book and wants a quick refresher on what likely happened in the
chapters they recently read. Output exactly 2 sentences:

1. Frame the situation as of their current page (no spoilers past it).
2. Suggest the emotional or plot beat to hold in mind as they read on.

Plain prose, no headings, no bullet points. Spoiler-aware: never reference
events past the page they're at. If the book is one you don't know well, give
a more abstract "where you likely are" framing.`;

async function handleCoachChapterRecap(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Anthropic key not configured' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { title, author, currentPage, totalPages } = body || {};
  if (!title || !author) return json({ error: 'Missing book metadata' }, 400);
  const userMsg = `Book: "${title}" by ${author}
Total pages: ${totalPages || 'unknown'}
Reader is at page: ${currentPage || 'unknown'}

Write the recap.`;
  try {
    const text = await callClaudeText(env, CHAPTER_RECAP_SYSTEM, userMsg);
    return json({ text });
  } catch (e) { return json({ error: e.message }, 502); }
}

// ---------- "How this fits you" book blurbs (Phase V3) ----------
const BOOK_FIT_SYSTEM = `You are Chaptr's book-recommendation explainer.
The user is looking at one specific book card. Write ONE plain sentence (15-30 words)
that explains why this book fits THIS reader, referencing at least one of their stats
explicitly (WPM, top genre, session length, recent mood, completion rate). No fluff,
no marketing speak. Be specific and a little surprising. Plain text only.`;

async function handleCoachBookFit(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Anthropic key not configured' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { title, author, genre, pages, dna } = body || {};
  if (!title || !author) return json({ error: 'Missing book metadata' }, 400);
  const userMsg = `Book: "${title}" by ${author}
Genre: ${genre || 'unknown'}
Pages: ${pages || 'unknown'}

Reader DNA:
- WPM: ${dna?.wpm ?? 'unknown'}
- Avg session: ${dna?.avgSession ?? 'unknown'} min
- Top genre: ${dna?.topGenre ?? 'unknown'}
- Recent mood: ${dna?.mood ?? 'unknown'}
- Hours-to-finish at their pace: ${pages && dna?.wpm ? Math.round((pages * 275) / dna.wpm / 60 * 10) / 10 : 'unknown'}

Write the one-sentence fit.`;
  try {
    const text = await callClaudeText(env, BOOK_FIT_SYSTEM, userMsg);
    return json({ text });
  } catch (e) { return json({ error: e.message }, 502); }
}

// ---------- Friend challenges (Phase V3) ----------
const FC_TYPES = new Set(['books', 'hours']);
const FC_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

async function handleFriendChallengeCreate(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { name, type, target, deadline, invitees } = body || {};
  if (!name || typeof name !== 'string') return json({ error: 'Missing name' }, 400);
  if (!FC_TYPES.has(type)) return json({ error: 'type must be books or hours' }, 400);
  const t = parseInt(target, 10);
  if (!Number.isFinite(t) || t < 1 || t > 100000) return json({ error: 'Bad target' }, 400);
  const inviteeList = Array.isArray(invitees) ? invitees.filter(u => typeof u === 'string') : [];

  await ensureSchema(env);
  const id = genId('fc');
  const now = new Date().toISOString();
  const cleanDeadline = deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : null;
  await env.DB.prepare(`
    INSERT INTO friend_challenges (id, owner_id, name, type, target, deadline, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, userId, name.slice(0, 80), type, t, cleanDeadline, now).run();
  // Owner auto-joins.
  await env.DB.prepare(`
    INSERT INTO friend_challenge_members (challenge_id, user_id, status, joined_at)
    VALUES (?, ?, 'joined', ?)
  `).bind(id, userId, now).run();
  // Resolve invitees by username and insert as 'invited'.
  for (const username of inviteeList.slice(0, 20)) {
    const u = String(username).toLowerCase();
    if (!USERNAME_RE.test(u)) continue;
    const target = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(u).first();
    if (!target || target.id === userId) continue;
    try {
      await env.DB.prepare(`
        INSERT INTO friend_challenge_members (challenge_id, user_id, status, joined_at)
        VALUES (?, ?, 'invited', ?)
      `).bind(id, target.id, now).run();
    } catch {} // ignore duplicate
  }
  return json({ ok: true, id });
}

async function handleFriendChallengeList(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  await ensureSchema(env);
  const rows = await env.DB.prepare(`
    SELECT fc.id, fc.owner_id, fc.name, fc.type, fc.target, fc.deadline, fc.created_at,
           m.status AS my_status,
           u.username AS owner_username, u.display_name AS owner_display
    FROM friend_challenges fc
    JOIN friend_challenge_members m ON m.challenge_id = fc.id AND m.user_id = ?
    LEFT JOIN users u ON u.id = fc.owner_id
    ORDER BY fc.created_at DESC
  `).bind(userId).all();
  const items = (rows?.results || []).map(r => ({
    id: r.id,
    name: r.name,
    type: r.type,
    target: r.target,
    deadline: r.deadline,
    createdAt: r.created_at,
    myStatus: r.my_status,
    youAreOwner: r.owner_id === userId,
    owner: { username: r.owner_username, displayName: r.owner_display },
  }));
  return json({ items });
}

async function _verifyChallengeMember(env, userId, challengeId) {
  const row = await env.DB.prepare(`
    SELECT fc.id, fc.owner_id, fc.name, fc.type, fc.target, fc.deadline, fc.created_at, m.status AS my_status
    FROM friend_challenges fc
    JOIN friend_challenge_members m ON m.challenge_id = fc.id AND m.user_id = ?
    WHERE fc.id = ?
  `).bind(userId, challengeId).first();
  if (!row) return { err: json({ error: 'Not a member' }, 403) };
  return { row };
}

async function handleFriendChallengeStatus(request, env, challengeId, newStatus) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  if (!FC_ID_RE.test(challengeId)) return json({ error: 'Bad id' }, 400);
  await ensureSchema(env);
  // Only invitees can join/decline. Owner can leave (effectively delete).
  const m = await env.DB.prepare(
    'SELECT status FROM friend_challenge_members WHERE challenge_id = ? AND user_id = ?'
  ).bind(challengeId, userId).first();
  if (!m) return json({ error: 'Not invited' }, 404);
  await env.DB.prepare(
    'UPDATE friend_challenge_members SET status = ? WHERE challenge_id = ? AND user_id = ?'
  ).bind(newStatus, challengeId, userId).run();
  return json({ ok: true, status: newStatus });
}

async function handleFriendChallengeGet(request, env, challengeId) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  if (!FC_ID_RE.test(challengeId)) return json({ error: 'Bad id' }, 400);
  await ensureSchema(env);
  const { row, err } = await _verifyChallengeMember(env, userId, challengeId);
  if (err) return err;

  // Fetch all members + their public profiles
  const memberRows = await env.DB.prepare(`
    SELECT m.user_id, m.status, m.joined_at,
           u.username, u.display_name, u.avatar_hue
    FROM friend_challenge_members m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.challenge_id = ?
  `).bind(challengeId).all();
  const members = memberRows?.results || [];

  // Compute progress for each member (only ones that actually joined).
  const joinedIds = members.filter(m => m.status === 'joined').map(m => m.user_id);
  const progressMap = {};
  if (joinedIds.length) {
    const placeholders = joinedIds.map(() => '?').join(',');
    if (row.type === 'books') {
      const stmt = await env.DB.prepare(`
        SELECT user_id, COUNT(*) AS cnt
        FROM book_finishes
        WHERE finished_at >= ? AND user_id IN (${placeholders})
        GROUP BY user_id
      `).bind(row.created_at, ...joinedIds).all();
      for (const r of (stmt?.results || [])) progressMap[r.user_id] = { current: r.cnt, target: row.target };
    } else {
      const stmt = await env.DB.prepare(`
        SELECT user_id, SUM(total_minutes) AS mins
        FROM book_finishes
        WHERE finished_at >= ? AND user_id IN (${placeholders})
        GROUP BY user_id
      `).bind(row.created_at, ...joinedIds).all();
      for (const r of (stmt?.results || [])) {
        const hours = Math.round((r.mins || 0) / 60 * 10) / 10;
        progressMap[r.user_id] = { current: hours, target: row.target };
      }
    }
  }

  return json({
    challenge: {
      id: row.id, name: row.name, type: row.type, target: row.target,
      deadline: row.deadline, createdAt: row.created_at,
      youAreOwner: row.owner_id === userId,
    },
    members: members.map(m => ({
      profile: publicProfile({ id: m.user_id, username: m.username, display_name: m.display_name, avatar_hue: m.avatar_hue }),
      status: m.status,
      progress: progressMap[m.user_id] || { current: 0, target: row.target },
    })).sort((a, b) => (b.progress.current || 0) - (a.progress.current || 0)),
  });
}

async function handleFriendChallengeInvite(request, env, challengeId) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  if (!FC_ID_RE.test(challengeId)) return json({ error: 'Bad id' }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const username = String(body?.username || '').toLowerCase();
  if (!USERNAME_RE.test(username)) return json({ error: 'Bad username' }, 400);
  await ensureSchema(env);
  // Only the owner can invite more
  const fc = await env.DB.prepare('SELECT owner_id FROM friend_challenges WHERE id = ?').bind(challengeId).first();
  if (!fc) return json({ error: 'Not found' }, 404);
  if (fc.owner_id !== userId) return json({ error: 'Only the owner can invite' }, 403);
  const target = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (!target) return json({ error: 'User not found' }, 404);
  if (target.id === userId) return json({ error: 'Already in your own challenge' }, 400);
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`
      INSERT INTO friend_challenge_members (challenge_id, user_id, status, joined_at)
      VALUES (?, ?, 'invited', ?)
    `).bind(challengeId, target.id, now).run();
  } catch {
    return json({ error: 'Already invited or member' }, 409);
  }
  return json({ ok: true });
}

// ---------- Reading buddies (Phase 4) ----------
const PAIR_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function handlePairInvite(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { username, bookId } = body || {};
  if (!username || !USERNAME_RE.test(String(username).toLowerCase())) return json({ error: 'Bad username' }, 400);
  if (!bookId || typeof bookId !== 'string' || bookId.length > 128) return json({ error: 'Missing bookId' }, 400);
  await ensureSchema(env);
  const target = await env.DB.prepare(
    'SELECT id FROM users WHERE username = ?'
  ).bind(String(username).toLowerCase()).first();
  if (!target) return json({ error: 'User not found' }, 404);
  if (target.id === userId) return json({ error: 'Cannot pair-read with yourself' }, 400);

  // Don't allow duplicate pending/active rows for the same pair+book in either direction.
  const dup = await env.DB.prepare(`
    SELECT id, status FROM pair_reads
    WHERE book_id = ?
      AND status IN ('pending', 'active')
      AND ((inviter_id = ? AND invitee_id = ?) OR (inviter_id = ? AND invitee_id = ?))
    LIMIT 1
  `).bind(bookId, userId, target.id, target.id, userId).first();
  if (dup) return json({ error: 'Already paired on this book', existingId: dup.id, status: dup.status }, 409);

  const id = genId('pr');
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO pair_reads (id, book_id, inviter_id, invitee_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).bind(id, bookId, userId, target.id, now, now).run();
  return json({ ok: true, id });
}

async function handlePairList(request, env) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  await ensureSchema(env);
  const rows = await env.DB.prepare(`
    SELECT pr.id, pr.book_id, pr.inviter_id, pr.invitee_id, pr.status, pr.created_at, pr.updated_at,
           inv.username AS inv_username, inv.display_name AS inv_display, inv.avatar_hue AS inv_hue,
           tee.username AS tee_username, tee.display_name AS tee_display, tee.avatar_hue AS tee_hue
    FROM pair_reads pr
    JOIN users inv ON inv.id = pr.inviter_id
    JOIN users tee ON tee.id = pr.invitee_id
    WHERE pr.inviter_id = ? OR pr.invitee_id = ?
    ORDER BY pr.updated_at DESC
  `).bind(userId, userId).all();
  const items = (rows?.results || []).map(r => {
    const youAreInviter = r.inviter_id === userId;
    const partner = youAreInviter
      ? { id: r.invitee_id, username: r.tee_username, displayName: r.tee_display, avatarHue: r.tee_hue }
      : { id: r.inviter_id, username: r.inv_username, displayName: r.inv_display, avatarHue: r.inv_hue };
    return {
      id: r.id,
      bookId: r.book_id,
      status: r.status,
      youAreInviter,
      partner,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
  return json({ items });
}

async function _verifyParticipant(env, userId, pairId) {
  const row = await env.DB.prepare(
    'SELECT id, inviter_id, invitee_id, status, book_id FROM pair_reads WHERE id = ?'
  ).bind(pairId).first();
  if (!row) return { err: json({ error: 'Pair read not found' }, 404) };
  if (row.inviter_id !== userId && row.invitee_id !== userId) return { err: json({ error: 'Not a participant' }, 403) };
  return { row };
}

async function handlePairTransition(request, env, pairId, newStatus, requireInvitee) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  if (!PAIR_ID_RE.test(pairId)) return json({ error: 'Bad pair id' }, 400);
  await ensureSchema(env);
  const { row, err } = await _verifyParticipant(env, userId, pairId);
  if (err) return err;
  if (requireInvitee && row.invitee_id !== userId) return json({ error: 'Only the invitee can do that' }, 403);
  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE pair_reads SET status = ?, updated_at = ? WHERE id = ?').bind(newStatus, now, pairId).run();
  return json({ ok: true, status: newStatus });
}

async function handlePairGet(request, env, pairId) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  if (!PAIR_ID_RE.test(pairId)) return json({ error: 'Bad pair id' }, 400);
  await ensureSchema(env);
  const { row, err } = await _verifyParticipant(env, userId, pairId);
  if (err) return err;
  const msgs = await env.DB.prepare(`
    SELECT id, sender_id, text, created_at
    FROM pair_read_messages
    WHERE pair_read_id = ?
    ORDER BY created_at ASC
    LIMIT 500
  `).bind(pairId).all();
  return json({
    pairRead: {
      id: row.id, bookId: row.book_id, status: row.status,
      inviterId: row.inviter_id, inviteeId: row.invitee_id,
    },
    messages: (msgs?.results || []).map(m => ({
      id: m.id, senderId: m.sender_id, text: m.text, createdAt: m.created_at,
      mine: m.sender_id === userId,
    })),
  });
}

async function handlePairSendMessage(request, env, pairId) {
  const { userId, error } = await resolveUserId(request, env);
  if (!userId) return json({ error: error || 'Unauthorized' }, 401);
  if (!PAIR_ID_RE.test(pairId)) return json({ error: 'Bad pair id' }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const text = String(body?.text || '').trim().slice(0, 2000);
  if (!text) return json({ error: 'Empty message' }, 400);
  await ensureSchema(env);
  const { row, err } = await _verifyParticipant(env, userId, pairId);
  if (err) return err;
  if (row.status !== 'active') return json({ error: 'Pair read is not active' }, 400);
  const id = genId('m');
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO pair_read_messages (id, pair_read_id, sender_id, text, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, pairId, userId, text, now).run();
  await env.DB.prepare('UPDATE pair_reads SET updated_at = ? WHERE id = ?').bind(now, pairId).run();
  return json({ ok: true, id, createdAt: now });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, ''); // strip trailing slash

    // Backward-compatible recommend endpoint at root (rate-limited).
    if ((path === '' || path === '/') && request.method === 'POST') {
      return withClaudeLimits(handleRecommend)(request, env);
    }
    if (path === '/me' && request.method === 'POST') return withCheapLimits(handleMe, 'me', 200)(request, env);
    if (path === '/load' && request.method === 'GET') return handleLoad(request, env);
    if (path === '/sync' && request.method === 'POST') return handleSync(request, env);

    // Reviews (Phase 2A)
    if (path === '/reviews' && request.method === 'POST') return handleReviewUpsert(request, env);
    if (path === '/reviews' && request.method === 'DELETE') return handleReviewDelete(request, env);
    if (path === '/reviews/mine' && request.method === 'GET') return handleReviewsMine(request, env);
    if (path === '/reviews/public' && request.method === 'GET') return handleReviewsPublic(request, env);
    // /books/<id>/stats and /books/<id>/timing
    const bookStatsMatch = path.match(/^\/books\/([^/]+)\/stats$/);
    if (bookStatsMatch && request.method === 'GET') return handleBookStats(request, env, decodeURIComponent(bookStatsMatch[1]));
    const bookTimingMatch = path.match(/^\/books\/([^/]+)\/timing$/);
    if (bookTimingMatch && request.method === 'GET') return handleBookTiming(request, env, decodeURIComponent(bookTimingMatch[1]));
    if (path === '/book-finishes' && request.method === 'POST') return handleFinishUpsert(request, env);
    if (path === '/trending' && request.method === 'GET') return handleTrending(request, env);

    // First-party analytics (Tier 1 — instrumented in app.js)
    if (path === '/event' && request.method === 'POST') return withCheapLimits(handleEvent, 'ev', 5000)(request, env);
    if (path === '/stats' && request.method === 'GET') return handleStats(request, env);

    // Profiles + follow graph (Phase 2B)
    if (path === '/me/profile' && request.method === 'GET') return handleMyProfileGet(request, env);
    if (path === '/me/profile' && request.method === 'PUT') return handleMyProfilePut(request, env);
    if (path === '/me/follows' && request.method === 'GET') return handleMyFollows(request, env);
    if (path === '/users/search' && request.method === 'GET') return handleUserSearch(request, env);
    if (path === '/follow' && request.method === 'POST') return handleFollow(request, env);
    if (path === '/follow' && request.method === 'DELETE') return handleUnfollow(request, env);
    if (path === '/feed' && request.method === 'GET') return handleFeed(request, env);
    const userProfileMatch = path.match(/^\/users\/([^/]+)$/);
    if (userProfileMatch && request.method === 'GET') return handleUserPublicProfile(request, env, decodeURIComponent(userProfileMatch[1]).toLowerCase());
    const userShelvesMatch = path.match(/^\/users\/([^/]+)\/shelves$/);
    if (userShelvesMatch && request.method === 'GET') return handleUserShelves(request, env, decodeURIComponent(userShelvesMatch[1]).toLowerCase());
    const userReviewsMatch = path.match(/^\/users\/([^/]+)\/reviews$/);
    if (userReviewsMatch && request.method === 'GET') return handleUserReviews(request, env, decodeURIComponent(userReviewsMatch[1]).toLowerCase());

    // Shelves (Phase 3E)
    if (path === '/shelves' && request.method === 'POST') return handleShelfUpsert(request, env);
    if (path === '/shelves' && request.method === 'DELETE') return handleShelfDelete(request, env);
    // Collaborative shelves (Phase V3)
    if (path === '/me/shelves' && request.method === 'GET') return handleMyShelves(request, env);
    const sMembersGet = path.match(/^\/shelves\/([^/]+)\/members$/);
    if (sMembersGet && request.method === 'GET') return handleShelfMembers(request, env, sMembersGet[1]);
    const sMemberAdd = path.match(/^\/shelves\/([^/]+)\/members$/);
    if (sMemberAdd && request.method === 'POST') return handleShelfMemberAdd(request, env, sMemberAdd[1]);
    const sMemberDel = path.match(/^\/shelves\/([^/]+)\/members$/);
    if (sMemberDel && request.method === 'DELETE') return handleShelfMemberRemove(request, env, sMemberDel[1]);

    // Coach (Phase V3 + V4) — all rate-limited so a hot loop can't drain your wallet.
    if (path === '/coach/persona' && request.method === 'POST') return withClaudeLimits(handleCoachPersona)(request, env);
    if (path === '/coach/stall-recovery' && request.method === 'POST') return withClaudeLimits(handleCoachStallRecovery)(request, env);
    if (path === '/coach/book-fit' && request.method === 'POST') return withClaudeLimits(handleCoachBookFit)(request, env);
    if (path === '/coach/chapter-recap' && request.method === 'POST') return withClaudeLimits(handleCoachChapterRecap)(request, env);

    // Friend challenges (Phase V3)
    if (path === '/friend-challenges' && request.method === 'POST') return handleFriendChallengeCreate(request, env);
    if (path === '/friend-challenges' && request.method === 'GET') return handleFriendChallengeList(request, env);
    const fcGetMatch = path.match(/^\/friend-challenges\/([^/]+)$/);
    if (fcGetMatch && request.method === 'GET') return handleFriendChallengeGet(request, env, fcGetMatch[1]);
    const fcJoinMatch = path.match(/^\/friend-challenges\/([^/]+)\/join$/);
    if (fcJoinMatch && request.method === 'POST') return handleFriendChallengeStatus(request, env, fcJoinMatch[1], 'joined');
    const fcDeclineMatch = path.match(/^\/friend-challenges\/([^/]+)\/decline$/);
    if (fcDeclineMatch && request.method === 'POST') return handleFriendChallengeStatus(request, env, fcDeclineMatch[1], 'declined');
    const fcInviteMatch = path.match(/^\/friend-challenges\/([^/]+)\/invite$/);
    if (fcInviteMatch && request.method === 'POST') return handleFriendChallengeInvite(request, env, fcInviteMatch[1]);

    // Reading buddies (Phase 4)
    if (path === '/pair-reads' && request.method === 'POST') return handlePairInvite(request, env);
    if (path === '/pair-reads' && request.method === 'GET') return handlePairList(request, env);
    const prGetMatch = path.match(/^\/pair-reads\/([^/]+)$/);
    if (prGetMatch && request.method === 'GET') return handlePairGet(request, env, prGetMatch[1]);
    const prAcceptMatch = path.match(/^\/pair-reads\/([^/]+)\/accept$/);
    if (prAcceptMatch && request.method === 'POST') return handlePairTransition(request, env, prAcceptMatch[1], 'active', true);
    const prDeclineMatch = path.match(/^\/pair-reads\/([^/]+)\/decline$/);
    if (prDeclineMatch && request.method === 'POST') return handlePairTransition(request, env, prDeclineMatch[1], 'declined', true);
    const prEndMatch = path.match(/^\/pair-reads\/([^/]+)\/end$/);
    if (prEndMatch && request.method === 'POST') return handlePairTransition(request, env, prEndMatch[1], 'ended', false);
    const prMsgMatch = path.match(/^\/pair-reads\/([^/]+)\/messages$/);
    if (prMsgMatch && request.method === 'POST') return handlePairSendMessage(request, env, prMsgMatch[1]);

    if (path === '/health') {
      return json({
        ok: true,
        hasDb: !!env.DB,
        hasClerk: !!env.CLERK_FRONTEND_API,
        clerkInstance: env.CLERK_FRONTEND_API || null,
      });
    }

    // Today's Claude usage (your IP + global). Useful for spot-checking from the browser.
    if (path === '/coach/usage' && request.method === 'GET') {
      await ensureSchema(env);
      const day = new Date().toISOString().slice(0, 10);
      const g = await env.DB.prepare('SELECT count FROM coach_usage WHERE scope = ? AND day = ?').bind('global', day).first();
      const scope = rateLimitScope(request);
      const u = await env.DB.prepare('SELECT count FROM coach_usage WHERE scope = ? AND day = ?').bind(scope, day).first();
      return json({
        day,
        global: { used: g?.count || 0, cap: parseInt(env.GLOBAL_DAILY_CAP, 10) || 1000 },
        yours:  { used: u?.count || 0, cap: parseInt(env.USER_DAILY_CAP, 10) || 50, scope },
      });
    }

    return json({ error: 'Not found', path, method: request.method }, 404);
  },
};
