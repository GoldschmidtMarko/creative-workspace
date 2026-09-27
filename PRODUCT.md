# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Competitive and recreational badminton players, coaches, and club members in Germany (and the wider DBV/badminton-bax.de ecosystem) who want to scout an upcoming tournament's field, check a specific player's rating history and win/loss record, or track a club's team-league standing over a season. Used both ahead of a tournament (scouting opponents) and casually (checking one's own or a rival's history).

## Product Purpose

BAX Checker scrapes German badminton tournament and league data (dbv.turnier.de, badminton-bax.de) that is otherwise scattered across clunky, non-analytical official pages, and computes/presents BAX ratings, player history, relative standing, titles/finals, win/loss, and club/team league rankings over time, with Firestore-backed caching so repeat lookups are fast.

## Positioning

An unofficial analytical layer over the official-but-purely-transactional DBV tournament system — the federation's own site lists results, BAX Checker turns that into ratings, trends, and comparisons a player or scout would otherwise have to reconstruct by hand across multiple pages.

## Operating Context

Static multi-page frontend (no SPA router, callable Firebase SDK, hand-rolled inline-SVG charts — no charting library) backed by Python Cloud Functions and Firestore. Real usage is both mobile (checking a result at the court) and desktop (deeper scouting/analysis before a tournament). Current pages: home/dashboard, tournament list + single tournament, player profile, club, team, compare, network, encounter.

## Capabilities and Constraints

Data is scraped live from dbv.turnier.de / badminton-bax.de and cached in Firestore; scraping is rate-limit-sensitive (see project testing rules) so the UI must tolerate cache-first, sometimes-stale data. No charting library is in use today — visualizations are hand-rolled inline SVG. Auth is Google sign-in (optional; used for favorites/usage). Light/dark themes are both supported today and must remain supported.

## Brand Commitments

None fixed — the user is open to changing name, logo, and color system if a new direction calls for it. Current name "BAX Checker," current domain is **baxcheck.de** (noted by the user as background only, not a constraint).

## Evidence on Hand

Existing incumbent implementation at `public/html/*.html` + `public/styles/*.css` (teal/violet accent system, Inter typeface, card-based layout) — treated as anti-reference evidence for this redesign, not a constraint to preserve. No other brand assets, testimonials, or marketing copy exist.

## Product Principles

- Scouting is time-pressured — before a tournament, information density and scan speed matter more than decoration.
- Data can be stale (cache-first); the UI should never imply false precision or hide that a number is a rating/estimate, not an official score.
- Two audiences in one product: quick mobile lookups courtside, and deeper desktop analysis — both must stay first-class.
- Light and dark themes are both real usage, not a toggle for show.
