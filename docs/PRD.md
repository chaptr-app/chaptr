# Chaptr — Product Requirements Document (V0)

## Context

Chaptr is an AI-first competitor to Goodreads that incorporates Bookly's habit-building mechanics. The product is organized around two primary views — **Daily Habit** and **Library Discovery** — with Claude as an ambient, opt-in companion that turns reading-timer telemetry into smarter recommendations.

**Why this matters:** Goodreads owns metadata + social proof but is stagnant and offers no habit support. Bookly owns the timer/streak loop but has no discovery engine and no social graph. Neither leverages an LLM. The wedge is: **time-spent data is the richest behavioral signal in reading, and nobody uses it for recommendations.** Claude can convert "you read thrillers 40% faster than literary fiction" into actionable suggestions matched to a user's available time, mood, and pace.

**Audience balance:** Equal weight to habit-builders (Bookly demo) and social/discovery readers (Goodreads demo). Both views are co-primary in the IA.

---

## Product Principles

1. **Time is the new "star rating."** Every recommendation, shelf, and insight is grounded in real reading-time data, not declared preference.
2. **Habit > hype.** The home screen prioritizes today's reading, not what's trending.
3. **Claude is ambient, not loud.** AI appears as a "Reading Coach" card the user can dismiss, expand, or chat with — never modal interruptions.
4. **Social is opt-in per shelf.** Privacy by default; the same user can have a public "2026 Reads" shelf and a private "Therapy Books" shelf.
5. **One-tap to read.** From any screen, the active book + timer is two taps away.

---

## Global / Cross-View Elements

- **Bottom tab nav (mobile) / left rail (web):** `Today` (Daily Habit) · `Library` (Discovery) · `Shelves` · `Feed` · `Profile`
- **Persistent "Now Reading" pill** at top of every screen when a session is active — tap to expand timer, swipe to pause.
- **Claude Coach surface:** Floating card on Today, embedded "Ask Claude" search bar on Library, and a global chat sheet (long-press the pill).
- **Universal book metadata:** ISBN/OpenLibrary/Google Books ingest + user-contributed corrections (Goodreads-grade depth).

---

## View 1 — Daily Habit (Bookly DNA)

The Today screen. Goal: get the user reading within 10 seconds of opening the app.

### 1.1 Active Reading Session
- **Real-time reading timer** with one-tap start/pause/stop; auto-pauses on app background after 90s of inactivity.
- **Page/chapter check-in** prompt at session end ("You read from p.84 → p.?") to anchor WPM.
- **WPM calculation** per session, smoothed over the trailing 10 sessions per book.
- **Ambient session mode:** dim UI, optional focus sounds, no notifications (iOS Focus / Android DnD integration).
- **Audiobook session** parallel: minutes-listened tracking + speed multiplier capture (1.0x → 3.0x).

### 1.2 Habit Loop
- **Reading Streak** counter (consecutive days with ≥ user-defined minimum, default 10 min).
- **Streak Freeze** tokens earned weekly (Duolingo-style) — Bookly never had these; this is a competitive upgrade.
- **Daily goal ring** (minutes OR pages, user choice) with subtle haptic on completion.
- **Weekly recap card** every Sunday: total time, books touched, pace trends, longest session.

### 1.3 Today's Snapshot
- **Current book card:** cover, % complete, time-to-finish estimate (uses *this user's* WPM on *this genre*, not a generic average).
- **"Pick up where you left off"** with the last sentence preview (license-permitting; otherwise last page number).
- **Up Next queue:** drag-orderable list of 1–3 books you've committed to read next.

### 1.4 Coach Card (Ambient AI)
- One Claude-generated nudge per day, e.g.:
  - *"You've read 4 days in a row at 9pm — protecting that slot tonight?"*
  - *"This chapter averages 22 minutes for readers like you. Want a timer?"*
  - *"You're 38 pages from finishing. Most readers finish in one sitting from here."*
- Dismissible. Tap to expand into a chat thread with Claude.

### 1.5 Session History
- Sparkline of last 14 days (minutes/day).
- Calendar heatmap (GitHub-style) for the year.
- Per-book session log: each row = date, duration, pages, WPM, optional mood tag (😌 / ⚡ / 😴 / 🤯).

---

## View 2 — Library Discovery (Goodreads DNA + AI Edge)

Goal: find the next great book using *who you actually are* as a reader, not what you claim.

### 2.1 Book Database
- Full metadata: title, authors, ISBN, page count, est. word count, publication date, editions, series order, content warnings, language(s), translator.
- Cover art with multi-edition support.
- Crowd-sourced corrections (mirrors Goodreads' Librarian role) with review queue.

### 2.2 User-Led Shelves
- **Default shelves:** Reading, Read, Want to Read (Goodreads parity).
- **Custom shelves:** unlimited, taggable, per-shelf visibility (Public / Friends / Private).
- **Smart shelves (AI-generated):** auto-populated by Claude based on patterns — *"Books you read in under 4 hours"*, *"Re-read candidates"*, *"Started but stalled >30 days"*. User can promote a Smart shelf to a permanent shelf.
- **Collaborative shelves:** invite friends; great for book clubs.

### 2.3 Social Reviews & Activity
- Star ratings (5-star) + long-form review + spoiler-tagged sections.
- **Time-honest ratings:** optionally show "Avg reader finished in 6.2 hrs" alongside the star rating — a unique signal Goodreads can't offer.
- Threaded comments, likes, "saves" (private), reshares to feed.
- **Friend Feed:** chronological updates (finished, started, shelved, reviewed).
- Follow authors; author Q&A threads.
- Reading buddies: pair-read a book, sync progress, in-line chat per chapter.

### 2.4 Discovery Surfaces
- **For You:** AI-ranked feed of books (see §3).
- **Browse by:** genre, mood, length-in-hours-for-you, "fits my commute", award lists, friend activity.
- **Trending:** sitewide and within-shelf.
- **Author / series pages** with completion stats from the community.
- **Ask Claude:** natural-language search bar — *"a quiet sci-fi novel under 300 pages that won't keep me up at night."*

### 2.5 Goals & Challenges
- Annual reading challenge (book count or hours — hours is new vs Goodreads).
- Custom challenges: "Read 5 books in translation this year," "Finish the Le Guin Hainish Cycle."
- Friend challenges and leaderboards (opt-in).

---

## 3. The AI Edge — How Claude Uses Timer Data

Claude has access (with user consent) to a structured **Reader Profile** that aggregates:
- WPM by genre, format (print/ebook/audio), and time-of-day.
- Session length distribution + drop-off thresholds.
- Completion rate by genre / page count / pace.
- Mood tags + correlations.
- Stall patterns (books abandoned at X% across the catalog).

### 3.1 Recommendation Patterns

| Signal Claude reads | Example output |
|---|---|
| Genre × WPM delta | *"You read thrillers 40% faster than literary fiction — want a fast-paced read for your weekend?"* |
| Available time slot | *"You have a 35-min commute; here are 3 short-story collections at your morning pace."* |
| Completion likelihood | *"At 380 pages, this is in your sweet spot — you finish 82% of books between 300–400 pages."* |
| Stall recovery | *"You stalled on Pachinko at 24%. Readers with your pattern usually re-enter at chapter 8 — want a recap?"* |
| Mood inference | *"Your last 3 sessions were tagged 🤯. A lighter book up next?"* |
| Pace progression | *"Your non-fiction WPM is up 18% this quarter — ready for something denser?"* |

### 3.2 AI Surfaces in the Product
- **Today → Coach Card:** daily nudges (see §1.4).
- **Library → For You feed:** ranked candidates with one-line "Why this?" rationale.
- **Library → Ask Claude search:** conversational queries; results are real books from the metadata DB, not hallucinated.
- **Shelves → Smart shelves:** auto-generated collections.
- **Profile → Reader Persona (weekly):** "Your reader DNA this week: methodical non-fiction reader, peak hours 8–10pm, prefers ≤300pp."
- **Book detail page → "How this fits you":** personalized blurb estimating time-to-finish, pace match, and warnings ("readers like you stall around p.150").

### 3.3 Trust & Control
- A single **Claude Settings** screen: toggle each AI surface independently; export or wipe the Reader Profile.
- Every recommendation cites the signals it used ("Based on: WPM, recent moods, your Want-to-Read shelf").
- No training on private shelves or DM content. Explicit copy on this in onboarding.

---

## Feature Matrix (At-a-Glance)

| Capability | Daily Habit | Library Discovery |
|---|---|---|
| Real-time timer | ✅ primary | — |
| WPM tracking | ✅ display | ✅ feeds recs |
| Streaks + freezes | ✅ | — |
| Daily goal ring | ✅ | — |
| Current book card | ✅ | — |
| Coach card / nudges | ✅ | — |
| Mood tagging | ✅ session-level | ✅ aggregated |
| Book metadata DB | — | ✅ |
| User shelves | quick add | ✅ primary |
| Smart (AI) shelves | — | ✅ |
| Social reviews | — | ✅ |
| Friend feed | — | ✅ |
| Reading buddies | session sync | ✅ matching |
| Ask Claude search | global | ✅ primary |
| For You feed | — | ✅ |
| Reader Persona | weekly recap | profile page |
| Annual goals | progress ring | setup + leaderboards |

---

## MVP Slicing

**V1 — Habit Core + Metadata + AI Recs**
- Timer, WPM, streaks, daily goal, current book, weekly recap.
- Book DB ingest (OpenLibrary), default shelves, custom shelves (private only).
- Coach card + For You + Ask Claude search.

**V2 — Social Layer**
- Reviews, friend graph, friend feed, public shelves, reading buddies.

**V3 — Advanced AI + Challenges**
- Smart shelves, Reader Persona reports, stall-recovery flows, custom challenges, collaborative shelves.

---

## Verification (How to validate this spec)

1. **Concept test with 5 habit-builders + 5 social readers:** show the two-view IA, measure which features each cohort considers "must-have" vs "nice-to-have." Goal: ≥80% of must-haves are in V1 for both cohorts.
2. **Wizard-of-Oz the Coach Card:** hand-author 7 days of nudges from real Bookly-style data; measure tap-through and dismissal rates. Target: >30% engagement on day 7.
3. **AI rec preference test:** A/B Claude-generated recs (with timer data) vs Goodreads-style "readers also liked." Target: ≥1.5x add-to-shelf rate.
4. **Privacy comprehension check:** after onboarding, can users correctly answer "What does Claude see?" Target: 90%.

---

## Open Questions

1. **Platform priority:** mobile-first (iOS/Android), web, or both at launch?
2. **Monetization model:** freemium (AI features paid), subscription, or ad-supported? Affects whether Smart shelves and Reader Persona sit behind a paywall.
3. **Audiobook scope in V1:** include or defer to V2?
4. **Metadata source-of-truth:** OpenLibrary + Google Books for V1, or also license a commercial feed (Bowker)?
