const SYSTEM = `You are the book recommendation engine for Chaptr, a reading-habit app.
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
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

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
          system: SYSTEM,
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
  },
};
