"""Tournament draws (Auslosungen) from dbv.turnier.de.

Two callables back the tournament page's "Draw" tab:

* get_tournament_draws — the draw list (sport/draws.aspx): one row per draw
  with its size, format ("Spielschema") and stage. A tournament with no rows
  hasn't published its draw yet.
* get_tournament_draw — one draw (sport/draw.aspx). Knockout formats
  ("KO-System", "Spielsystem") are parsed into rounds of slots; other formats
  (round robin "Gruppensystem", "Swiss Ladder") load their content through
  extra XHR endpoints and are returned as kind="other" so the page can link
  out to dbv instead.

Bracket markup (verified against a live 16-player "Spielsystem" draw,
2026-11-23): a single <div class="draw"><table>, header row = round names
("1 e Runde", "Viertelfinale", ..., "Gewinner"). Every bracket slot is a cell
holding <span id="N" class="entry|match">, where N = level*1000 + index:
the top level is the first round (entries), level 1 is the winner. A level
with L levels below it has `size / 2**(top-level)` main-draw slots — a
"Spielsystem" table also carries placement-match slots beyond those, which
are ignored here. A match's score (<span class="score"><span>21-11</span>..)
sits in the same column, below the slot of the player it advanced. "Rast"
marks a bye. Seeds are a "[n]" suffix on the player link text.
"""

import re
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup
from firebase_functions import https_fn

from app.core.auth import rate_key
from app.core.cache_config import TOURNAMENT_DRAW_TTL, TOURNAMENT_DRAWS_TTL
from app.core.common import BASE, COOKIES, HEADERS
from app.core.firebase_app import db
from app.core.rate_limiting import check_rate_limit

# Bump when the draw parsers change what they can read: cached draws written
# by an older version are re-fetched instead of served (see _fetch_draw).
# 2 = newer GetDrawContent bracket layout supported.
# 3 = placement brackets (Spielsystem / Ranglistensystem) + club column by header.
# 4 = round robin + Swiss ladder (standings + match list).
DRAW_PARSER_VERSION = 4

ROUND_LABELS = {
    "gewinner": "Winner", "finale": "Final", "halbfinale": "Semi-final",
    "viertelfinale": "Quarter-final", "achtelfinale": "Round of 16",
    # newer bracket layout (already English)
    "quarter final": "Quarter-final", "semi final": "Semi-final", "winner": "Winner",
}


def _gid(raw):
    m = re.search(r"([0-9A-Fa-f-]{36})", raw or "")
    return m.group(1).upper() if m else ""


def _round_label(text):
    t = re.sub(r"\s+", " ", (text or "").replace("\xa0", " ")).strip()
    low = t.lower()
    if low in ROUND_LABELS:
        return ROUND_LABELS[low]
    m = re.match(r"(\d+)\s*e?\.?\s*runde", low)
    if m:
        return f"Round {m.group(1)}"
    return t


def _draw_kind(fmt):
    f = (fmt or "").lower()
    # "Spielsystem" and "Ranglistensystem 16/5" are knockouts that also play
    # off the lower places (placement brackets in the same table).
    if "ko" in f or f.startswith("spielsystem") or f.startswith("ranglistensystem") or "elimination" in f:
        return "ko"
    if "gruppe" in f or "round robin" in f:
        return "group"
    if "swiss" in f:
        return "swiss"
    return "other"


def _parse_draws_list(html):
    soup = BeautifulSoup(html, "html.parser")
    draws = []
    for td in soup.select("td.drawname"):
        a = td.find("a", href=re.compile(r"draw\.aspx\?.*draw=\d+", re.I))
        if not a:
            continue
        m = re.search(r"draw=(\d+)", a["href"])
        cells = [c.get_text(" ", strip=True) for c in td.find_parent("tr").find_all("td")]
        size = int(cells[1]) if len(cells) > 1 and cells[1].isdigit() else None
        fmt = cells[2] if len(cells) > 2 else ""
        draws.append({
            "draw": m.group(1),
            "name": a.get_text(" ", strip=True),
            "size": size,
            "format": fmt,
            "stage": cells[3] if len(cells) > 3 else "",
            "kind": _draw_kind(fmt),
        })
    return draws


def _slot_players(td):
    players = []
    for a in td.find_all("a", href=re.compile(r"player\.aspx", re.I)):
        name = a.get_text(" ", strip=True)
        seed = None
        sm = re.search(r"\s*\[([^\]]+)\]\s*$", name)
        if sm:
            seed = sm.group(1)
            name = name[:sm.start()].strip()
        pm = re.search(r"player=(\d+)", a["href"])
        players.append({"name": name, "seed": seed, "tpid": pm.group(1) if pm else None})
    return players


def _parse_ko_draw(html):
    """Return {rounds: [label..], size, slots: [[slot..] per round],
    placements: [block..]} or None.

    Round 0 holds the entries; the last round is the winner. A slot is
    {players, seed, club, bye, score} — players empty and bye False means
    "not decided yet".

    Placement brackets ("Spielsystem", "Ranglistensystem": every place is
    played off — verified on GD Vb A of draw CDEAADCA…/14, 2026-11-24) live in
    the same table, as slot ids past the main bracket's 2**(level-1) per
    level. Within a level, ids pair up (2m-1, 2m) as a match; its winner sits
    one column to the right, on a row between the two. Losers dropping in
    from the main bracket simply have no feeding pair. Each block's final is
    a level-1 slot whose index is the place its winner takes (1003 = 3rd,
    1005 = 5th, ...). Place-range labels ("3-4", "9-12") sit in a cell on or
    just above a block's first row; not every block has one.
    """
    soup = BeautifulSoup(html, "html.parser")
    div = soup.find("div", class_="draw")
    table = div.find("table") if div else None
    if not table:
        return None
    head = table.find("thead")
    head_cells = [td.get_text(" ", strip=True) for td in head.find_all("td")] if head else []
    club_col = next((i for i, h in enumerate(head_cells) if h.lower() in ("verein", "club")), None)

    found = {}            # slot id -> slot dict
    pos = {}              # slot id -> (row, col) in the table
    place_labels = []     # (row, col, text) of "3-4" / "9-12" cells
    last_in_col = {}      # column index -> slot id last seen in that column
    body = table.find("tbody") or table
    for ri, tr in enumerate(body.find_all("tr")):
        tds = tr.find_all("td")
        for ci, td in enumerate(tds):
            span = td.find("span", id=re.compile(r"^\d+$"), class_=re.compile(r"\b(entry|match)\b"))
            if span:
                sid = int(span["id"])
                players = _slot_players(td)
                text = td.get_text(" ", strip=True)
                club = ""
                if "entry" in span.get("class", []):
                    # The club column is found by its header ("Verein") — some
                    # draws add a "Verband" column between it and the names.
                    # Doubles list one club per player; keep each club once.
                    src = tds[club_col] if club_col is not None and club_col < len(tds) else (tds[ci - 1] if ci >= 1 else None)
                    club = " / ".join(dict.fromkeys(src.stripped_strings)) if src is not None else ""
                found[sid] = {
                    "players": players,
                    "seed": next((p["seed"] for p in players if p["seed"]), None),
                    "club": club,
                    "bye": not players and bool(re.search(r"\b(rast|bye|freilos)\b", text, re.I)),
                    "score": [],
                }
                pos[sid] = (ri, ci)
                last_in_col[ci] = sid
                continue
            score = td.find("span", class_="score")
            txt = td.get_text(" ", strip=True)
            if score is not None and ci in last_in_col:
                found[last_in_col[ci]]["score"] = [s.get_text(" ", strip=True) for s in score.find_all("span")] \
                    or [score.get_text(" ", strip=True)]
            elif re.fullmatch(r"\d+\s*-\s*\d+", txt) and ci not in (0, club_col):
                place_labels.append((ri, ci, re.sub(r"\s+", "", txt)))
            elif ci in last_in_col and not found[last_in_col[ci]]["score"]:
                if re.search(r"\b(w\.?\s?o\.?|walkover|aufgabe|retired|n\.?\s?a\.?)\b", txt, re.I):
                    found[last_in_col[ci]]["score"] = [txt]

    if not found:
        return None
    top = max(sid // 1000 for sid in found)
    rounds = []
    for level in range(top, 0, -1):
        count = 2 ** (level - 1)
        rounds.append([found.get(level * 1000 + i + 1) or {"players": [], "seed": None, "club": "", "bye": False, "score": []}
                       for i in range(count)])
    size = len(rounds[0])
    labels = [_round_label(h) for h in head_cells[-len(rounds):]] if len(head_cells) >= len(rounds) else []
    if len(labels) != len(rounds):
        labels = [f"Round {i + 1}" for i in range(len(rounds) - 1)] + ["Winner"]
    return {"rounds": labels, "size": size, "slots": rounds,
            "placements": _placement_blocks(found, pos, place_labels)}


def _placement_blocks(found, pos, place_labels):
    """Group the slots past the main bracket into placement brackets.

    Returns [{title, place, rows, cols, slots: [{id, level, row, col,
    parent, players, seed, club, bye, score}]}], rows/cols relative to the
    block, sorted by place. `parent` is the slot id the match feeding from
    this slot advances into (None for a block's final)."""
    extra = [sid for sid in found if sid % 1000 > 2 ** (sid // 1000 - 1)]
    if not extra:
        return []
    extra_set = set(extra)
    parent = {}
    for sid in extra:
        level, idx = divmod(sid, 1000)
        if idx % 2 == 0:
            continue
        mate = sid + 1
        if mate not in extra_set:
            continue
        (r1, c), (r2, _) = pos[sid], pos[mate]
        lo, hi = min(r1, r2), max(r1, r2)
        cands = [p for p in extra if p // 1000 == level - 1 and pos[p][1] == c + 1 and lo < pos[p][0] < hi]
        if cands:
            parent[sid] = parent[mate] = cands[0]

    # Connected components (child -> parent links) are the blocks.
    root = {sid: sid for sid in extra}
    def find(x):
        while root[x] != x:
            root[x] = root[root[x]]
            x = root[x]
        return x
    for child, par in parent.items():
        root[find(child)] = find(par)
    groups = {}
    for sid in extra:
        groups.setdefault(find(sid), []).append(sid)

    blocks, used_labels = [], set()
    for sids in groups.values():
        rows = [pos[s][0] for s in sids]
        cols = [pos[s][1] for s in sids]
        r0, c0 = min(rows), min(cols)
        finals = [s for s in sids if s // 1000 == 1]
        place = min(s % 1000 for s in finals) if finals else None
        label = next((t for (lr, lc, t) in sorted(place_labels, key=lambda x: -x[0])
                      if r0 - 2 <= lr <= r0 and (lr, lc) not in used_labels), None)
        if label:
            used_labels.update((lr, lc) for (lr, lc, t) in place_labels if t == label and r0 - 2 <= lr <= r0)
        if label:
            a, b = label.split("-")
            title = f"Places {a}–{b}"
        elif place:
            title = f"Places {place}–{place + 1}"
        else:
            title = "Placement matches"
        blocks.append({
            "title": title, "place": place or 999,
            "rows": max(rows) - r0 + 1, "cols": max(cols) - c0 + 1,
            "slots": [{"id": s, "level": s // 1000, "row": pos[s][0] - r0, "col": pos[s][1] - c0,
                       "parent": parent.get(s), **found[s]} for s in sorted(sids, key=lambda x: (pos[x][0], pos[x][1]))],
        })
    blocks.sort(key=lambda b: b["place"])
    return blocks


def _cache_get(collection, doc_id):
    if not db:
        return None
    try:
        snap = db.collection(collection).document(doc_id).get()
        if snap.exists:
            data = snap.to_dict()
            if datetime.now(timezone.utc) < data["expires_at"]:
                return data
    except Exception:
        pass
    return None


def _cache_set(collection, doc_id, data, ttl):
    if not db:
        return
    try:
        db.collection(collection).document(doc_id).set({**data, "expires_at": datetime.now(timezone.utc) + ttl})
    except Exception:
        pass


def _fetch_draws(gid, force=False):
    if not force:
        cached = _cache_get("tournament_draws_cache", gid)
        # Same parser-version check as _fetch_draw: the list's "kind" per draw
        # comes from _draw_kind, which learns new formats over time.
        if cached and cached.get("parser") == DRAW_PARSER_VERSION:
            return {"draws": cached["draws"], "fetched_at": cached.get("fetched_at", "")}
    session = requests.Session()
    session.cookies.update(COOKIES)
    resp = session.get(f"{BASE}/sport/draws.aspx?id={gid}", headers=HEADERS, timeout=20)
    resp.raise_for_status()
    draws = _parse_draws_list(resp.text)
    fetched_at = datetime.now(timezone.utc).isoformat()
    _cache_set("tournament_draws_cache", gid, {"draws": draws, "fetched_at": fetched_at, "parser": DRAW_PARSER_VERSION}, TOURNAMENT_DRAWS_TTL)
    return {"draws": draws, "fetched_at": fetched_at}


def _empty_slot():
    return {"players": [], "seed": None, "club": "", "bye": False, "score": []}


def _parse_bracket_content(html):
    """Parse the newer bracket layout (draw.aspx's GetDrawContent XHR,
    verified against NDEM U13-U19 2026 MX U19, 2026-11-24) into the same
    {rounds, size, slots} shape as _parse_ko_draw.

    Layout: <div class="bracket"> with one subheading per round ("Round of
    16", "Quarter final", ..., "Final") and one .bracket-round__item slide
    per round holding that round's .match cards. Each card has two
    .match__row entrants (the winner's row carries has-won; a bye is a row
    whose name is "Bye") and one <ul class="points"> per set, the first
    <li> being the first row's points. Later rounds list their entrants even
    before they're played, so round r's slots come from round r's own rows;
    the score of the match that produced a slot comes from round r-1.
    """
    soup = BeautifulSoup(html, "html.parser")
    root = soup.find(class_="bracket")
    if not root:
        return None
    labels = [_round_label(h.get_text(" ", strip=True)) for h in root.select(".swiper-bracket-header .subheading")]
    rounds = []
    for slide in root.select(".bracket-round__item"):
        matches = []
        for card in slide.select("div.match"):
            rows = []
            for row in card.select(".match__row")[:2]:
                players = []
                for a in row.select("a[href*='player.aspx']"):
                    name = a.get_text(" ", strip=True)
                    seed = None
                    sm = re.search(r"\s*\[([^\]]+)\]\s*$", name)
                    if sm:
                        seed = sm.group(1)
                        name = name[:sm.start()].strip()
                    pm = re.search(r"player=(\d+)", a.get("href", ""))
                    players.append({"name": name, "seed": seed, "tpid": a.get("data-player-id") or (pm.group(1) if pm else None)})
                clubs = [c.get_text(" ", strip=True).replace("\xa0", " ").strip() for c in row.select(".match__row-entrant-info-club")]
                title = row.select_one(".match__row-title")
                text = title.get_text(" ", strip=True) if title else ""
                rows.append({
                    "players": players,
                    "seed": next((p["seed"] for p in players if p["seed"]), None),
                    "club": " / ".join(c for c in dict.fromkeys(clubs) if c),
                    "bye": not players and bool(re.search(r"\b(bye|freilos|rast)\b", text, re.I)),
                    "won": "has-won" in (row.get("class") or []),
                })
            while len(rows) < 2:
                rows.append({**_empty_slot(), "won": False})
            sets = []
            for ul in card.select(".match__result ul.points"):
                cells = [li.get_text(" ", strip=True) for li in ul.select("li")]
                if len(cells) >= 2 and cells[0].isdigit() and cells[1].isdigit():
                    sets.append((int(cells[0]), int(cells[1])))
            matches.append({"rows": rows, "sets": sets})
        rounds.append(matches)
    if not rounds or not rounds[0]:
        return None
    for r in range(1, len(rounds)):
        if len(rounds[r]) * 2 != len(rounds[r - 1]):
            return None   # not a plain halving bracket (e.g. qualification stages) — let the page link out

    def as_slot(row):
        return {"players": row["players"], "seed": row["seed"], "club": row["club"], "bye": row["bye"], "score": []}

    def winner_score(match):
        """Set scores written winner-first, like the older table layout."""
        w = 0 if match["rows"][0]["won"] else 1 if match["rows"][1]["won"] else None
        if w is None:
            return None, []
        return w, [f"{a}-{b}" if w == 0 else f"{b}-{a}" for a, b in match["sets"]]

    slots = [[as_slot(row) for m in rounds[0] for row in m["rows"]]]
    for r in range(1, len(rounds)):
        row_slots = []
        for i, m in enumerate(rounds[r]):
            for k, row in enumerate(m["rows"]):
                slot = as_slot(row)
                _, score = winner_score(rounds[r - 1][2 * i + k])
                if slot["players"]:
                    slot["score"] = score
                row_slots.append(slot)
        slots.append(row_slots)
    final = rounds[-1][0]
    w, score = winner_score(final)
    slots.append([{**as_slot(final["rows"][w]), "score": score} if w is not None else _empty_slot()])
    if len(labels) == len(rounds):
        labels = labels + ["Winner"]
    elif len(labels) != len(slots):
        labels = [f"Round {i + 1}" for i in range(len(slots) - 1)] + ["Winner"]
    return {"rounds": labels, "size": len(slots[0]), "slots": slots}


STANDING_COLUMNS = {   # short header -> English title shown on the page
    "Pl": "Played", "W": "Won", "D": "Drawn", "L": "Lost", "M": "Matches",
    "B": "Buchholz", "Gm": "Games", "Points": "Rally points", "Pts": "Points",
}


def _entrant_players(node):
    """Player links inside a standings row / match row -> [{name, seed, tpid}]."""
    players = []
    for a in node.select("a[href*='layer']"):
        name = a.get_text(" ", strip=True)
        if not name:
            continue
        seed = None
        sm = re.search(r"\s*\[([^\]]+)\]\s*$", name)
        if sm:
            seed = sm.group(1)
            name = name[:sm.start()].strip()
        pm = re.search(r"(?:player=|/Player/)(\d+)", a.get("href", ""), re.I)
        players.append({"name": name, "seed": seed, "tpid": a.get("data-player-id") or (pm.group(1) if pm else None)})
    return players


def _parse_standings(html):
    """GetStandings XHR (round robin + Swiss ladder; verified on HOLZLAND
    MASTERS VII HD A and HE C, 2026-11-24) -> {columns: [{key, title}],
    groups: [{rows: [{rank, players, seed, club, values: {key: text}, form}]}]}.

    One <table> per group. The first column holds the rank and the
    entrant's club(s), the second the player links; the remaining columns
    are identified by their header text (Pl, W, D, L, M, B, Gm, Points, Pts,
    History), which differs between formats — Swiss adds B (Buchholz)."""
    soup = BeautifulSoup(html, "html.parser")
    columns, groups = [], []
    for table in soup.find_all("table"):
        heads = [th.get_text(" ", strip=True) for th in table.select("thead th")]
        if not heads:
            continue
        keys = [h for h in heads]
        rows = []
        for tr in table.select("tbody tr"):
            tds = tr.find_all("td")
            if len(tds) < 2:
                continue
            rank_el = tds[0].select_one(".standing-status")
            clubs = [c.get_text(" ", strip=True) for c in tds[0].select(".entrant-info-club")]
            players = _entrant_players(tds[1])
            values, form = {}, []
            for k, td in zip(keys[2:], tds[2:]):
                if k == "History":
                    form = [t.get_text(strip=True) for t in td.select(".match__status")]
                elif k:
                    values[k] = re.sub(r"\s+", " ", td.get_text(" ", strip=True))
            rows.append({
                "rank": rank_el.get_text(strip=True) if rank_el else "",
                "players": players,
                "seed": next((p["seed"] for p in players if p["seed"]), None),
                "club": " / ".join(c for c in dict.fromkeys(clubs) if c),
                "values": values, "form": form,
            })
        if rows:
            groups.append({"rows": rows})
            if not columns:
                columns = [{"key": k, "title": STANDING_COLUMNS.get(k, k)} for k in keys[2:] if k and k != "History"]
    return {"columns": columns, "groups": groups}


def _parse_match_list(html):
    """GetMatchesContent XHR -> [{round, date, rows: [{players, seed, won}],
    sets: ["21-15", ...] (first row's points first), message}]. Same match
    card markup as the newer bracket layout, plus a header with the round
    name and an optional status tag (walkover, retired, ...)."""
    soup = BeautifulSoup(html, "html.parser")
    out = []
    current_date = ""
    for node in soup.select("h4.module-divider, div.match"):
        if node.name == "h4":
            current_date = node.get_text(" ", strip=True)
            continue
        head = node.select_one(".match__header-title")
        rows = []
        for row in node.select(".match__row")[:2]:
            players = _entrant_players(row)
            rows.append({"players": players,
                         "seed": next((p["seed"] for p in players if p["seed"]), None),
                         "won": "has-won" in (row.get("class") or [])})
        if len(rows) < 2:
            continue
        sets = []
        for ul in node.select(".match__result ul.points"):
            cells = [li.get_text(" ", strip=True) for li in ul.select("li")]
            if len(cells) >= 2 and cells[0].isdigit() and cells[1].isdigit():
                sets.append(f"{cells[0]}-{cells[1]}")
        msg = node.select_one(".match__message")
        when = node.select_one(".match__footer .nav-link__value")
        out.append({
            "round": head.get_text(" ", strip=True) if head else "",
            "date": (when.get_text(" ", strip=True) if when else "") or current_date,
            "rows": rows, "sets": sets,
            "message": msg.get_text(" ", strip=True) if msg else "",
        })
    return out


def _fetch_draw(gid, draw, force=False):
    key = f"{gid}_{draw}"
    if not force:
        cached = _cache_get("tournament_draw_cache", key)
        # A doc written by an older parser counts as stale — otherwise a draw
        # that parser couldn't read stays "other" until the TTL runs out.
        if cached and cached.get("parser") == DRAW_PARSER_VERSION:
            return {k: v for k, v in cached.items() if k not in ("expires_at", "parser")}
    session = requests.Session()
    session.cookies.update(COOKIES)
    resp = session.get(f"{BASE}/sport/draw.aspx?id={gid}&draw={draw}", headers=HEADERS, timeout=20)
    resp.raise_for_status()
    parsed = _parse_ko_draw(resp.text)
    if not parsed:
        # Newer tournaments render the bracket client-side: the page only
        # carries a form pointing at /tournament/<gid>/Draw/<n>/GetDrawContent,
        # an XHR endpoint (group draws point at GetStandings instead).
        m = re.search(r'action="(/tournament/[0-9a-fA-F-]{36}/Draw/\d+/GetDrawContent[^"]*)"', resp.text)
        if m:
            xhr = session.get(BASE + m.group(1).replace("&amp;", "&"), timeout=20, headers={
                **HEADERS, "X-Requested-With": "XMLHttpRequest",
                "Referer": f"{BASE}/sport/draw.aspx?id={gid}&draw={draw}"})
            xhr.raise_for_status()
            parsed = _parse_bracket_content(xhr.text)
    out = {"draw": draw, "kind": "ko" if parsed else "other",
           "url": f"{BASE}/sport/draw.aspx?id={gid}&draw={draw}",
           "fetched_at": datetime.now(timezone.utc).isoformat()}
    if parsed:
        # Firestore can't store nested arrays (a list of lists) — keep each
        # round as a map entry instead and rebuild the list on the client.
        out.update({"round_labels": parsed["rounds"], "size": parsed["size"],
                    "rounds": [{"slots": r} for r in parsed["slots"]],
                    "placements": parsed.get("placements", [])})
    else:
        # Round robin ("Gruppensystem") and Swiss ladder draws load a
        # standings table and a match list through two XHR endpoints.
        ref = f"{BASE}/sport/draw.aspx?id={gid}&draw={draw}"
        xhr_headers = {**HEADERS, "X-Requested-With": "XMLHttpRequest", "Referer": ref}
        st = re.search(r'action="(/tournament/[0-9a-fA-F-]{36}/Draw/\d+/GetStandings[^"]*)"', resp.text)
        mt = re.search(r'action="(/tournament/[0-9a-fA-F-]{36}/Draw/\d+/GetMatchesContent[^"]*)"', resp.text)
        if st or mt:
            standings = {"columns": [], "groups": []}
            matches = []
            if st:
                r = session.get(BASE + st.group(1).replace("&amp;", "&"), headers=xhr_headers, timeout=20)
                r.raise_for_status()
                standings = _parse_standings(r.text)
            if mt:
                r = session.get(BASE + mt.group(1).replace("&amp;", "&"), headers=xhr_headers, timeout=20)
                r.raise_for_status()
                matches = _parse_match_list(r.text)
            # The draw page's format tag says "Round Robin" or "Swiss Ladder".
            tags = " ".join(t.get_text(" ", strip=True) for t in BeautifulSoup(resp.text, "html.parser").select(".media__content-subinfo .tag")).lower()
            swiss = "swiss" in tags
            out.update({"kind": "swiss" if swiss else "group", "standings": standings, "matches": matches})
    _cache_set("tournament_draw_cache", key, {**out, "parser": DRAW_PARSER_VERSION}, TOURNAMENT_DRAW_TTL)
    return out


@https_fn.on_call()
def get_tournament_draws(req: https_fn.CallableRequest) -> dict:
    """List a tournament's draws: [{draw, name, size, format, stage, kind}]."""
    try:
        data = req.data or {}
        gid = _gid(data.get("id", ""))
        if not gid:
            return {"error": "Missing or invalid tournament id"}
        force = bool(data.get("force"))
        if force and not check_rate_limit(rate_key(req), "force_draws", 20, 3600000):
            return {"error": "Live update limit reached. Please wait before refreshing again."}
        return _fetch_draws(gid, force=force)
    except Exception as e:
        import traceback
        print(f"get_tournament_draws error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}


@https_fn.on_call()
def get_tournament_draw(req: https_fn.CallableRequest) -> dict:
    """One draw. kind="ko": {round_labels, size, rounds: [{slots: [slot]}]};
    kind="other": only {url} — the page links to dbv for that format."""
    try:
        data = req.data or {}
        gid = _gid(data.get("id", ""))
        draw = str(data.get("draw", "")).strip()
        if not gid or not draw.isdigit():
            return {"error": "Missing or invalid tournament id / draw"}
        force = bool(data.get("force"))
        if force and not check_rate_limit(rate_key(req), "force_draw", 30, 3600000):
            return {"error": "Live update limit reached. Please wait before refreshing again."}
        return _fetch_draw(gid, draw, force=force)
    except Exception as e:
        import traceback
        print(f"get_tournament_draw error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}
