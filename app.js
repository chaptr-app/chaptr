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
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
  remove(key) { localStorage.removeItem(key); },
};

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
    minutes,
    ms,
    pages,
    wpm,
    mood: mood || null,
  };
  const hist = Store.get(K.history, []);
  hist.push(entry);
  Store.set(K.history, hist);
  if (wpm) Store.set(K.wpm, wpm);
  if (endPage > 0) setBookProgress(s.bookId, endPage);
  clearSession();
  return entry;
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
}

// ---------- reviews ----------
function getReviews() { return Store.get(K.reviews, {}); }
function getReview(bookId) { return getReviews()[bookId] || null; }
function setReview(bookId, review) {
  const m = getReviews();
  if (!review || (!review.rating && !review.text)) {
    delete m[bookId];
  } else {
    m[bookId] = { ...review, date: new Date().toISOString() };
  }
  Store.set(K.reviews, m);
}

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
function createCustomShelf(name) {
  const clean = (name || '').trim();
  if (!clean) return null;
  const id = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const m = getCustomShelves();
  m[id] = { id, name: clean, createdAt: new Date().toISOString(), books: [] };
  setCustomShelvesMap(m);
  return m[id];
}
function renameCustomShelf(id, name) {
  const m = getCustomShelves();
  if (!m[id]) return;
  m[id].name = (name || '').trim() || m[id].name;
  setCustomShelvesMap(m);
}
function deleteCustomShelf(id) {
  const m = getCustomShelves();
  delete m[id];
  setCustomShelvesMap(m);
}
function addToCustomShelf(shelfId, bookId) {
  const m = getCustomShelves();
  if (!m[shelfId] || m[shelfId].books.includes(bookId)) return;
  m[shelfId].books.push(bookId);
  setCustomShelvesMap(m);
}
function removeFromCustomShelf(shelfId, bookId) {
  const m = getCustomShelves();
  if (!m[shelfId]) return;
  m[shelfId].books = m[shelfId].books.filter(b => b !== bookId);
  setCustomShelvesMap(m);
}
function customShelvesContaining(bookId) {
  return listCustomShelves().filter(s => s.books.includes(bookId));
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountBottomNav);
} else {
  mountBottomNav();
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
  getTodayMinutes, getStreak, getLast14Days,
  getShelves, setShelves, shelfFor, moveToShelf,
  listCustomShelves, getCustomShelf, createCustomShelf, renameCustomShelf, deleteCustomShelf,
  addToCustomShelf, removeFromCustomShelf, customShelvesContaining,
  getCurrentBookId, setCurrentBookId,
  getBookProgress, setBookProgress,
  getReviews, getReview, setReview,
  FRIENDS, FRIEND_ACTIVITY, friendByName, relativeTime,
  fmtTime, fmtDay,
  attachSwipe, mountBottomNav,
  OL,
};

})();

