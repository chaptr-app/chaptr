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

function findBook(id) { return CATALOG.find(b => b.id === id) || CATALOG[0]; }

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
    pages,
    wpm,
    mood: mood || null,
  };
  const hist = Store.get(K.history, []);
  hist.push(entry);
  Store.set(K.history, hist);
  if (wpm) Store.set(K.wpm, wpm);
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

// expose
window.Chaptr = {
  Store, K, CATALOG, COVER_GRADIENTS, findBook,
  COACH_NUDGES, pickCoachNudge, FOR_YOU, askClaude,
  startSession, pauseSession, resumeSession, stopSession, getSession, elapsedMs,
  getTodayMinutes, getStreak, getLast14Days,
  getShelves, setShelves, shelfFor, moveToShelf,
  getCurrentBookId, setCurrentBookId,
  fmtTime, fmtDay,
};

})();

