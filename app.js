/* chaptr — shared client logic for the V1 prototype.
   Vanilla JS, zero dependencies. State persisted in localStorage. */

(function () {

// ---------- storage ----------
const Store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
    // Notify the Sync layer (defined below). Keys outside our app prefix don't trigger sync.
    if (typeof Sync !== 'undefined' && key.startsWith('chaptr.') && !Sync._loading) Sync.scheduleSnapshot();
  },
  remove(key) {
    localStorage.removeItem(key);
    if (typeof Sync !== 'undefined' && key.startsWith('chaptr.') && !Sync._loading) Sync.scheduleSnapshot();
  },
};

// ---------- auth (V2 Phase 1B — Clerk) ----------
// Drop-in Clerk integration. The publishable key is stored in localStorage so it can be
// configured from Profile without code edits. The key encodes the Clerk instance domain
// (base64 between pk_test_/pk_live_ and a trailing $) so we can load the SDK dynamically.
const Auth = {
  _clerk: null,
  _user: null,
  _loadPromise: null,
  _listeners: [],

  publishableKey() { return (localStorage.getItem('chaptr.clerkKey') || '').replace(/^"|"$/g, ''); },
  setPublishableKey(k) { localStorage.setItem('chaptr.clerkKey', (k || '').trim()); },
  configured() { return !!this.publishableKey(); },
  signedIn() { return !!this._user; },
  user() { return this._user; },
  // Returns Clerk user_id if signed in, otherwise the anonymous device id.
  effectiveUserId() { return this._user?.id ? 'clerk_' + this._user.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56) : getDeviceId(); },

  instanceDomain() {
    const key = this.publishableKey();
    if (!key) return null;
    try {
      const encoded = key.replace(/^pk_(test|live)_/, '');
      const decoded = atob(encoded);
      return decoded.replace(/\$$/, '');
    } catch { return null; }
  },

  on(fn) { this._listeners.push(fn); return () => { this._listeners = this._listeners.filter(f => f !== fn); }; },
  _notify() { this._listeners.forEach(fn => { try { fn(this); } catch {} }); },

  async load() {
    if (this._loadPromise) return this._loadPromise;
    const key = this.publishableKey();
    if (!key) return null;

    this._loadPromise = (async () => {
      const domain = this.instanceDomain();
      if (!domain) throw new Error('Invalid Clerk publishable key');

      if (!window.Clerk) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.crossOrigin = 'anonymous';
          // Clerk v5 only exposes window.Clerk when the data attribute is set
          // at parse time. With the attribute, the SDK auto-instantiates a
          // singleton instance keyed with the publishable key. We just call
          // .load() on that singleton — never `new`.
          s.dataset.clerkPublishableKey = key;
          s.src = `https://${domain}/npm/@clerk/clerk-js@latest/dist/clerk.browser.js`;
          s.async = true;
          s.onload = resolve;
          s.onerror = () => reject(new Error('Failed to load Clerk SDK from ' + domain));
          document.head.appendChild(s);
        });
      }

      // window.Clerk may not be defined the very instant script.onload fires —
      // poll briefly until it appears.
      const start = Date.now();
      while (!window.Clerk && Date.now() - start < 5000) {
        await new Promise(r => setTimeout(r, 50));
      }
      if (!window.Clerk) throw new Error('Clerk SDK did not initialize within 5s');

      this._clerk = window.Clerk;
      await this._clerk.load();
      this._user = this._clerk.user || null;

      // React to sign-in / sign-out events
      this._clerk.addListener(({ user }) => {
        const wasSignedIn = !!this._user;
        const isSignedIn = !!user;
        this._user = user || null;
        if (isSignedIn && !wasSignedIn) this._onSignIn();
        else if (!isSignedIn && wasSignedIn) this._onSignOut();
        this._notify();
      });

      this._notify();
      return this._clerk;
    })();
    return this._loadPromise;
  },

  async _onSignIn() {
    // First-time sign-in on this browser: migrate the current localStorage
    // (which is keyed under deviceId on the server) into the new Clerk user.
    // We just push our current local state under the new effective user id.
    try {
      if (typeof Sync !== 'undefined' && Sync.enabled()) {
        // Try to pull existing Clerk-user data first; if none, push our local state.
        const res = await Sync.pull();
        if (res?.ok && !res.hydrated) await Sync.pushNow();
        // Phase 3A — make sure community timing has our existing reads too.
        try { await Stats.backfillFinishes(); } catch {}
      }
    } catch (e) { console.warn('[Chaptr] post-sign-in sync failed:', e); }
  },

  _onSignOut() {
    // Fall back to device-id sync. Local data is left intact for re-login.
  },

  // Clerk's default OAuth redirect is the bare origin, which 404s on GitHub
  // Pages projects served from a subpath (chaptr-app.github.io/chaptr/...).
  // Force Clerk to come back to wherever the user clicked Sign in.
  _redirectOpts() {
    const here = window.location.href;
    return {
      afterSignInUrl: here,
      afterSignUpUrl: here,
      redirectUrl: here,
      signInForceRedirectUrl: here,
      signUpForceRedirectUrl: here,
    };
  },
  // Returns a fresh Clerk JWT for the Worker to verify. Null if not signed in
  // or token retrieval fails. Cached briefly so we don't pound Clerk on every sync.
  async getToken() {
    if (!this._clerk?.session) return null;
    try {
      const token = await this._clerk.session.getToken();
      return token || null;
    } catch (e) {
      console.warn('[Chaptr] Clerk getToken failed:', e);
      return null;
    }
  },

  async openSignIn() {
    await this.load();
    if (this._clerk?.openSignIn) this._clerk.openSignIn(this._redirectOpts());
  },
  async openSignUp() {
    await this.load();
    if (this._clerk?.openSignUp) this._clerk.openSignUp(this._redirectOpts());
  },
  async signOut() {
    if (this._clerk?.signOut) await this._clerk.signOut();
  },
};

// ---------- snapshot sync (V2 Phase 1A) ----------
// Single-blob sync: every chaptr.* localStorage key is serialized into one snapshot
// and shipped to the Worker. Pull on boot hydrates from server (newest version wins).
const Sync = {
  _debounceTimer: null,
  _loading: false,           // when true, Store.set won't trigger another push
  _inflight: null,           // current in-flight push promise
  _lastVersion: 0,
  _listeners: [],

  // The set of localStorage keys we sync. We intentionally skip deviceId,
  // ephemeral session timer, and any other non-portable state.
  SYNC_KEYS: [
    'chaptr.history', 'chaptr.shelves', 'chaptr.currentBook',
    'chaptr.dailyGoalMin', 'chaptr.dailyGoalPages', 'chaptr.goalType',
    'chaptr.wpm', 'chaptr.bookWpm', 'chaptr.bookProgress',
    'chaptr.reviews', 'chaptr.customBooks', 'chaptr.customShelves',
    'chaptr.streakFreezes', 'chaptr.upNext', 'chaptr.yearChallenge',
    'chaptr.aiSettings', 'chaptr.shelfDates',
    'chaptr.coachDismissedDay',
  ],

  workerUrl() { return (localStorage.getItem('chaptr.workerUrl') || '').replace(/^"|"$/g, '').replace(/\/+$/, ''); },
  enabled() { return !!this.workerUrl(); },
  status() {
    return {
      enabled: this.enabled(),
      lastSyncAt: localStorage.getItem('chaptr.lastSyncAt') || null,
      lastSyncResult: localStorage.getItem('chaptr.lastSyncResult') || null,
      version: this._lastVersion,
      deviceId: getDeviceId(),
      effectiveUserId: (typeof Auth !== 'undefined') ? Auth.effectiveUserId() : getDeviceId(),
      signedIn: (typeof Auth !== 'undefined') ? Auth.signedIn() : false,
    };
  },
  on(fn) { this._listeners.push(fn); return () => { this._listeners = this._listeners.filter(f => f !== fn); }; },
  _notify() { this._listeners.forEach(fn => { try { fn(this.status()); } catch {} }); },

  // When signed in, send a verifiable Clerk JWT. When anonymous, send the
  // raw device ID. The Worker enforces: clerk_* ids require a Bearer token.
  async authHeaders() {
    if (typeof Auth !== 'undefined' && Auth.signedIn()) {
      const token = await Auth.getToken();
      if (token) return { 'Authorization': 'Bearer ' + token };
    }
    return { 'X-Chaptr-User': getDeviceId() };
  },

  buildSnapshot() {
    const snap = {};
    for (const k of this.SYNC_KEYS) {
      const v = localStorage.getItem(k);
      if (v !== null) snap[k] = v; // store the raw stringified JSON; preserves shape exactly
    }
    return snap;
  },

  applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    this._loading = true;
    try {
      for (const k of this.SYNC_KEYS) {
        if (snap[k] !== undefined) localStorage.setItem(k, snap[k]);
      }
    } finally {
      this._loading = false;
    }
  },

  scheduleSnapshot() {
    if (!this.enabled()) return;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this.pushNow().catch(() => {}), 1500);
  },

  async pushNow() {
    if (!this.enabled()) return { ok: false, error: 'No worker URL configured' };
    if (this._inflight) return this._inflight;
    const body = JSON.stringify({ snapshot: this.buildSnapshot() });
    const url = this.workerUrl() + '/sync';
    const headers = { 'Content-Type': 'application/json', ...(await this.authHeaders()) };
    this._inflight = fetch(url, { method: 'POST', headers, body }).then(async (resp) => {
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
      this._lastVersion = data.version || 0;
      localStorage.setItem('chaptr.lastSyncAt', data.updatedAt || new Date().toISOString());
      localStorage.setItem('chaptr.lastSyncResult', 'ok');
      this._notify();
      return { ok: true, version: data.version, updatedAt: data.updatedAt };
    }).catch((e) => {
      localStorage.setItem('chaptr.lastSyncResult', 'error: ' + e.message);
      this._notify();
      return { ok: false, error: e.message };
    }).finally(() => { this._inflight = null; });
    return this._inflight;
  },

  async pull() {
    if (!this.enabled()) return { ok: false, error: 'No worker URL configured' };
    const url = this.workerUrl() + '/load';
    try {
      const resp = await fetch(url, { method: 'GET', headers: await this.authHeaders() });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
      if (!data.snapshot) {
        // Fresh user — push our local state up
        await this.pushNow();
        return { ok: true, hydrated: false, version: 0 };
      }
      // Apply only if server version is newer. For Phase 1A "newest wins" — we trust the
      // server because most users have one active device at a time. Phase 2 can add merge.
      this.applySnapshot(data.snapshot);
      this._lastVersion = data.version || 0;
      localStorage.setItem('chaptr.lastSyncAt', data.updatedAt || new Date().toISOString());
      localStorage.setItem('chaptr.lastSyncResult', 'ok');
      this._notify();
      return { ok: true, hydrated: true, version: data.version };
    } catch (e) {
      localStorage.setItem('chaptr.lastSyncResult', 'error: ' + e.message);
      this._notify();
      return { ok: false, error: e.message };
    }
  },

  async ensureUser() {
    if (!this.enabled()) return null;
    try {
      const resp = await fetch(this.workerUrl() + '/me', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await this.authHeaders()) },
      });
      const data = await resp.json().catch(() => ({}));
      return resp.ok ? data : null;
    } catch { return null; }
  },
};

// ---------- device id (stable per-browser identifier for sync) ----------
function genDeviceId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return 'dev_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  }
  // Fallback for older browsers
  const rand = (Math.random().toString(36) + Math.random().toString(36)).replace(/[^a-z0-9]/g, '').slice(0, 24);
  return 'dev_' + rand;
}
function getDeviceId() {
  let id = localStorage.getItem('chaptr.deviceId');
  if (!id) {
    id = genDeviceId();
    localStorage.setItem('chaptr.deviceId', id);
  } else {
    // Strip JSON quoting if a previous version stored it via Store.set
    try { const parsed = JSON.parse(id); if (typeof parsed === 'string') id = parsed; } catch {}
  }
  return id;
}

const K = {
  session: 'chaptr.session',
  history: 'chaptr.history',
  shelves: 'chaptr.shelves',
  currentBook: 'chaptr.currentBook',
  dailyGoalMin: 'chaptr.dailyGoalMin',
  wpm: 'chaptr.wpm',
  bookProgress: 'chaptr.bookProgress', // map of bookId -> current page
  reviews: 'chaptr.reviews',           // map of bookId -> { rating, text, date }
  customShelves: 'chaptr.customShelves', // map of shelfId -> { id, name, createdAt, books[] }
  streakFreezes: 'chaptr.streakFreezes', // { count, lastEarnedWeek (ISO Mon date) }
  upNext: 'chaptr.upNext',             // ordered array of bookIds (max 3)
  bookWpm: 'chaptr.bookWpm',           // map of bookId -> array of recent WPM (trailing 10)
  yearChallenge: 'chaptr.yearChallenge', // { year, type: 'books'|'hours', target }
  goalType: 'chaptr.goalType',         // 'minutes' | 'pages'
  dailyGoalPages: 'chaptr.dailyGoalPages', // number, default 20
  aiSettings: 'chaptr.aiSettings',     // { coachCard, forYou, askClaude, readerPersona, friendFeed, smartShelves }
  shelfDates: 'chaptr.shelfDates',     // map of bookId -> { read: 'YYYY-MM-DD' } (date moved to Read)
};

// ---------- mock book catalog ----------
const CATALOG = [
  { id: 'b1', title: 'The Wager',                                  author: 'David Grann',       genre: 'Non-fiction', pages: 352, hue: 28  },
  { id: 'b2', title: 'Klara and the Sun',                          author: 'Kazuo Ishiguro',    genre: 'Literary',    pages: 320, hue: 200 },
  { id: 'b3', title: 'Tomorrow, and Tomorrow, and Tomorrow',       author: 'Gabrielle Zevin',   genre: 'Literary',    pages: 416, hue: 320 },
  { id: 'b4', title: 'Project Hail Mary',                          author: 'Andy Weir',         genre: 'Sci-fi',      pages: 476, hue: 220 },
  { id: 'b5', title: 'The Bee Sting',                              author: 'Paul Murray',       genre: 'Literary',    pages: 656, hue: 50  },
  { id: 'b6', title: 'The Heaven & Earth Grocery Store',           author: 'James McBride',     genre: 'Literary',    pages: 400, hue: 12  },
  { id: 'b7', title: 'The Power Broker',                           author: 'Robert Caro',       genre: 'Non-fiction', pages: 1296, hue: 0   },
  { id: 'b8', title: 'Mexican Gothic',                             author: 'Silvia Moreno-Garcia', genre: 'Thriller', pages: 320, hue: 280 },
];

const COVER_GRADIENTS = (hue) =>
  `linear-gradient(135deg, hsl(${hue},45%,35%), hsl(${(hue+40)%360},55%,55%))`;

function hashHue(s) {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

// ---------- custom books (added via OpenLibrary search) ----------
function getCustomBooks() { return Store.get('chaptr.customBooks', {}); }
function setCustomBooks(m) { Store.set('chaptr.customBooks', m); }
function addCustomBook(book) {
  const m = getCustomBooks();
  m[book.id] = book;
  setCustomBooks(m);
}

function findBook(id) {
  const seed = CATALOG.find(b => b.id === id);
  if (seed) return seed;
  const custom = getCustomBooks()[id];
  if (custom) return custom;
  return CATALOG[0];
}

// ---------- OpenLibrary integration (browser-side) ----------
const OL = {
  cache: {},  // in-memory, backed by localStorage
  coverCacheKey(title, author) { return 'chaptr.cover.' + (title || '') + '|' + (author || ''); },

  async fetchCoverId(title, author) {
    const ck = OL.coverCacheKey(title, author);
    if (OL.cache[ck] !== undefined) return OL.cache[ck];
    const stored = Store.get(ck, undefined);
    if (stored !== undefined) { OL.cache[ck] = stored; return stored; }
    try {
      const q = encodeURIComponent((title || '') + ' ' + (author || ''));
      const url = `https://openlibrary.org/search.json?q=${q}&fields=cover_i&limit=1`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('OL ' + res.status);
      const data = await res.json();
      const id = data.docs && data.docs[0] && data.docs[0].cover_i ? data.docs[0].cover_i : null;
      OL.cache[ck] = id;
      Store.set(ck, id);
      return id;
    } catch (e) {
      OL.cache[ck] = null;
      return null;
    }
  },

  coverUrl(coverId, size) {
    return coverId ? `https://covers.openlibrary.org/b/id/${coverId}-${size || 'M'}.jpg` : null;
  },

  // If book already has coverId, use it. Otherwise fetch by title+author.
  applyCover(el, book, size) {
    if (!el || !book) return;
    el.style.background = COVER_GRADIENTS(book.hue != null ? book.hue : hashHue(book.title));
    const setBg = (coverId) => {
      if (!coverId || !el.isConnected) return;
      const u = OL.coverUrl(coverId, size);
      const img = new Image();
      img.onload = () => {
        if (el.isConnected) {
          el.style.background = `center/cover no-repeat url("${u}")`;
        }
      };
      img.src = u;
    };
    if (book.coverId) { setBg(book.coverId); return; }
    OL.fetchCoverId(book.title, book.author).then(setBg);
  },

  async search(query) {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&fields=key,title,author_name,cover_i,first_publish_year,number_of_pages_median,subject&limit=12`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (e) {
      const msg = e.name === 'AbortError'
        ? 'OpenLibrary took too long to respond. Try again.'
        : 'Could not reach OpenLibrary. Check your connection or try again shortly.';
      throw new Error(msg);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error('OpenLibrary returned an error (' + res.status + '). Try again.');
    const data = await res.json();
    return (data.docs || []).map(d => {
      const author = (d.author_name && d.author_name[0]) || 'Unknown';
      const title = d.title || 'Untitled';
      const olid = (d.key || '').replace('/works/', '');
      return {
        id: 'ol_' + olid,
        olid,
        title,
        author,
        genre: guessGenre(d.subject || []),
        pages: d.number_of_pages_median || 320,
        coverId: d.cover_i || null,
        hue: hashHue(title + author),
        year: d.first_publish_year || null,
      };
    });
  },
};

function guessGenre(subjects) {
  const s = (subjects || []).join(' ').toLowerCase();
  if (/thriller|crime|suspense|mystery/.test(s)) return 'Thriller';
  if (/science fiction|sci-fi|space/.test(s))    return 'Sci-fi';
  if (/biograph|history|memoir|nonfiction/.test(s)) return 'Non-fiction';
  if (/fantasy|magic/.test(s)) return 'Fantasy';
  return 'Literary';
}

// ---------- ambient Claude content ----------
const COACH_NUDGES = [
  { text: "You've read 4 days in a row at 9pm — protecting that slot tonight?", signals: 'time-of-day pattern' },
  { text: "This chapter averages 22 minutes for readers like you. Want a timer?", signals: 'chapter pace × your WPM' },
  { text: "You're 38 pages from finishing — most readers finish in one sitting from here.", signals: 'completion proximity' },
  { text: "Your non-fiction WPM is up 18% this quarter. Ready for something denser?", signals: 'pace progression' },
  { text: "Your last 3 sessions were tagged 🤯. A lighter book up next?", signals: 'mood inference' },
  { text: "You read thrillers 40% faster than literary fiction — want a fast-paced read for your weekend?", signals: 'genre × WPM delta' },
];

function pickCoachNudge() {
  const day = Math.floor(Date.now() / 86400000);
  return COACH_NUDGES[day % COACH_NUDGES.length];
}

const FOR_YOU = [
  { bookId: 'b8', why: 'Matches your 35-min commute window — short chapters at your morning pace.', signals: 'WPM × commute slot' },
  { bookId: 'b4', why: "You finish 82% of books between 400–500 pages. This one's in your sweet spot.", signals: 'completion likelihood' },
  { bookId: 'b1', why: 'A non-fiction palate cleanser — your last 3 reads were literary.', signals: 'genre rotation' },
  { bookId: 'b3', why: "Friends with your taste rated it 4.6★ and finished in under 8 hours.", signals: 'social × pace' },
  { bookId: 'b6', why: "Tagged 'peaceful' by readers with your mood pattern this week.", signals: 'mood inference' },
  { bookId: 'b5', why: 'Marathon read — pace yourself across 4 weekends, fits your weekend reading habit.', signals: 'session length' },
];

// Mock "Ask Claude" — generates 2-3 plausible matches + a rationale string from the query.
function askClaude(query) {
  const q = query.toLowerCase();
  const wantsShort = /quick|short|commute|under|hour/.test(q);
  const wantsThriller = /thriller|fast|page-turn/.test(q);
  const wantsLiterary = /quiet|literary|character|slow/.test(q);
  const wantsSciFi = /sci|space|future|tech/.test(q);
  const wantsNonFic = /non.?fiction|memoir|history|true/.test(q);

  let picks = CATALOG.slice();
  if (wantsShort) picks = picks.filter(b => b.pages < 380);
  if (wantsThriller) picks = picks.filter(b => b.genre === 'Thriller' || b.genre === 'Sci-fi');
  if (wantsLiterary) picks = picks.filter(b => b.genre === 'Literary');
  if (wantsSciFi) picks = picks.filter(b => b.genre === 'Sci-fi');
  if (wantsNonFic) picks = picks.filter(b => b.genre === 'Non-fiction');
  if (picks.length === 0) picks = CATALOG.slice(0, 3);
  picks = picks.slice(0, 3);

  const rationale = [
    wantsShort && 'matched your short-session preference',
    wantsThriller && 'high-pace, matches your thriller WPM',
    wantsLiterary && 'mood-tagged \"quiet\" by similar readers',
    wantsSciFi && 'falls in your sci-fi sweet spot',
    wantsNonFic && 'fits your non-fiction reading slot',
  ].filter(Boolean).join('; ') || 'top picks across your reading profile';

  return { picks, rationale, query };
}

// ---------- session timer ----------
function getSession()   { return Store.get(K.session, null); }
function clearSession() { Store.remove(K.session); }

function startSession(bookId) {
  const now = Date.now();
  Store.set(K.session, { bookId, startedAt: now, elapsedMs: 0, paused: false, lastResumeAt: now });
}
function pauseSession() {
  const s = getSession(); if (!s || s.paused) return;
  s.elapsedMs += Date.now() - s.lastResumeAt;
  s.paused = true;
  Store.set(K.session, s);
}
function resumeSession() {
  const s = getSession(); if (!s || !s.paused) return;
  s.paused = false;
  s.lastResumeAt = Date.now();
  Store.set(K.session, s);
}
function elapsedMs(s) {
  if (!s) return 0;
  return s.paused ? s.elapsedMs : s.elapsedMs + (Date.now() - s.lastResumeAt);
}
function stopSession({ endPage, startPage, mood }) {
  const s = getSession(); if (!s) return null;
  const ms = elapsedMs(s);
  const minutes = Math.round(ms / 60000);
  const pages = Math.max(0, (endPage || 0) - (startPage || 0));
  // crude WPM estimate: ~275 words/page
  const wpm = minutes > 0 && pages > 0 ? Math.round((pages * 275) / minutes) : null;
  const entry = {
    bookId: s.bookId,
    date: new Date().toISOString().slice(0, 10),
    startedAt: s.startedAt || null,
    minutes,
    ms,
    pages,
    wpm,
    mood: mood || null,
  };
  const hist = Store.get(K.history, []);
  hist.push(entry);
  Store.set(K.history, hist);
  if (wpm) {
    Store.set(K.wpm, wpm);
    const bw = Store.get(K.bookWpm, {});
    const arr = bw[s.bookId] || [];
    arr.push(wpm);
    bw[s.bookId] = arr.slice(-10);
    Store.set(K.bookWpm, bw);
  }
  if (endPage > 0) setBookProgress(s.bookId, endPage);
  clearSession();
  return entry;
}

// ---------- streak freezes (Duolingo-style) ----------
const MAX_FREEZES = 3;
function isoMonday(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const dow = x.getDay();
  x.setDate(x.getDate() - (dow === 0 ? 6 : dow - 1));
  return x.toISOString().slice(0, 10);
}
function getStreakFreezeState() {
  return Store.get(K.streakFreezes, { count: 1, lastEarnedWeek: '' });
}
function setStreakFreezeState(s) { Store.set(K.streakFreezes, s); }
// Auto-earn 1 freeze each new ISO week (Mon). Caps at MAX_FREEZES.
function tryEarnStreakFreeze() {
  const s = getStreakFreezeState();
  const thisWeek = isoMonday(new Date());
  if (s.lastEarnedWeek !== thisWeek && s.count < MAX_FREEZES) {
    s.count = Math.min(MAX_FREEZES, (s.count || 0) + 1);
    s.lastEarnedWeek = thisWeek;
    setStreakFreezeState(s);
  } else if (s.lastEarnedWeek !== thisWeek) {
    // record the week-stamp even when already capped, so we don't earn 5× the next time
    s.lastEarnedWeek = thisWeek;
    setStreakFreezeState(s);
  }
  return s;
}
function getStreakFreezeCount() { return getStreakFreezeState().count || 0; }

// Streak that can spend freezes to bridge gaps.
// Returns { streak, freezesUsed, freezesAvailable }
function getStreakWithFreezes(minMinutes = 10) {
  const hist = Store.get(K.history, []);
  const byDay = {};
  for (const e of hist) byDay[e.date] = (byDay[e.date] || 0) + (e.minutes || 0);
  const available = getStreakFreezeCount();
  let streak = 0, freezesUsed = 0;
  const d = new Date();
  // Include today only if it cleared the threshold
  if ((byDay[dayKey(d)] || 0) >= minMinutes) {
    streak = 1;
    d.setDate(d.getDate() - 1);
  } else {
    d.setDate(d.getDate() - 1);
  }
  while (true) {
    if ((byDay[dayKey(d)] || 0) >= minMinutes) {
      streak += 1;
      d.setDate(d.getDate() - 1);
    } else if (freezesUsed < available) {
      freezesUsed += 1;
      streak += 1;
      d.setDate(d.getDate() - 1);
    } else break;
  }
  return { streak, freezesUsed, freezesAvailable: available };
}

// ---------- up next queue ----------
const MAX_UP_NEXT = 3;
function getUpNext() { return Store.get(K.upNext, []); }
function setUpNext(arr) { Store.set(K.upNext, (arr || []).slice(0, MAX_UP_NEXT)); }
function addToUpNext(bookId) {
  const q = getUpNext().filter(b => b !== bookId);
  if (q.length >= MAX_UP_NEXT) return false;
  q.push(bookId);
  setUpNext(q);
  return true;
}
function removeFromUpNext(bookId) { setUpNext(getUpNext().filter(b => b !== bookId)); }
function moveUpNext(bookId, dir) {
  const q = getUpNext();
  const i = q.indexOf(bookId);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= q.length) return;
  [q[i], q[j]] = [q[j], q[i]];
  setUpNext(q);
}
function promoteUpNext(bookId) {
  setCurrentBookId(bookId);
  removeFromUpNext(bookId);
}

// ---------- last session per book (for "Pick up where you left off") ----------
function getLastSession(bookId) {
  const hist = Store.get(K.history, []);
  for (let i = hist.length - 1; i >= 0; i--) if (hist[i].bookId === bookId) return hist[i];
  return null;
}
// "3 hours ago", "yesterday", "5 days ago"
function relativeFromIso(iso) {
  if (!iso) return null;
  const then = new Date(iso); if (isNaN(then.getTime())) return null;
  const diffMs = Date.now() - then.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}

// ---------- smart shelves (computed, read-only) ----------
// Returns 3 virtual shelves. Each: { id, name, desc, books: [bookId...] }
function getSmartShelves() {
  const wpm = Store.get(K.wpm, 250);
  const shelves = getShelves();
  const reviews = getReviews();
  const customMap = getCustomBooks();
  // Universe of known books = catalog + customs
  const universe = [...CATALOG, ...Object.values(customMap)];

  // Quick reads — finish in under 4 hours at the user's WPM
  const quickReads = universe.filter(b => {
    const mins = (b.pages * 275) / wpm;
    return mins > 0 && mins < 240;
  }).map(b => b.id);

  // Stalled — books on Reading shelf whose latest session is >30 days ago (or never)
  const now = Date.now();
  const stalled = shelves.reading.filter(id => {
    const last = getLastSession(id);
    if (!last) return true;
    const sessionTime = last.startedAt ? new Date(last.startedAt).getTime() : new Date(last.date + 'T12:00:00').getTime();
    return (now - sessionTime) > (30 * 86400 * 1000);
  });

  // Re-read candidates — books on Read shelf rated >= 4.5★
  const rereads = shelves.read.filter(id => {
    const rv = reviews[id];
    return rv && rv.rating && rv.rating >= 4.5;
  });

  return [
    { id: '__smart_quick',   name: 'Quick reads',       desc: `Finish in under 4h at your pace`, books: quickReads, smart: true },
    { id: '__smart_stalled', name: 'Stalled',           desc: 'No session in 30+ days',           books: stalled,    smart: true },
    { id: '__smart_reread',  name: 'Re-read candidates',desc: 'You loved these — worth another?', books: rereads,    smart: true },
  ];
}
function isSmartShelfId(id) { return typeof id === 'string' && id.startsWith('__smart_'); }
function getSmartShelfById(id) { return getSmartShelves().find(s => s.id === id) || null; }

// ---------- richer reader persona ----------
function buildReaderPersona() {
  const hist = Store.get(K.history, []);
  const wpm = Store.get(K.wpm, 0);
  if (!hist.length) return null;

  const total = hist.reduce((a, e) => a + (e.minutes || 0), 0);
  const sessions = hist.length;
  const avgSession = Math.round(total / sessions);

  // Genre minutes
  const genreMins = {};
  for (const e of hist) {
    const b = findBook(e.bookId);
    genreMins[b.genre] = (genreMins[b.genre] || 0) + (e.minutes || 0);
  }
  const topGenre = Object.entries(genreMins).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Mood
  const moodCounts = {};
  for (const e of hist) if (e.mood) moodCounts[e.mood] = (moodCounts[e.mood] || 0) + 1;
  const topMood = Object.entries(moodCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const moodLabel = { '😌': 'peaceful', '⚡': 'energized', '😴': 'sleepy', '🤯': 'mind-blown' }[topMood] || null;

  // Peak hour (only counts sessions with startedAt)
  const hourBuckets = { morning: 0, afternoon: 0, evening: 0, late: 0 };
  for (const e of hist) {
    if (!e.startedAt) continue;
    const h = new Date(e.startedAt).getHours();
    if (h < 12) hourBuckets.morning += (e.minutes || 0);
    else if (h < 17) hourBuckets.afternoon += (e.minutes || 0);
    else if (h < 22) hourBuckets.evening += (e.minutes || 0);
    else hourBuckets.late += (e.minutes || 0);
  }
  const peakHour = Object.values(hourBuckets).some(v => v > 0)
    ? Object.entries(hourBuckets).sort((a, b) => b[1] - a[1])[0][0] : null;

  // Session length descriptor
  const lenWord = avgSession < 15 ? 'snack-sized' : avgSession < 30 ? 'methodical' : avgSession < 60 ? 'deep' : 'marathon';

  return {
    sessions, total, avgSession, wpm,
    topGenre, topMood, moodLabel, peakHour, lenWord,
  };
}

// ---------- streak + daily ----------
function todayKey() { return new Date().toISOString().slice(0, 10); }
function dayKey(d)  { return d.toISOString().slice(0, 10); }

function getTodayMinutes() {
  const hist = Store.get(K.history, []);
  const t = todayKey();
  return hist.filter(e => e.date === t).reduce((a, e) => a + (e.minutes || 0), 0);
}

function getStreak(minMinutes = 10) {
  const hist = Store.get(K.history, []);
  const byDay = {};
  for (const e of hist) byDay[e.date] = (byDay[e.date] || 0) + (e.minutes || 0);
  let streak = 0;
  const d = new Date();
  // include today only if it already cleared the threshold
  if ((byDay[dayKey(d)] || 0) >= minMinutes) {
    streak = 1;
    d.setDate(d.getDate() - 1);
    while ((byDay[dayKey(d)] || 0) >= minMinutes) {
      streak += 1;
      d.setDate(d.getDate() - 1);
    }
  } else {
    // grace: today not yet logged; still show streak through yesterday
    d.setDate(d.getDate() - 1);
    while ((byDay[dayKey(d)] || 0) >= minMinutes) {
      streak += 1;
      d.setDate(d.getDate() - 1);
    }
  }
  return streak;
}

// ---------- weekly recap ----------
function computeWeekRecap(referenceDate) {
  const hist = Store.get(K.history, []);
  const ref = referenceDate ? new Date(referenceDate) : new Date();
  // Monday of the current week (Mon = 1, Sun = 0)
  const day = ref.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(ref); monday.setHours(0, 0, 0, 0);
  monday.setDate(ref.getDate() + mondayOffset);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6); sunday.setHours(23, 59, 59, 999);
  const prevMonday = new Date(monday); prevMonday.setDate(monday.getDate() - 7);
  const prevSunday = new Date(monday); prevSunday.setDate(monday.getDate() - 1); prevSunday.setHours(23, 59, 59, 999);

  const within = (start, end) => (e) => {
    const d = new Date(e.date + 'T12:00:00');
    return d >= start && d <= end;
  };
  const sumMs = (arr) => arr.reduce((a, e) => a + (e.ms || (e.minutes || 0) * 60000), 0);
  const avg = (arr) => arr.length ? arr.reduce((a, n) => a + n, 0) / arr.length : 0;

  const weekHist = hist.filter(within(monday, sunday));
  const prevHist = hist.filter(within(prevMonday, prevSunday));

  const totalMs = sumMs(weekHist);
  const prevMs = sumMs(prevHist);
  const bookIds = Array.from(new Set(weekHist.map(e => e.bookId)));
  let longestMs = 0, longestEntry = null;
  for (const e of weekHist) {
    const ms = e.ms || (e.minutes || 0) * 60000;
    if (ms > longestMs) { longestMs = ms; longestEntry = e; }
  }
  const wpmThis = Math.round(avg(weekHist.map(e => e.wpm).filter(Boolean)));
  const wpmPrev = Math.round(avg(prevHist.map(e => e.wpm).filter(Boolean)));
  const wpmDelta = wpmPrev > 0 ? Math.round(((wpmThis - wpmPrev) / wpmPrev) * 100) : null;
  const timeDelta = prevMs > 0 ? Math.round(((totalMs - prevMs) / prevMs) * 100) : null;

  return {
    monday, sunday,
    totalMs,
    totalMinutes: Math.round(totalMs / 60000),
    sessionsCount: weekHist.length,
    bookIds,
    longestMs,
    longestMinutes: Math.round(longestMs / 60000),
    longestEntry,
    wpmThis, wpmPrev, wpmDelta,
    timeDelta,
    isSunday: ref.getDay() === 0,
  };
}

// ---------- year activity (for calendar heatmap) ----------
// Returns a sequence of consecutive days starting from the Sunday at-or-before today-364
// and ending today. Each entry: { date, dow (0=Sun..6=Sat), minutes, ms }.
function getYearActivity() {
  const hist = Store.get(K.history, []);
  const byDay = {};
  for (const e of hist) {
    const k = e.date;
    if (!byDay[k]) byDay[k] = { minutes: 0, ms: 0 };
    byDay[k].minutes += e.minutes || 0;
    byDay[k].ms += e.ms || ((e.minutes || 0) * 60000);
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(today.getDate() - 364);
  start.setDate(start.getDate() - start.getDay()); // snap back to Sunday
  const days = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const k = cursor.toISOString().slice(0, 10);
    const entry = byDay[k] || { minutes: 0, ms: 0 };
    days.push({ date: k, dow: cursor.getDay(), minutes: entry.minutes, ms: entry.ms });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function activityLevel(minutes) {
  if (!minutes) return 0;
  if (minutes < 10) return 1;
  if (minutes < 30) return 2;
  if (minutes < 60) return 3;
  return 4;
}

function getLast14Days() {
  const hist = Store.get(K.history, []);
  const byDay = {};
  for (const e of hist) byDay[e.date] = (byDay[e.date] || 0) + (e.minutes || 0);
  const out = [];
  const d = new Date();
  d.setDate(d.getDate() - 13);
  for (let i = 0; i < 14; i++) {
    const k = dayKey(d);
    out.push({ date: k, minutes: byDay[k] || 0 });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// ---------- shelves ----------
function getShelves() {
  return Store.get(K.shelves, {
    reading: ['b2'],
    wantToRead: ['b3', 'b4', 'b1'],
    read: ['b6'],
  });
}
function setShelves(s) { Store.set(K.shelves, s); }
function shelfFor(bookId) {
  const s = getShelves();
  if (s.reading.includes(bookId))    return 'reading';
  if (s.wantToRead.includes(bookId)) return 'wantToRead';
  if (s.read.includes(bookId))       return 'read';
  return null;
}
function moveToShelf(bookId, shelf) {
  const s = getShelves();
  for (const k of ['reading', 'wantToRead', 'read']) s[k] = s[k].filter(x => x !== bookId);
  if (shelf) s[shelf].push(bookId);
  setShelves(s);
  if (shelf === 'read') {
    const dates = Store.get(K.shelfDates, {});
    if (!dates[bookId]) dates[bookId] = {};
    dates[bookId].read = new Date().toISOString().slice(0, 10);
    Store.set(K.shelfDates, dates);
    // Phase 3A — push finish data so the community sees how long you took.
    try { Stats.pushFinish(bookId); } catch {}
  }
}
function getShelfDates() { return Store.get(K.shelfDates, {}); }

// ---------- reviews ----------
function getReviews() { return Store.get(K.reviews, {}); }
function getReview(bookId) { return getReviews()[bookId] || null; }
function setReview(bookId, review) {
  const m = getReviews();
  const isEmpty = !review || (!review.rating && !review.text);
  if (isEmpty) {
    delete m[bookId];
  } else {
    // Preserve visibility if not specified (default: private)
    const existing = m[bookId] || {};
    m[bookId] = {
      ...review,
      visibility: review.visibility || existing.visibility || 'private',
      date: new Date().toISOString(),
    };
  }
  Store.set(K.reviews, m);
  // Phase 2A: dual-write to the reviews table when signed in.
  // Fire-and-forget; errors are non-fatal because localStorage is the canonical store.
  try { ReviewsBackend.upsert(bookId, isEmpty ? null : m[bookId]); } catch {}
}

// ---------- Stats: finish tracking + trending (Phase 3A + 3D) ----------
const Stats = {
  // Total minutes the user has spent on a book according to their session history.
  // Uses ms for accuracy (so sub-minute test sessions still count) and rounds up
  // to at least 1 minute when there's any session time at all.
  totalMinutesForBook(bookId) {
    const hist = Store.get('chaptr.history', []);
    const totalMs = hist
      .filter(e => e.bookId === bookId)
      .reduce((a, e) => a + (e.ms || (e.minutes || 0) * 60000), 0);
    if (totalMs <= 0) return 0;
    return Math.max(1, Math.round(totalMs / 60000));
  },

  // Push a finish record for the book — call when a book lands on the Read shelf.
  // Silently no-ops when not signed in or zero session time exists for the book.
  async pushFinish(bookId) {
    if (typeof Auth === 'undefined' || !Auth.signedIn()) return;
    if (typeof Sync === 'undefined' || !Sync.enabled()) return;
    const minutes = this.totalMinutesForBook(bookId);
    if (minutes < 1) return;
    try {
      await fetch(`${Sync.workerUrl()}/book-finishes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await Sync.authHeaders()) },
        body: JSON.stringify({ bookId, totalMinutes: minutes }),
      });
    } catch {}
  },

  // Backfill: walk the user's Read shelf once and push timing for any book that
  // has logged session minutes. Idempotent thanks to upsert. Run on first
  // sign-in after Phase 3A ships.
  async backfillFinishes() {
    if (typeof Auth === 'undefined' || !Auth.signedIn()) return;
    if (typeof Sync === 'undefined' || !Sync.enabled()) return;
    const shelves = Store.get('chaptr.shelves', null);
    if (!shelves?.read) return;
    for (const bookId of shelves.read) {
      await this.pushFinish(bookId);
    }
  },

  // Trending books across all readers (last 30d, public reviews only). Returns
  // an array of { bookId, activity, avgRating } sorted by activity desc.
  _trendingCache: null,
  async trending(limit = 8) {
    if (this._trendingCache) return this._trendingCache;
    if (typeof Sync === 'undefined' || !Sync.enabled()) return [];
    try {
      const resp = await fetch(`${Sync.workerUrl()}/trending?limit=${limit}`);
      if (!resp.ok) return [];
      const data = await resp.json();
      this._trendingCache = data.books || [];
      return this._trendingCache;
    } catch { return []; }
  },
};

// ---------- spoiler renderer (Phase 2B bonus) ----------
// Turns "before ||hidden|| after" into safe HTML with click-to-reveal blurred spans.
function renderSpoilers(text) {
  if (!text) return '';
  const escape = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return escape(text).replace(/\|\|([^|]+)\|\|/g, (_, inner) =>
    `<span class="spoiler" role="button" tabindex="0" onclick="this.classList.add('revealed')">${inner}</span>`
  );
}

// ---------- social: friend graph + activity feed (Phase 2B) ----------
const Social = {
  _profileCache: null,
  _feedCache: null,

  async _request(path, opts = {}) {
    if (typeof Sync === 'undefined' || !Sync.enabled()) throw new Error('Worker URL not set');
    const headers = { 'Content-Type': 'application/json', ...(await Sync.authHeaders()), ...(opts.headers || {}) };
    const resp = await fetch(Sync.workerUrl() + path, { ...opts, headers });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data?.error || ('HTTP ' + resp.status));
    return data;
  },

  async getMyProfile() {
    if (this._profileCache) return this._profileCache;
    try {
      const { profile } = await this._request('/me/profile', { method: 'GET' });
      this._profileCache = profile;
      return profile;
    } catch { return null; }
  },
  invalidateProfile() { this._profileCache = null; },

  async updateMyProfile({ username, displayName, avatarHue }) {
    const body = {};
    if (username !== undefined) body.username = username;
    if (displayName !== undefined) body.displayName = displayName;
    if (avatarHue !== undefined) body.avatarHue = avatarHue;
    const res = await this._request('/me/profile', { method: 'PUT', body: JSON.stringify(body) });
    this.invalidateProfile();
    return res;
  },

  async search(q) {
    if (!q || q.trim().length < 2) return [];
    try {
      const { users } = await this._request('/users/search?q=' + encodeURIComponent(q.trim()), { method: 'GET' });
      return users;
    } catch { return []; }
  },

  async follow(username) {
    return this._request('/follow', { method: 'POST', body: JSON.stringify({ username }) });
  },
  async unfollow(username) {
    return this._request('/follow?username=' + encodeURIComponent(username), { method: 'DELETE' });
  },

  async getMyFollows() {
    try { return await this._request('/me/follows', { method: 'GET' }); }
    catch { return { followers: [], following: [] }; }
  },

  async getFeed() {
    if (this._feedCache) return this._feedCache;
    try {
      const data = await this._request('/feed', { method: 'GET' });
      this._feedCache = data;
      return data;
    } catch { return { items: [] }; }
  },
  invalidateFeed() { this._feedCache = null; },
};

const ReviewsBackend = {
  async upsert(bookId, review) {
    if (typeof Auth === 'undefined' || !Auth.signedIn()) return;
    if (typeof Sync === 'undefined' || !Sync.enabled()) return;
    const url = Sync.workerUrl();
    const headers = { 'Content-Type': 'application/json', ...(await Sync.authHeaders()) };
    if (review === null) {
      try {
        await fetch(`${url}/reviews?bookId=${encodeURIComponent(bookId)}`, { method: 'DELETE', headers });
      } catch {}
      return;
    }
    try {
      await fetch(`${url}/reviews`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          bookId,
          rating: review.rating ?? null,
          text: review.text ?? null,
          visibility: review.visibility || 'private',
        }),
      });
    } catch {}
  },

  // Public stats for a book — no auth needed. Returns { avgRating, count } or null.
  _statsCache: {},
  async stats(bookId) {
    if (this._statsCache[bookId]) return this._statsCache[bookId];
    if (typeof Sync === 'undefined' || !Sync.enabled()) return null;
    try {
      const resp = await fetch(`${Sync.workerUrl()}/books/${encodeURIComponent(bookId)}/stats`);
      if (!resp.ok) return null;
      const data = await resp.json();
      this._statsCache[bookId] = data;
      return data;
    } catch { return null; }
  },

  // Per-book timing across all users — anonymous.
  _timingCache: {},
  async timing(bookId) {
    if (this._timingCache[bookId]) return this._timingCache[bookId];
    if (typeof Sync === 'undefined' || !Sync.enabled()) return null;
    try {
      const resp = await fetch(`${Sync.workerUrl()}/books/${encodeURIComponent(bookId)}/timing`);
      if (!resp.ok) return null;
      const data = await resp.json();
      this._timingCache[bookId] = data;
      return data;
    } catch { return null; }
  },

  // A few public reviews for a book — no auth needed.
  _publicCache: {},
  async publicReviews(bookId, limit = 3) {
    const key = bookId + ':' + limit;
    if (this._publicCache[key]) return this._publicCache[key];
    if (typeof Sync === 'undefined' || !Sync.enabled()) return [];
    try {
      const resp = await fetch(`${Sync.workerUrl()}/reviews/public?bookId=${encodeURIComponent(bookId)}&limit=${limit}`);
      if (!resp.ok) return [];
      const data = await resp.json();
      this._publicCache[key] = data.reviews || [];
      return this._publicCache[key];
    } catch { return []; }
  },
};

// ---------- social: mock friends + activity feed ----------
const FRIENDS = [
  { name: 'Sarah Chen',   initials: 'SC', hue: 280 },
  { name: 'Marcus Lee',   initials: 'ML', hue: 200 },
  { name: 'Priya Shah',   initials: 'PS', hue: 30  },
  { name: 'Jordan Park',  initials: 'JP', hue: 160 },
  { name: 'Emma Wright',  initials: 'EW', hue: 320 },
  { name: 'Theo Alvarez', initials: 'TA', hue: 12  },
];

// Mock activity. Stable seed: hours ago, not absolute timestamps, so it always reads as "recent".
const FRIEND_ACTIVITY = [
  { friend: 'Sarah Chen',   verb: 'finished',  bookId: 'b3', rating: 4.5, note: 'Cried at the last chapter. Worth every page.', hoursAgo: 4  },
  { friend: 'Marcus Lee',   verb: 'started',   bookId: 'b4',              note: 'Heard great things — finally diving in.',     hoursAgo: 7  },
  { friend: 'Priya Shah',   verb: 'finished',  bookId: 'b6', rating: 5,   note: 'Best book I read this year. Tell everyone.',  hoursAgo: 18 },
  { friend: 'Jordan Park',  verb: 'is reading',bookId: 'b1',              note: 'Cannot put this down. The shipwreck chapter…',hoursAgo: 22 },
  { friend: 'Emma Wright',  verb: 'finished',  bookId: 'b2', rating: 4,   note: 'Beautiful and quietly devastating.',          hoursAgo: 40 },
  { friend: 'Sarah Chen',   verb: 'started',   bookId: 'b8',              note: 'Need a thriller for the weekend.',            hoursAgo: 52 },
  { friend: 'Theo Alvarez', verb: 'finished',  bookId: 'b5', rating: 4.5, note: 'A door-stopper but the payoff is enormous.',  hoursAgo: 68 },
  { friend: 'Marcus Lee',   verb: 'finished',  bookId: 'b1', rating: 5,   note: 'Reads like a novel — Grann is a master.',     hoursAgo: 90 },
];

function friendByName(name) { return FRIENDS.find(f => f.name === name); }
function relativeTime(hoursAgo) {
  if (hoursAgo < 1) return 'just now';
  if (hoursAgo < 24) return `${Math.round(hoursAgo)}h ago`;
  const d = Math.round(hoursAgo / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

// ---------- per-book page progress ----------
function getBookProgress(bookId) {
  const m = Store.get(K.bookProgress, {});
  return m[bookId] || 0;
}
function setBookProgress(bookId, page) {
  const m = Store.get(K.bookProgress, {});
  m[bookId] = page;
  Store.set(K.bookProgress, m);
}

// ---------- custom shelves ----------
// Independent of the 3 system shelves. A book CAN be on multiple custom shelves at once.
function getCustomShelves() { return Store.get(K.customShelves, {}); }
function setCustomShelvesMap(m) { Store.set(K.customShelves, m); }
function listCustomShelves() {
  return Object.values(getCustomShelves()).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}
function getCustomShelf(id) { return getCustomShelves()[id] || null; }
function createCustomShelf(name, visibility = 'private') {
  const clean = (name || '').trim();
  if (!clean) return null;
  const id = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const m = getCustomShelves();
  m[id] = { id, name: clean, visibility, createdAt: new Date().toISOString(), books: [] };
  setCustomShelvesMap(m);
  try { ShelvesBackend.upsert(m[id]); } catch {}
  return m[id];
}
function renameCustomShelf(id, name) {
  const m = getCustomShelves();
  if (!m[id]) return;
  m[id].name = (name || '').trim() || m[id].name;
  setCustomShelvesMap(m);
  try { ShelvesBackend.upsert(m[id]); } catch {}
}
function setCustomShelfVisibility(id, visibility) {
  const m = getCustomShelves();
  if (!m[id]) return;
  const prev = m[id].visibility || 'private';
  m[id].visibility = visibility;
  setCustomShelvesMap(m);
  try {
    if (visibility === 'private' && prev !== 'private') ShelvesBackend.delete(id);
    else ShelvesBackend.upsert(m[id]);
  } catch {}
}
function deleteCustomShelf(id) {
  const m = getCustomShelves();
  delete m[id];
  setCustomShelvesMap(m);
  try { ShelvesBackend.delete(id); } catch {}
}
function addToCustomShelf(shelfId, bookId) {
  const m = getCustomShelves();
  if (!m[shelfId] || m[shelfId].books.includes(bookId)) return;
  m[shelfId].books.push(bookId);
  setCustomShelvesMap(m);
  try { ShelvesBackend.upsert(m[shelfId]); } catch {}
}
function removeFromCustomShelf(shelfId, bookId) {
  const m = getCustomShelves();
  if (!m[shelfId]) return;
  m[shelfId].books = m[shelfId].books.filter(b => b !== bookId);
  setCustomShelvesMap(m);
  try { ShelvesBackend.upsert(m[shelfId]); } catch {}
}

// Backend mirror for non-private custom shelves.
const ShelvesBackend = {
  async upsert(shelf) {
    if (!shelf || shelf.visibility === 'private' || !shelf.visibility) return;
    if (typeof Auth === 'undefined' || !Auth.signedIn()) return;
    if (typeof Sync === 'undefined' || !Sync.enabled()) return;
    try {
      await fetch(Sync.workerUrl() + '/shelves', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await Sync.authHeaders()) },
        body: JSON.stringify({
          id: shelf.id, name: shelf.name, books: shelf.books || [], visibility: shelf.visibility,
        }),
      });
    } catch {}
  },
  async delete(id) {
    if (typeof Auth === 'undefined' || !Auth.signedIn()) return;
    if (typeof Sync === 'undefined' || !Sync.enabled()) return;
    try {
      await fetch(Sync.workerUrl() + '/shelves?id=' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: await Sync.authHeaders(),
      });
    } catch {}
  },
  async fetchUserShelves(username) {
    if (typeof Sync === 'undefined' || !Sync.enabled()) return null;
    try {
      const resp = await fetch(Sync.workerUrl() + '/users/' + encodeURIComponent(username) + '/shelves', {
        headers: await Sync.authHeaders(),
      });
      const data = await resp.json().catch(() => ({}));
      return resp.ok ? data : null;
    } catch { return null; }
  },
  async fetchUserReviews(username) {
    if (typeof Sync === 'undefined' || !Sync.enabled()) return null;
    try {
      const resp = await fetch(Sync.workerUrl() + '/users/' + encodeURIComponent(username) + '/reviews', {
        headers: await Sync.authHeaders(),
      });
      const data = await resp.json().catch(() => ({}));
      return resp.ok ? data : null;
    } catch { return null; }
  },
};
function customShelvesContaining(bookId) {
  return listCustomShelves().filter(s => s.books.includes(bookId));
}

// ---------- per-book WPM (smoothed over trailing 10 sessions) ----------
function getBookWpm(bookId) {
  const bw = Store.get(K.bookWpm, {});
  const arr = bw[bookId] || [];
  if (!arr.length) return Store.get(K.wpm, 250);
  return Math.round(arr.reduce((a, n) => a + n, 0) / arr.length);
}

// ---------- daily goal (minutes or pages) ----------
function getGoalType() { return Store.get(K.goalType, 'minutes'); }
function setGoalType(t) { if (t === 'minutes' || t === 'pages') Store.set(K.goalType, t); }
function getDailyGoalPages() { return Store.get(K.dailyGoalPages, 20); }
function setDailyGoalPages(p) { Store.set(K.dailyGoalPages, Math.max(1, Math.min(500, p|0))); }
function getTodayPages() {
  const hist = Store.get(K.history, []);
  const t = todayKey();
  return hist.filter(e => e.date === t).reduce((a, e) => a + (e.pages || 0), 0);
}

// ---------- annual reading challenge ----------
function getYearChallenge() {
  const y = new Date().getFullYear();
  const c = Store.get(K.yearChallenge, null);
  if (!c || c.year !== y) {
    const fresh = { year: y, type: 'books', target: 12 };
    Store.set(K.yearChallenge, fresh);
    return fresh;
  }
  return c;
}
function setYearChallenge(partial) {
  const c = { ...getYearChallenge(), ...partial, year: new Date().getFullYear() };
  if (c.type !== 'books' && c.type !== 'hours') c.type = 'books';
  c.target = Math.max(1, Math.min(c.type === 'books' ? 365 : 8760, parseInt(c.target, 10) || 1));
  Store.set(K.yearChallenge, c);
  return c;
}
function getYearChallengeProgress() {
  const c = getYearChallenge();
  const y = c.year;
  if (c.type === 'hours') {
    const hist = Store.get(K.history, []);
    const ms = hist
      .filter(e => e.date.startsWith(y + '-'))
      .reduce((a, e) => a + (e.ms || (e.minutes || 0) * 60000), 0);
    const hours = ms / 3600000;
    return { ...c, current: Math.round(hours * 10) / 10, pct: Math.min(1, hours / c.target) };
  } else {
    // books finished this year = on Read shelf with shelfDates.read in this year
    const dates = getShelfDates();
    const finishedThisYear = Object.entries(dates)
      .filter(([, d]) => d.read && d.read.startsWith(y + '-')).length;
    return { ...c, current: finishedThisYear, pct: Math.min(1, finishedThisYear / c.target) };
  }
}

// ---------- AI settings ----------
const DEFAULT_AI_SETTINGS = {
  coachCard: true, forYou: true, askClaude: true,
  readerPersona: true, friendFeed: true, smartShelves: true,
};
function getAISettings() {
  return { ...DEFAULT_AI_SETTINGS, ...Store.get(K.aiSettings, {}) };
}
function setAISetting(key, value) {
  const s = getAISettings();
  s[key] = !!value;
  Store.set(K.aiSettings, s);
}
function exportReaderProfile() {
  const persona = (typeof buildReaderPersona === 'function') ? buildReaderPersona() : null;
  return {
    exportedAt: new Date().toISOString(),
    persona,
    wpm: Store.get(K.wpm, null),
    bookWpm: Store.get(K.bookWpm, {}),
    history: Store.get(K.history, []),
    aiSettings: getAISettings(),
    bookProgress: Store.get(K.bookProgress, {}),
    customBooks: getCustomBooks(),
  };
}
function wipeReaderProfile() {
  // Clears AI-derived/behavioral data. Leaves shelves, reviews, custom shelves intact.
  [K.history, K.wpm, K.bookWpm, K.session, K.bookProgress, K.streakFreezes].forEach(k => Store.remove(k));
}

// ---------- auto-pause on background (90s rule) ----------
let _bgTimer = null;
function startBackgroundPauseWatcher(timeoutMs = 90000) {
  if (typeof document === 'undefined' || document.__chaptrBgWatcher) return;
  document.__chaptrBgWatcher = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      _bgTimer = setTimeout(() => {
        const s = getSession();
        if (s && !s.paused) pauseSession();
      }, timeoutMs);
    } else if (_bgTimer) {
      clearTimeout(_bgTimer);
      _bgTimer = null;
    }
  });
}

// ---------- coach "tell me more" (single-turn Claude call via existing worker) ----------
async function askCoachMore(nudgeText) {
  const url = Store.get('chaptr.workerUrl', '');
  if (!url) {
    return { ok: false, error: 'Set your Claude Worker URL in Profile to get expanded coach thoughts.' };
  }
  try {
    // Reuse the books worker as a generic chat endpoint — the prompt asks for an
    // elaboration string and we'll pluck it from books[0].why if the worker
    // happens to be the recommendation variant.
    const dna = (function() {
      const hist = Store.get(K.history, []);
      const wpm = Store.get(K.wpm, 250);
      const total = hist.reduce((a, e) => a + (e.minutes || 0), 0);
      const avgSession = hist.length ? Math.round(total / hist.length) : 0;
      const genres = {};
      for (const e of hist) {
        const b = findBook(e.bookId);
        genres[b.genre] = (genres[b.genre] || 0) + (e.minutes || 0);
      }
      const topGenre = Object.entries(genres).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'unknown';
      return { wpm, avgSession, topGenre, mood: 'unknown', shelfCount: 0 };
    })();
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `The user got this reading coach nudge today: "${nudgeText}". They tapped to learn more. Give exactly ONE friendly, specific, 1-sentence elaboration tying the nudge to their reader DNA. Put that sentence in the 'why' field of the first book object and use any real book that fits the context as title/author. Return the standard 3-book JSON array.`,
        readerDna: dna,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.books?.[0]?.why) throw new Error(data.error || 'Bad response');
    return { ok: true, text: data.books[0].why, suggestion: data.books[0] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- current book ----------
function getCurrentBookId() { return Store.get(K.currentBook, 'b2'); }
function setCurrentBookId(id) { Store.set(K.currentBook, id); }

// ---------- formatting ----------
function fmtTime(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function fmtDay(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

// ---------- mobile: bottom tab nav (auto-mounted on every page) ----------
function mountBottomNav() {
  if (document.querySelector('.bottom-nav')) return;
  const pages = [
    { href: 'today.html',   label: 'Today',   icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' },
    { href: 'library.html', label: 'Library', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4z"/><path d="M20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z"/></svg>' },
    { href: 'shelves.html', label: 'Shelves', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1"/><rect x="3" y="10" width="18" height="5" rx="1"/><rect x="3" y="16" width="18" height="5" rx="1"/></svg>' },
    { href: 'profile.html', label: 'Profile', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/></svg>' },
  ];
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const nav = document.createElement('nav');
  nav.className = 'bottom-nav';
  nav.setAttribute('aria-label', 'Primary');
  nav.innerHTML = pages.map(p => `
    <a href="${p.href}" class="${here === p.href ? 'active' : ''}" aria-label="${p.label}">
      <span class="bn-icon">${p.icon}</span>
      <span class="bn-label">${p.label}</span>
    </a>`).join('');
  document.body.appendChild(nav);
}

// ---------- mobile: persistent "Now Reading" pill ----------
function mountNowReadingPill() {
  if (document.querySelector('.now-reading-pill')) return;
  // Skip on Today — it already has the full timer card
  const here = (location.pathname.split('/').pop() || '').toLowerCase();
  if (here === 'today.html') return;

  const pill = document.createElement('a');
  pill.className = 'now-reading-pill';
  pill.href = 'today.html';
  pill.setAttribute('aria-label', 'Resume reading session');
  pill.innerHTML = `
    <div class="nrp-cover" data-nrp-cover></div>
    <div class="nrp-meta">
      <div class="nrp-eyebrow">Reading <span class="nrp-dot"></span><span class="nrp-paused-label">Paused</span></div>
      <div class="nrp-title" data-nrp-title>—</div>
    </div>
    <div class="nrp-time" data-nrp-time>00:00</div>
  `;
  document.body.appendChild(pill);

  let lastBookId = null;
  let lastText = '';
  let rafId = null;
  function tickPill() {
    const s = getSession();
    if (!s) {
      pill.classList.remove('active');
      document.body.classList.remove('has-now-reading-pill');
      lastBookId = null;
    } else {
      pill.classList.add('active');
      pill.classList.toggle('paused', !!s.paused);
      document.body.classList.add('has-now-reading-pill');
      if (s.bookId !== lastBookId) {
        const b = findBook(s.bookId);
        pill.querySelector('[data-nrp-title]').textContent = b.title;
        OL.applyCover(pill.querySelector('[data-nrp-cover]'), b, 'S');
        lastBookId = s.bookId;
      }
      const text = fmtTime(elapsedMs(s));
      if (text !== lastText) {
        pill.querySelector('[data-nrp-time]').textContent = text;
        lastText = text;
      }
    }
    rafId = requestAnimationFrame(tickPill);
  }
  rafId = requestAnimationFrame(tickPill);
}

function bootCommon() {
  try { tryEarnStreakFreeze(); } catch {}
  try { startBackgroundPauseWatcher(); } catch {}
  mountBottomNav();
  mountNowReadingPill();
  // Kick off auth + backend sync if configured. Runs in background — UI doesn't wait.
  (async () => {
    try {
      if (Auth.configured()) {
        await Auth.load().catch((e) => console.warn('[Chaptr] Clerk load failed:', e));
      }
    } catch {}
    try {
      if (Sync.enabled()) {
        await Sync.ensureUser();
        await Sync.pull();
      }
    } catch {}
  })();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootCommon);
} else {
  bootCommon();
}

// ---------- swipe gesture helper ----------
function attachSwipe(target, { onLeft, onRight, threshold = 60 }) {
  if (!target) return;
  let startX = 0, startY = 0, tracking = false;
  target.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });
  target.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > threshold && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0 && onLeft) onLeft();
      else if (dx > 0 && onRight) onRight();
    }
  }, { passive: true });
}

// expose
window.Chaptr = {
  Store, K, CATALOG, COVER_GRADIENTS, hashHue, findBook,
  getCustomBooks, addCustomBook,
  COACH_NUDGES, pickCoachNudge, FOR_YOU, askClaude,
  startSession, pauseSession, resumeSession, stopSession, getSession, elapsedMs,
  getTodayMinutes, getStreak, getLast14Days, computeWeekRecap,
  getYearActivity, activityLevel,
  tryEarnStreakFreeze, getStreakFreezeCount, getStreakWithFreezes,
  getUpNext, addToUpNext, removeFromUpNext, moveUpNext, promoteUpNext, MAX_UP_NEXT,
  getLastSession, relativeFromIso,
  getSmartShelves, getSmartShelfById, isSmartShelfId,
  buildReaderPersona,
  getBookWpm,
  getGoalType, setGoalType, getDailyGoalPages, setDailyGoalPages, getTodayPages,
  getYearChallenge, setYearChallenge, getYearChallengeProgress,
  getAISettings, setAISetting, exportReaderProfile, wipeReaderProfile,
  askCoachMore,
  getShelfDates,
  getShelves, setShelves, shelfFor, moveToShelf,
  listCustomShelves, getCustomShelf, createCustomShelf, renameCustomShelf, deleteCustomShelf,
  setCustomShelfVisibility, addToCustomShelf, removeFromCustomShelf, customShelvesContaining,
  ShelvesBackend,
  getCurrentBookId, setCurrentBookId,
  getBookProgress, setBookProgress,
  getReviews, getReview, setReview, ReviewsBackend, Social, Stats, renderSpoilers,
  FRIENDS, FRIEND_ACTIVITY, friendByName, relativeTime,
  fmtTime, fmtDay,
  attachSwipe, mountBottomNav, mountNowReadingPill,
  Sync, Auth, getDeviceId,
  OL,
};

})();

