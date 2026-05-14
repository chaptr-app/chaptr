# Chaptr

**AI-first reading app — Goodreads' depth, Bookly's habit loop, Claude's intelligence.**

Chaptr turns the most undervalued behavioral signal in reading — **time spent on the page** — into smarter recommendations, better habits, and a richer social layer. Where Goodreads asks you what you *liked* and Bookly tracks how long you *read*, Chaptr does both and lets Claude connect the dots.

## The Core Idea

> "I see you read thrillers 40% faster than literary fiction.
> You've got 90 minutes this weekend — want a fast-paced one?"

Every star rating, shelf, and review on Chaptr is grounded in real reading-time data, not declared preference.

## Two Views, One Loop

| View | Purpose | Inspired by |
|---|---|---|
| **Daily Habit** (`Today`) | Timer, streaks, WPM, daily goal, Claude's coach nudge | Bookly |
| **Library Discovery** (`Library`) | Metadata DB, shelves, reviews, social feed, AI recs | Goodreads |

Claude is an **ambient companion** across both — a dismissible coach card on Today, an "Ask Claude" search bar on Library, and a global chat sheet. Never modal, always opt-in.

## Status

🟡 **V0 — Product spec.** No code yet. The full PRD lives at [`docs/PRD.md`](docs/PRD.md).

## Roadmap

- **V1 — Habit core + AI recs:** timer, WPM, streaks, OpenLibrary ingest, private shelves, Coach card, For You feed, Ask Claude search.
- **V2 — Social layer:** reviews, friend graph, public shelves, reading buddies.
- **V3 — Advanced AI:** Smart shelves, weekly Reader Persona, stall-recovery flows, collaborative shelves and challenges.

## License

TBD (MIT suggested).
