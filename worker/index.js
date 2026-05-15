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
}

async function handleMe(request, env, userId) {
  if (!isValidUserId(userId)) return json({ error: 'Invalid or missing user id' }, 400);
  await ensureSchema(env);
  const now = new Date().toISOString();
  const existing = await env.DB.prepare('SELECT id, created_at FROM users WHERE id = ?').bind(userId).first();
  if (existing) {
    await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, userId).run();
    return json({ id: userId, createdAt: existing.created_at, lastSeenAt: now, isNew: false });
  }
  await env.DB.prepare('INSERT INTO users (id, created_at, last_seen_at) VALUES (?, ?, ?)').bind(userId, now, now).run();
  return json({ id: userId, createdAt: now, lastSeenAt: now, isNew: true });
}

async function handleLoad(request, env, userId) {
  if (!isValidUserId(userId)) return json({ error: 'Invalid or missing user id' }, 400);
  await ensureSchema(env);
  const row = await env.DB.prepare('SELECT data, version, updated_at FROM snapshots WHERE user_id = ?').bind(userId).first();
  if (!row) return json({ snapshot: null, version: 0, updatedAt: null });
  let snapshot;
  try { snapshot = JSON.parse(row.data); } catch { snapshot = null; }
  return json({ snapshot, version: row.version, updatedAt: row.updated_at });
}

async function handleSync(request, env, userId) {
  if (!isValidUserId(userId)) return json({ error: 'Invalid or missing user id' }, 400);
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, ''); // strip trailing slash
    const userId = request.headers.get('X-Chaptr-User') || url.searchParams.get('userId') || '';

    // Backward-compatible recommend endpoint at root.
    if ((path === '' || path === '/') && request.method === 'POST') {
      return handleRecommend(request, env);
    }
    if (path === '/me' && request.method === 'POST') return handleMe(request, env, userId);
    if (path === '/load' && request.method === 'GET') return handleLoad(request, env, userId);
    if (path === '/sync' && request.method === 'POST') return handleSync(request, env, userId);

    if (path === '/health') return json({ ok: true, hasDb: !!env.DB });

    return json({ error: 'Not found', path, method: request.method }, 404);
  },
};
