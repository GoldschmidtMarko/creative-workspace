// "Draw" tab of the tournament page: the published bracket from dbv with BAX
// on every line. Played matches show their score (and are flagged as an
// upset when the lower-rated side won); unplayed matches show who BAX
// favours, carried forward round by round in grey. Clicking a team draws its
// likely path in court green and lists it in the side panel.
//
// The bracket structure comes from get_tournament_draw(s) (functions/app/
// scraping/draws.py); the BAX values are the same per-discipline analysis
// the Ranking tab runs (passed in through ctx.playersFor).
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions } from "./util/firebase.js";

const getDraws = httpsCallable(functions, "get_tournament_draws", { timeout: 60000 });
const getDraw = httpsCallable(functions, "get_tournament_draw", { timeout: 60000 });

const CLOSE = 15;      // BAX gap under which a match is marked "close"
const UPSET_MIN = 5;   // a win by the side this many BAX lower counts as an upset
// A walkover / retirement isn't a played result, so it's never an upset.
const wasPlayed = (score) => !(score || []).some((x) => /walk\s*over|w\.?\s?o\.?|aufgabe|retired|n\.?\s?a\.?|kampflos/i.test(x));

export function createDrawTab(ctx) {
    const { tournamentId, escapeHtml, disciplineToFilter, playerLinkAttrs } = ctx;
    const body = document.getElementById("draw-body");
    const tag = document.getElementById("draw-tag");
    const state = { draws: null, error: null, drawCache: new Map(), drawId: null, sel: null, pred: true, animate: false };

    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9äöüß]+/g, "");
    const normName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

    /* ---------- data ---------- */
    async function loadList(force = false) {
        try {
            const res = await getDraws({ id: tournamentId, force });
            if (res.data.error) throw new Error(res.data.error);
            state.draws = res.data.draws || [];
            state.error = null;
        } catch (err) {
            console.error("Failed to load draws:", err);
            state.draws = state.draws || [];
            state.error = err.message;
        }
        tag.hidden = false;
        tag.textContent = state.draws.length ? "Published" : "Not out yet";
        tag.classList.toggle("mini-tag--open", state.draws.length > 0);
        return state.draws;
    }
    async function loadDraw(id, force = false) {
        if (!force && state.drawCache.has(id)) return state.drawCache.get(id);
        const res = await getDraw({ id: tournamentId, draw: id, force });
        if (res.data.error) throw new Error(res.data.error);
        state.drawCache.set(id, res.data);
        return res.data;
    }

    // Draw names follow the event name, with a suffix for split draws
    // ("DD B - Gruppe A", "DD B - Position 1-2").
    function drawsForEvent(disc) {
        if (!disc || !state.draws) return [];
        const ev = norm(disc.name);
        const exact = state.draws.filter((d) => norm(d.name.split(" - ")[0]) === ev);
        if (exact.length) return exact;
        return state.draws.filter((d) => norm(d.name).startsWith(ev) || ev.startsWith(norm(d.name.split(" - ")[0])));
    }

    /* ---------- model: entries + results + BAX predictions ---------- */
    // Entry (slot / standings row / match row) -> team with its BAX value,
    // looked up by name in the discipline's BAX analysis.
    function teamFactory(disc) {
        const key = disciplineToFilter(disc ? disc.name : "");
        const players = (disc && ctx.playersFor(disc)) || [];
        const byName = new Map(players.map((p) => [normName(p.full_name), p]));
        const valueOf = (rows) => {
            if (!rows.length || rows.some((r) => !r)) return null;
            if (key !== "all" && rows.some((r) => !r[key])) return null;
            const r = rows[0];
            if (key === "all") return Math.round((r.Sum_Einzel || 0) + (r.Sum_Doppel || 0) + (r.Sum_Mixed || 0)) || null;
            const v = r[`Sum_${key}`];
            return v ? Math.round(v) : null;
        };
        const team = (slot) => {
            if (!slot || slot.bye) return { bye: !!(slot && slot.bye), empty: !slot || !slot.bye };
            if (!slot.players || !slot.players.length) return { empty: true };
            const rows = slot.players.map((p) => byName.get(normName(p.name)) || null);
            return { key: slot.players.map((p) => p.name).join("|"), players: slot.players, rows, seed: slot.seed, club: slot.club || "", value: valueOf(rows) };
        };
        return { team, hasBax: players.length > 0 };
    }

    /* ---------- round robin / Swiss ladder: standings + matches ---------- */
    function buildTable(draw, disc) {
        const { team, hasBax } = teamFactory(disc);
        const groups = ((draw.standings && draw.standings.groups) || []).map((g) => {
            const rows = g.rows.map((r) => ({ ...r, t: team({ players: r.players, seed: r.seed, club: r.club }) }));
            const byBax = rows.filter((r) => r.t.value != null).sort((a, b) => b.t.value - a.t.value);
            rows.forEach((r) => {
                const exp = byBax.indexOf(r) + 1, rank = parseInt(r.rank, 10);
                r.baxRank = exp || null;
                r.vsBax = exp && rank ? exp - rank : null;   // > 0: finished above its BAX rank
            });
            return { rows };
        });
        const matches = (draw.matches || []).map((m) => {
            const a = team(m.rows[0]), b = team(m.rows[1]);
            const winner = m.rows[0].won ? a : m.rows[1].won ? b : null;
            const cancelled = /abgesagt|cancel/i.test(m.message || "");
            const played = !!winner && !cancelled;
            const out = { ...m, a, b, winner, played, cancelled, margin: null, upset: false, pred: null };
            if (a.value != null && b.value != null) out.margin = Math.abs(a.value - b.value);
            if (played && out.margin != null) {
                const loser = winner === a ? b : a;
                out.upset = wasPlayed([m.message || ""]) && loser.value - winner.value >= UPSET_MIN;
            } else if (!played && !cancelled && out.margin != null) out.pred = a.value >= b.value ? a : b;
            return out;
        });
        const rows = groups.flatMap((g) => g.rows);
        const columns = (draw.standings && draw.standings.columns) || [];
        return { groups, rows, matches, columns, hasBax, ranked: rows.map((r) => r.t).filter((t) => t.key).sort((x, y) => (y.value ?? -1) - (x.value ?? -1)) };
    }

    function tableHtml(model, meta) {
        const col = (k) => model.columns.some((c) => c.key === k);
        const swiss = meta.kind === "swiss";
        const formPill = (f) => `<span class="dt-form dt-form--${f === "W" ? "w" : f === "L" ? "l" : "d"}">${escapeHtml(f)}</span>`;
        const rowsHtml = (g) => g.rows.map((r) => {
            const t = r.t, v = r.values;
            const vs = r.vsBax == null ? "" : r.vsBax > 0 ? `<span class="dt-up">+${r.vsBax}</span>` : r.vsBax < 0 ? `<span class="dt-down">${r.vsBax}</span>` : `<span class="dr-dim">±0</span>`;
            return `<tr class="${t.key === state.sel ? "is-sel" : ""} ${isFav(t) ? "is-fav" : ""}" data-dsel="${escapeHtml(t.key || "")}" tabindex="0">
                <td><span class="rank-badge">${escapeHtml(r.rank)}</span></td>
                <td class="dt-team"><span class="dt-name">${escapeHtml(t.players ? full(t) : "")}</span>${r.club ? `<span class="dt-club">${escapeHtml(r.club)}</span>` : ""}</td>
                <td class="is-num">${t.value != null ? t.value : "–"}</td>
                <td class="is-num" title="Finishing place compared with BAX rank (${r.baxRank || "–"})">${vs}</td>
                <td class="is-num">${escapeHtml(v.W ?? "")}–${escapeHtml(v.L ?? "")}</td>
                ${col("Gm") ? `<td class="is-num">${escapeHtml(v.Gm || "")}</td>` : ""}
                ${swiss && col("B") ? `<td class="is-num">${escapeHtml(v.B || "")}</td>` : ""}
                <td class="is-num dt-pts">${escapeHtml(v.Pts ?? "")}</td>
                <td class="dt-formcol">${(r.form || []).map(formPill).join("")}</td>
            </tr>`;
        }).join("");
        const head = `<tr><th>#</th><th>${model.rows.some((r) => r.players.length > 1) ? "Team" : "Player"}</th><th class="is-num">BAX</th><th class="is-num" title="Finishing place compared with BAX rank">vs BAX</th><th class="is-num">W–L</th>${col("Gm") ? `<th class="is-num">Games</th>` : ""}${swiss && col("B") ? `<th class="is-num" title="Buchholz: the sum of your opponents' points">Buchholz</th>` : ""}<th class="is-num">Pts</th><th>Form</th></tr>`;
        return model.groups.map((g) => `<div class="dr-scroll"><table class="field-tbl dr-table"><thead>${head}</thead><tbody>${rowsHtml(g)}</tbody></table></div>`).join("");
    }

    function matchesHtml(model) {
        if (!model.matches.length) return "";
        const groups = new Map();
        // Round robin cards name their round. Swiss cards don't, but each
        // Swiss round starts at one time, so date + start time is the round.
        // An entry with no opponent is a Swiss bye.
        model.matches.forEach((m) => {
            m.bye = !m.a.key || !m.b.key;
            const when = /(\S+\s+)?(\d{2}\.\d{2}\.\d{4})(\s+\d{1,2}:\d{2})?/.exec(m.date || "");
            const k = m.bye ? "Byes" : m.round || (when ? `${(when[1] || "").trim()} ${when[2]}${when[3] ? "," + when[3] : ""}`.trim() : "Other matches");
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(m);
        });
        if (groups.has("Byes")) { const b = groups.get("Byes"); groups.delete("Byes"); groups.set("Byes", b); }
        const side = (t, won, lost) => `<span class="dm-side${won ? " is-won" : ""}${lost ? " is-lost" : ""}${t.key === state.sel ? " is-sel" : ""}" data-dsel="${escapeHtml(t.key || "")}"><span class="dm-name">${escapeHtml(t.players ? short(t) : "–")}</span>${t.value != null ? `<span class="bx">${t.value}</span>` : ""}</span>`;
        return `<section class="dr-card dr-places"><div class="dr-card__head"><h2>Matches</h2></div>${[...groups.entries()].map(([k, ms]) => `
            <div class="dr-pblock"><h3>${escapeHtml(k)}</h3><div class="dm-list">${ms.map((m) => {
                let mid;
                if (m.bye) mid = `<span class="dr-dim">Bye</span>`;
                else if (m.cancelled) mid = `<span class="dr-dim">Cancelled</span>`;
                else if (m.played) mid = `${m.sets.length ? `<span class="dr-sc">${m.sets.map(escapeHtml).join(" ")}</span>` : `<span class="dr-sc">${escapeHtml(m.message || "Walkover")}</span>`}${m.upset ? ' <span class="dr-up">Upset</span>' : ""}`;
                else if (state.pred && m.pred) mid = `<span class="${m.margin < CLOSE ? "is-close" : "dr-dim"}">${m.pred === m.a ? "◀" : ""} by ${m.margin}${m.margin < CLOSE ? ", close" : ""} ${m.pred === m.b ? "▶" : ""}</span>`;
                else mid = `<span class="dr-dim">Not played yet</span>`;
                return `<div class="dm-row">${side(m.a, m.played && m.winner === m.a, m.played && m.winner === m.b)}<span class="dm-mid">${mid}</span>${side(m.b, m.played && m.winner === m.b, m.played && m.winner === m.a)}</div>`;
            }).join("")}</div></div>`).join("")}</section>`;
    }

    function tableSideHtml(model) {
        const r = model.rows.find((x) => x.t.key === state.sel);
        const upsets = model.matches.filter((m) => m.upset);
        let panel = `<p class="dr-sub">Pick a team in the table.</p>`;
        if (r) {
            const t = r.t;
            const names = t.players.map((p, k) => t.rows[k] ? `<a class="player-link" ${playerLinkAttrs(t.rows[k])}>${escapeHtml(p.name)}</a>` : escapeHtml(p.name)).join("<br>");
            const mine = model.matches.filter((m) => m.a.key === t.key || m.b.key === t.key);
            const li = mine.map((m) => {
                const opp = m.a.key === t.key ? m.b : m.a;
                let em;
                if (m.cancelled) em = `<em class="dr-dim">Cancelled</em>`;
                else if (m.played) em = `<em class="${m.winner.key === t.key ? "is-good" : "is-bad"}">${m.winner.key === t.key ? "Won" : "Lost"}${m.sets.length ? " " + escapeHtml((m.a.key === t.key ? m.sets : m.sets.map((s) => s.split("-").reverse().join("-"))).join(" ")) : ""}${m.upset ? ", upset" : ""}</em>`;
                else if (m.margin != null) { const d = t.value - opp.value; em = `<em class="${d < CLOSE ? "is-bad" : "is-good"}">${d >= 0 ? `Favoured by ${d}` : `Behind by ${-d}`}</em>`; }
                else em = `<em class="dr-dim">Not played yet</em>`;
                return `<li><span>${escapeHtml(m.round || (m.date || "").replace(/^\w+\s+/, ""))}</span><span><b>${escapeHtml(opp.players ? short(opp) : "–")}</b>${opp.value != null ? ` <span class="dr-dim">${opp.value}</span>` : ""}${em}</span></li>`;
            }).join("");
            const total = model.rows.filter((x) => model.groups.find((g) => g.rows.includes(x)) === model.groups.find((g) => g.rows.includes(r))).length;
            panel = `<p class="dr-team">${names}</p>
                <p class="dr-sub">${t.club ? escapeHtml(t.club) + ". " : ""}${t.value != null ? `BAX ${t.value}, ${ordinal(r.baxRank)} in the group by BAX. ` : ""}<b class="dr-place">${r.rank ? `Place ${escapeHtml(r.rank)} of ${total}` : ""}</b>, ${escapeHtml(r.values.W ?? "0")} won, ${escapeHtml(r.values.L ?? "0")} lost.</p>
                ${li ? `<ol class="dr-steps">${li}</ol>` : ""}`;
        }
        return `<section class="dr-card dr-panel"><div class="dr-card__head"><h2>Selected</h2></div>${panel}</section>
            ${upsets.length ? `<section class="dr-card dr-panel"><div class="dr-card__head"><h2>Upsets</h2></div><ul class="dr-list">${upsets.map((m) => {
                const l = m.winner === m.a ? m.b : m.a;
                return `<li>${escapeHtml(short(m.winner))} beat ${escapeHtml(short(l))}, <b>${l.value - m.winner.value} BAX lower</b></li>`;
            }).join("")}</ul></section>` : ""}`;
    }

    function buildModel(draw, disc) {
        const key = disciplineToFilter(disc ? disc.name : "");
        const players = (disc && ctx.playersFor(disc)) || [];
        const byName = new Map(players.map((p) => [normName(p.full_name), p]));
        const valueOf = (rows) => {
            if (!rows.length || rows.some((r) => !r)) return null;
            // A 0 means badminton-bax.de has no rating for that player — treat
            // the whole entry as unknown rather than as the weakest in the draw.
            if (key !== "all" && rows.some((r) => !r[key])) return null;
            const r = rows[0];
            if (key === "all") return Math.round((r.Sum_Einzel || 0) + (r.Sum_Doppel || 0) + (r.Sum_Mixed || 0)) || null;
            const v = r[`Sum_${key}`];
            return v ? Math.round(v) : null;
        };
        const team = (slot) => {
            if (!slot || slot.bye) return { bye: !!(slot && slot.bye), empty: !slot || !slot.bye };
            if (!slot.players.length) return { empty: true };
            const rows = slot.players.map((p) => byName.get(normName(p.name)) || null);
            return {
                key: slot.players.map((p) => p.name).join("|"),
                players: slot.players, rows, seed: slot.seed, club: slot.club,
                value: valueOf(rows),
            };
        };
        const rounds = (draw.rounds || []).map((r) => r.slots);
        const view = [rounds[0].map((s) => ({ ...team(s), actual: true }))];
        const matches = [];   // matches[r][k]: pair (2k, 2k+1) of round r
        for (let r = 1; r < rounds.length; r++) {
            const row = [], mrow = [];
            for (let i = 0; i < rounds[r].length; i++) {
                const a = view[r - 1][2 * i], b = view[r - 1][2 * i + 1];
                const real = rounds[r][i];
                let cell;
                if (real && real.players.length) cell = { ...team(real), actual: true, score: real.score || [] };
                else if (a.bye && b.key) cell = { ...b, actual: b.actual, viaBye: true };
                else if (b.bye && a.key) cell = { ...a, actual: a.actual, viaBye: true };
                else if (a.bye && b.bye) cell = { bye: true };
                else if (a.key && b.key && a.value != null && b.value != null) cell = { ...(a.value >= b.value ? a : b), actual: false, pred: true };
                else cell = { empty: true };
                const m = { a, b, margin: null, upset: false, played: false };
                if (a.key && b.key) {
                    if (a.value != null && b.value != null) m.margin = Math.abs(a.value - b.value);
                    if (cell.actual && !cell.viaBye && cell.key) {
                        m.played = true;
                        const loser = cell.key === a.key ? b : a;
                        if (wasPlayed(cell.score) && cell.value != null && loser.value != null && loser.value - cell.value >= UPSET_MIN) m.upset = true;
                    }
                }
                row.push(cell); mrow.push(m);
            }
            view.push(row); matches.push(mrow);
        }
        const ranked = view[0].filter((t) => t.key).sort((x, y) => (y.value ?? -1) - (x.value ?? -1));
        return { view, matches, ranked, size: rounds[0].length, labels: draw.round_labels || [], hasBax: players.length > 0,
            places: buildPlacements(draw.placements || [], team) };
    }

    // Placement brackets (places 3–4, 5–8, ... in "Spielsystem" /
    // "Ranglistensystem" draws). Each block is laid out by its dbv table
    // row/column; a slot's `parent` is where the match it plays in advances.
    function buildPlacements(blocks, team) {
        return blocks.map((blk) => {
            const byId = new Map(blk.slots.map((s) => [s.id, { ...s, t: team(s) }]));
            const kids = new Map();
            blk.slots.forEach((s) => { if (s.parent != null) { if (!kids.has(s.parent)) kids.set(s.parent, []); kids.get(s.parent).push(byId.get(s.id)); } });
            const matches = [];
            kids.forEach((ch, pid) => {
                if (ch.length !== 2) return;
                const P = byId.get(pid), [A, B] = ch.sort((x, y) => x.row - y.row);
                const m = { P, A, B, a: A.t, b: B.t, margin: null, played: false, upset: false, pred: null };
                if (A.t.key && B.t.key) {
                    if (A.t.value != null && B.t.value != null) m.margin = Math.abs(A.t.value - B.t.value);
                    if (P.t.key) {
                        m.played = true;
                        const loser = P.t.key === A.t.key ? B.t : A.t;
                        if (wasPlayed(P.score) && P.t.value != null && loser.value != null && loser.value - P.t.value >= UPSET_MIN) m.upset = true;
                    } else if (m.margin != null) m.pred = A.t.value >= B.t.value ? A.t : B.t;
                }
                matches.push(m);
            });
            const final = blk.slots.find((s) => s.parent == null && s.level === 1);
            const F = final ? byId.get(final.id) : null;
            return { title: blk.title, place: blk.place, rows: blk.rows, cols: blk.cols, slots: [...byId.values()], matches,
                final: F, finalMatch: F ? matches.find((m) => m.P === F) : null };
        });
    }

    // Final place of a team, once it's decided: 1/2 from the main bracket,
    // k/k+1 from a placement block whose final decides place k.
    function finalPlace(model, key) {
        const last = model.view[model.view.length - 1][0];
        const finalists = model.view[model.view.length - 2] || [];
        if (last && last.actual && last.key) {
            if (last.key === key) return 1;
            if (finalists.some((t) => t.key === key)) return 2;
        }
        for (const b of model.places) {
            if (!b.final || !b.final.t.key || !b.place || b.place >= 999) continue;
            if (b.final.t.key === key) return b.place;
            if (b.finalMatch && b.finalMatch.played && (b.finalMatch.a.key === key || b.finalMatch.b.key === key)) return b.place + 1;
        }
        return null;
    }
    const placeWord = (n) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

    function placementsHtml(model) {
        if (!model.places.length) return "";
        const rowH = 20;
        const blocks = model.places.map((b) => {
            const X = [20];
            for (let c = 0; c < b.cols; c++) X.push(X[c] + (c === 0 ? 196 : 150));
            const W = X[b.cols] + 8, H = (b.rows - 1) * rowH + 46;
            const yOf = (row) => row * rowH + 24;
            let lines = "", labels = "", notes = "";
            const slotLabel = (t, x0, x1, y, pred) => {
                if (t.empty) return "";
                if (t.bye) return `<div class="dr-slot is-bye" style="left:${x0 + 4}px;top:${y - 21}px;width:${x1 - x0 - 8}px"><span class="nm">Bye</span></div>`;
                const cls = ["dr-slot", "is-team", pred ? "is-pred" : "", t.key === state.sel ? "is-sel" : ""].join(" ");
                return `<div class="${cls}" data-dsel="${escapeHtml(t.key)}" role="button" tabindex="0" title="${escapeHtml(full(t) + (t.club ? " — " + t.club : ""))}" style="left:${x0 + 4}px;top:${y - 21}px;width:${x1 - x0 - 8}px"><span class="nm${isFav(t) ? " is-fav" : ""}">${escapeHtml(short(t))}</span>${t.value != null ? `<span class="bx">${t.value}</span>` : ""}</div>`;
            };
            b.slots.forEach((s) => {
                const y = yOf(s.row), x0 = X[s.col], x1 = X[s.col + 1];
                lines += `M${x0} ${y}H${x1}`;
                labels += slotLabel(s.t, x0, x1, y, false);
            });
            b.matches.forEach((m) => {
                const xr = X[m.A.col + 1];
                lines += `M${xr} ${yOf(m.A.row)}V${yOf(m.B.row)}`;
                const py = yOf(m.P.row), px0 = X[m.P.col], px1 = X[m.P.col + 1];
                let note = "";
                if (m.played && m.P.score && m.P.score.length) note = `<span class="dr-sc">${m.P.score.map(escapeHtml).join(" ")}</span>${m.upset ? ' <span class="dr-up">Upset</span>' : ""}`;
                else if (state.pred && m.pred) {
                    labels += slotLabel(m.pred, px0, px1, py, true);
                    note = `<span class="${m.margin < CLOSE ? "is-close" : ""}">by ${m.margin}${m.margin < CLOSE ? ", close" : ""}</span>`;
                }
                if (note) notes += `<div class="dr-mg" style="left:${px0 + 4}px;top:${py + 4}px;max-width:${px1 - px0 - 8}px">${note}</div>`;
            });
            return `<div class="dr-pblock"><h3>${escapeHtml(b.title)}</h3><div class="dr-scroll"><div class="dr-bracket" style="width:${W}px;height:${H}px"><svg width="${W}" height="${H}" aria-hidden="true"><path d="${lines}" fill="none" stroke="var(--border-strong)" stroke-width="2"/></svg>${labels}${notes}</div></div></div>`;
        });
        return `<section class="dr-card dr-places"><div class="dr-card__head"><h2>Placement matches</h2></div>${blocks.join("")}</section>`;
    }

    function pathOf(model, key) {
        const { view, matches, labels } = model;
        let i = view[0].findIndex((t) => t.key === key);
        if (i < 0) return null;
        const t = view[0][i], steps = [];
        let out = null, won = false;
        for (let r = 0; r < view.length - 1; r++) {
            const opp = view[r][i ^ 1], next = view[r + 1][i >> 1], m = matches[r][i >> 1];
            const step = { round: labels[r] || `Round ${r + 1}`, opp };
            if (opp.bye) step.bye = true;
            else if (!opp.key) { step.unknown = true; }
            if (next.actual && next.key && !next.viaBye) {
                step.result = next.key === key ? "won" : "lost";
                step.score = next.score || [];
                step.upset = m.upset;
            } else if (opp.key && t.value != null && opp.value != null) {
                step.diff = t.value - opp.value;
            }
            steps.push(step);
            if (step.result === "lost") { out = { round: step.round, real: true }; break; }
            if (!step.result && step.diff != null && step.diff < 0) { out = { round: step.round, real: false }; break; }
            if (!step.result && !step.bye && step.diff == null) break;   // can't see past an unknown match
            i >>= 1;
            if (r === view.length - 2 && (step.result === "won" || (step.diff != null && step.diff >= 0) || step.bye)) won = true;
        }
        return { team: t, steps, out, won };
    }

    /* ---------- rendering ---------- */
    const surname = (n) => String(n).trim().split(/\s+/).slice(-1)[0];
    const short = (t) => t.players.length === 1
        ? `${t.players[0].name.trim()[0]}. ${surname(t.players[0].name)}`
        : t.players.map((p) => surname(p.name)).join(" / ");
    const full = (t) => t.players.map((p) => p.name).join(" / ");
    const isFav = (t) => !!(t.players && ctx.isStarredPlayer && t.players.some((p) => ctx.isStarredPlayer(p.name)));

    function geometry(size) {
        const lh = size <= 4 ? 56 : size <= 8 ? 48 : size <= 16 ? 34 : 30;
        const rounds = Math.round(Math.log2(size)) + 1;
        const cw = Array.from({ length: rounds }, (_, r) => r === 0 ? 196 : r === rounds - 1 ? 116 : 150);
        const X = [20]; cw.forEach((w, i) => X.push(X[i] + w));
        return { lh, cw, X, H: size * lh + 10, W: X[rounds] + 8, y: (r, i) => (i + 0.5) * (size * lh) / (size >> r) + 10 };
    }

    function bracketHtml(model) {
        const g = geometry(model.size), { view, matches } = model;
        let lines = "", labels = "", nos = "", mgs = "";
        view.forEach((row, r) => row.forEach((t, i) => {
            const y = g.y(r, i), x0 = g.X[r], x1 = g.X[r] + g.cw[r];
            lines += `M${x0} ${y}H${x1}`;
            if (r < view.length - 1 && i % 2 === 0) lines += `M${x1} ${y}V${g.y(r, i + 1)}`;
            if (r === 0) nos += `<span class="dr-no" style="left:0;top:${y - 16}px">${i + 1}</span>`;
            if (r > 0 && !state.pred && t.pred) return;
            if (t.empty) return;
            if (t.bye && r > 0) return;
            const cls = ["dr-slot", t.bye ? "is-bye" : "is-team", t.pred ? "is-pred" : "", t.key && t.key === state.sel ? "is-sel" : ""].join(" ");
            const val = t.value != null ? `<span class="bx">${t.value}</span>` : "";
            const seed = r === 0 && t.seed ? `<span class="dr-seed" title="Seed ${escapeHtml(t.seed)}">${escapeHtml(t.seed)}</span>` : "";
            labels += t.bye
                ? `<div class="${cls}" style="left:${x0 + 4}px;top:${y - 21}px;width:${g.cw[r] - 8}px"><span class="nm">Bye</span></div>`
                : `<div class="${cls}" data-dsel="${escapeHtml(t.key)}" role="button" tabindex="0" title="${escapeHtml(full(t) + (t.club ? " — " + t.club : ""))}" style="left:${x0 + 4}px;top:${y - 21}px;width:${g.cw[r] - 8}px"><span class="nm${isFav(t) ? " is-fav" : ""}">${escapeHtml(short(t))}</span>${seed}${val}</div>`;
            if (r > 0) {
                const m = matches[r - 1][i];
                let note = "";
                if (m.played && t.score && t.score.length) note = `<span class="dr-sc">${t.score.map(escapeHtml).join(" ")}</span>${m.upset ? ' <span class="dr-up">Upset</span>' : ""}`;
                else if (state.pred && t.pred && m.margin != null) note = `<span class="${m.margin < CLOSE ? "is-close" : ""}">by ${m.margin}${m.margin < CLOSE ? ", close" : ""}</span>`;
                if (note) mgs += `<div class="dr-mg" style="left:${x0 + 4}px;top:${y + 4}px;max-width:${g.cw[r] - 8}px">${note}</div>`;
            }
        }));
        let path = "";
        const i0 = view[0].findIndex((t) => t.key && t.key === state.sel);
        if (i0 >= 0) {
            let i = i0, r = 0;
            path = `M${g.X[0]} ${g.y(0, i)}H${g.X[0] + g.cw[0]}`;
            while (r < view.length - 1) {
                const nxt = view[r + 1][i >> 1];
                if (!nxt || nxt.key !== state.sel || (!state.pred && nxt.pred)) break;
                path += `V${g.y(r + 1, i >> 1)}H${g.X[r + 1] + g.cw[r + 1]}`;
                i >>= 1; r++;
            }
        }
        return `<div class="dr-rounds" style="width:${g.W}px">${model.labels.map((n, r) => `<span style="left:${g.X[r] + 4}px">${escapeHtml(n)}</span>`).join("")}</div>
            <div class="dr-bracket" style="width:${g.W}px;height:${g.H}px"><svg width="${g.W}" height="${g.H}" aria-hidden="true"><path d="${lines}" fill="none" stroke="var(--border-strong)" stroke-width="2"/>${path ? `<path class="dr-path" id="dr-path" d="${path}"/>` : ""}</svg>${nos}${labels}${mgs}</div>`;
    }

    function stepsHtml(info, place) {
        const li = info.steps.map((s) => {
            let what;
            if (s.bye) what = "Bye";
            else if (s.unknown) what = `<span class="dr-dim">Not decided yet</span>`;
            else {
                const opp = `<b>${escapeHtml(short(s.opp))}</b>${s.opp.value != null ? ` <span class="dr-dim">${s.opp.value}</span>` : ""}`;
                let em = "";
                if (s.result) em = `<em class="${s.result === "lost" ? "is-bad" : "is-good"}">${s.result === "won" ? "Won" : "Lost"}${s.score.length ? " " + escapeHtml(s.score.join(" ")) : ""}${s.upset ? ", upset" : ""}</em>`;
                else if (s.diff != null) em = `<em class="${s.diff < 0 || s.diff < CLOSE ? "is-bad" : "is-good"}">${s.diff >= 0 ? `Favoured by ${s.diff}${s.diff < CLOSE ? ", close" : ""}` : `Behind by ${-s.diff}`}</em>`;
                what = opp + em;
            }
            return `<li><span>${escapeHtml(s.round)}</span><span>${what}</span></li>`;
        }).join("");
        let verdict = "";
        const inRound = (label) => /^round\s/i.test(label) ? `in ${label.toLowerCase()}` : `in the ${label.toLowerCase()}`;
        if (info.out && info.out.real && place > 2) verdict = `Out of the main draw ${inRound(info.out.round)}, then finished ${placeWord(place)} in the placement matches.`;
        else if (info.out) verdict = info.out.real ? `Out ${inRound(info.out.round)}.` : `BAX expects them to go out ${inRound(info.out.round)}.`;
        else if (info.won) verdict = info.steps.every((s) => s.result || s.bye) ? "Won the event." : "BAX expects them to win the event.";
        return `<ol class="dr-steps">${li}</ol>${verdict ? `<p class="dr-verdict">${verdict}</p>` : ""}`;
    }

    function sideHtml(model) {
        const info = state.sel ? pathOf(model, state.sel) : null;
        const t = info && info.team;
        const names = t ? t.players.map((p, k) => {
            const row = t.rows[k];
            return row ? `<a class="player-link" ${playerLinkAttrs(row)}>${escapeHtml(p.name)}</a>` : escapeHtml(p.name);
        }).join("<br>") : "";
        const rank = t ? model.ranked.indexOf(t) + 1 : 0;
        const close = [];
        model.matches[0]?.forEach((m) => { if (m.a.key && m.b.key && m.margin != null && !m.played) close.push(m); });
        close.sort((x, y) => x.margin - y.margin);
        const upsets = model.matches.flat().filter((m) => m.upset)
            .concat(model.places.flatMap((b) => b.matches.filter((m) => m.upset).map((m) => ({ ...m, where: b.title }))));
        const place = t ? finalPlace(model, t.key) : null;
        // "Likely path" only while the panel actually shows a BAX prediction;
        // a path made entirely of played matches is just the "Path".
        const predicted = !!(info && state.pred && info.steps.some((s) => !s.result && !s.bye && s.diff != null));
        const played = !!(info && info.steps.some((s) => s.result));
        const title = predicted ? "Likely path" : played ? "Path" : "Selected";
        return `<section class="dr-card dr-panel"><div class="dr-card__head"><h2>${title}</h2></div>
            ${t ? `<p class="dr-team">${names}</p>
            <p class="dr-sub">${t.club ? escapeHtml(t.club) + ". " : ""}${t.seed ? `Seed ${escapeHtml(t.seed)}` : "Unseeded"}${t.value != null ? `, the ${ordinal(rank)} BAX in the draw (${t.value})` : ""}.${place ? ` <b class="dr-place">Finished ${placeWord(place)}.</b>` : ""}</p>
            ${state.pred || info.steps.some((s) => s.result) ? stepsHtml(info, place) : ""}` : `<p class="dr-sub">Pick a team in the draw.</p>`}
        </section>
        ${upsets.length ? `<section class="dr-card dr-panel"><div class="dr-card__head"><h2>Upsets</h2></div><ul class="dr-list">${upsets.map((m) => {
            const w = m.a.value < m.b.value ? m.a : m.b, l = w === m.a ? m.b : m.a;
            return `<li>${escapeHtml(short(w))} beat ${escapeHtml(short(l))}, <b>${l.value - w.value} BAX lower</b>${m.where ? ` <span class="dr-dim">(${escapeHtml(m.where)})</span>` : ""}</li>`;
        }).join("")}</ul></section>` : ""}
        ${close.length ? `<section class="dr-card dr-panel"><div class="dr-card__head"><h2>Closest open matches</h2></div><ul class="dr-list">${close.slice(0, 3).map((m) =>
            `<li>${escapeHtml(short(m.a))} against ${escapeHtml(short(m.b))}, <b>${m.margin} apart</b></li>`).join("")}</ul></section>` : ""}`;
    }
    const ordinal = (n) => ["", "highest", "2nd-highest", "3rd-highest"][n] || `${n}th-highest`;

    function message(html) { body.innerHTML = `<div class="dr-card dr-msg">${html}</div>`; }

    function renderTable(draw, meta, disc, chips) {
        const model = buildTable(draw, disc);
        if (!state.sel || !model.rows.some((r) => r.t.key === state.sel)) {
            const focus = ctx.isFocusPlayer && model.rows.find((r) => r.t.players && r.t.players.some((p) => ctx.isFocusPlayer(p.name)));
            const fav = focus || model.rows.find((r) => isFav(r.t));
            state.sel = ((fav || model.rows[0] || {}).t || {}).key || null;
        }
        const live = model.matches.filter((m) => !m.cancelled);
        const played = live.filter((m) => m.played).length;
        const finished = live.length > 0 && played >= live.length;
        const status = played === 0 ? "No results yet" : finished ? "Finished" : `${played} of ${live.length} matches played`;
        const fmt = meta.kind === "swiss" ? "Swiss ladder" : "Round robin";
        const toggle = finished ? "" : `<div class="mode-tabs" role="group" aria-label="Show"><button type="button" class="mode-tab${state.pred ? " active" : ""}" data-dmode="pred">BAX favourites</button><button type="button" class="mode-tab${state.pred ? "" : " active"}" data-dmode="draw">Draw only</button></div>`;
        const baxNote = model.hasBax ? "" : `<p class="dr-note"><span class="spinner"></span> BAX values are still loading — the table fills in once they arrive.</p>`;
        body.innerHTML = chips + `<div class="dr-grid"><div class="dr-main">
            <section class="dr-card dr-sheet">
                <div class="dr-head"><div><h3>${escapeHtml(meta.name)}</h3><p>${fmt}, ${model.rows.length} ${model.rows.some((r) => r.players.length > 1) ? "teams" : "players"}. ${status}.</p></div>${toggle}</div>
                ${baxNote}
                ${tableHtml(model, meta)}
                <p class="dr-note">“vs BAX” compares the finishing place with the place BAX predicts: +2 means two places better than the rating suggests.${meta.kind === "swiss" ? " Buchholz is the sum of the opponents' points, the usual Swiss tiebreak." : ""} BAX is an estimate from badminton-bax.de.</p>
            </section>
            ${matchesHtml(model)}</div>
            <aside class="dr-side">${tableSideHtml(model)}</aside></div>`;
    }

    async function render() {
        const disc = ctx.selected();
        if (!state.draws) { message(`<span class="spinner"></span> Loading the draw…`); await loadList(); }
        if (state.error && !state.draws.length) { message(`Could not load the draw: ${escapeHtml(state.error)}`); return; }
        if (!state.draws.length) {
            message(`<h3>The draw isn't out yet</h3><p>dbv publishes the draw once entries close. Until then the Ranking tab shows the field by BAX.</p>`);
            return;
        }
        if (!disc) {
            message(`<h3>Pick a discipline above</h3><p>${state.draws.length} draws are published for this tournament.${ctx.focusPlayer ? ` ${escapeHtml(ctx.focusPlayer)}'s entry is picked out in the draw you open.` : ""}</p>`);
            return;
        }
        const list = drawsForEvent(disc);
        if (!list.length) { message(`<h3>No draw for ${escapeHtml(disc.name)}</h3><p>dbv hasn't published a draw for this discipline.</p>`); return; }
        // Default to the discipline's main stage ("Hauptfeld") over its playoffs.
        if (!list.some((d) => d.draw === state.drawId)) state.drawId = (list.find((d) => /haupt|main/i.test(d.stage || "")) || list[0]).draw;
        const meta = list.find((d) => d.draw === state.drawId);
        const chips = list.length > 1 ? `<div class="dr-draws" role="group" aria-label="Draws">${list.map((d) =>
            `<button type="button" class="disc-chip__select dr-chip" data-draw="${escapeHtml(d.draw)}" aria-pressed="${d.draw === state.drawId}">${escapeHtml(d.name)}</button>`).join("")}</div>` : "";

        if (!["ko", "group", "swiss"].includes(meta.kind)) {
            body.innerHTML = chips + `<div class="dr-card dr-msg"><h3>${escapeHtml(meta.name)}: ${escapeHtml(meta.format || "unknown format")}</h3>
                <p>This draw format can't be shown here yet.</p>
                <a class="btn btn-secondary btn-sm" href="https://dbv.turnier.de/sport/draw.aspx?id=${escapeHtml(tournamentId)}&draw=${escapeHtml(meta.draw)}" target="_blank" rel="noopener">Open on dbv</a></div>`;
            return;
        }
        let draw;
        try {
            if (!state.drawCache.has(meta.draw)) body.innerHTML = chips + `<div class="dr-card dr-msg"><span class="spinner"></span> Loading ${escapeHtml(meta.name)}…</div>`;
            draw = await loadDraw(meta.draw);
        } catch (err) { body.innerHTML = chips + `<div class="dr-card dr-msg">Could not load this draw: ${escapeHtml(err.message)}</div>`; return; }
        if (ctx.selected() !== disc || state.drawId !== meta.draw) return;   // superseded while loading
        if (draw.kind === "group" || draw.kind === "swiss") { renderTable(draw, meta, disc, chips); return; }
        if (draw.kind !== "ko") { body.innerHTML = chips + `<div class="dr-card dr-msg"><p>This draw's format can't be shown here.</p><a class="btn btn-secondary btn-sm" href="${escapeHtml(draw.url)}" target="_blank" rel="noopener">Open on dbv</a></div>`; return; }

        const model = buildModel(draw, disc);
        if (!state.sel || !model.view[0].some((t) => t.key === state.sel)) {
            const focus = ctx.isFocusPlayer && model.ranked.find((t) => t.players.some((p) => ctx.isFocusPlayer(p.name)));
            const fav = focus || model.ranked.find(isFav);
            state.sel = (fav || model.ranked[0] || {}).key || null;
        }
        const played = model.matches.flat().filter((m) => m.played).length;
        const total = model.matches.flat().filter((m) => m.a.key && m.b.key).length;
        const finished = total > 0 && played >= total;
        const status = played === 0 ? "No results yet" : finished ? "Finished" : `${played} of ${total} matches played`;
        // Predictions only fill unplayed matches, so on a finished draw the
        // favourites / draw-only toggle would change nothing — leave it out.
        const toggle = finished ? "" : `<div class="mode-tabs" role="group" aria-label="Show"><button type="button" class="mode-tab${state.pred ? " active" : ""}" data-dmode="pred">BAX favourites</button><button type="button" class="mode-tab${state.pred ? "" : " active"}" data-dmode="draw">Draw only</button></div>`;
        const note = finished
            ? `Every match has a result. An upset is a match won by the side with at least ${UPSET_MIN} less BAX. BAX is an estimate from badminton-bax.de.`
            : `Grey names in later rounds are BAX predictions: the side with the higher ${disc && disciplineToFilter(disc.name) !== "all" ? "" : "total "}BAX goes through. Red marks matches closer than ${CLOSE}. BAX is an estimate from badminton-bax.de, not a result.`;
        const baxNote = model.hasBax ? "" : `<p class="dr-note"><span class="spinner"></span> BAX values are still loading — the bracket fills in once they arrive.</p>`;
        body.innerHTML = chips + `<div class="dr-grid"><div class="dr-main">
            <section class="dr-card dr-sheet">
                <div class="dr-head"><div><h3>${escapeHtml(meta.name)}</h3><p>${model.ranked.length} ${model.ranked.some((t) => t.players.length > 1) ? "teams" : "players"} in a draw of ${model.size}. ${status}.</p></div>
                    ${toggle}</div>
                ${baxNote}
                <div class="dr-scroll">${bracketHtml(model)}</div>
                <p class="dr-note">${note}</p>
            </section>
            ${placementsHtml(model)}</div>
            <aside class="dr-side">${sideHtml(model)}</aside></div>`;
        if (state.animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
            const p = document.getElementById("dr-path");
            if (p) { const L = p.getTotalLength(); p.style.strokeDasharray = L; p.animate([{ strokeDashoffset: L }, { strokeDashoffset: 0 }], { duration: Math.min(480, 220 + L * 0.3), easing: "cubic-bezier(.23,1,.32,1)" }); }
        }
        state.animate = false;
    }

    body.addEventListener("click", (e) => {
        const chip = e.target.closest("[data-draw]");
        if (chip) { state.drawId = chip.dataset.draw; state.sel = null; render(); return; }
        const mode = e.target.closest("[data-dmode]");
        if (mode) { const pred = mode.dataset.dmode === "pred"; if (pred !== state.pred) { state.pred = pred; state.animate = pred; render(); } return; }
        const slot = e.target.closest("[data-dsel]");
        if (slot && slot.dataset.dsel) { state.sel = slot.dataset.dsel; state.animate = true; keepScroll(render); }
    });
    body.addEventListener("keydown", (e) => {
        const slot = e.target.closest?.("[data-dsel]");
        if (slot && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); state.sel = slot.dataset.dsel; state.animate = true; keepScroll(render); }
    });
    async function keepScroll(fn) {
        const sc = body.querySelector(".dr-scroll"), left = sc ? sc.scrollLeft : 0;
        await fn();
        const n = body.querySelector(".dr-scroll"); if (n) n.scrollLeft = left;
    }

    return {
        loadList,
        render,
        refresh: async () => { state.drawCache.clear(); await loadList(true); await render(); },
        hasDraws: () => !!(state.draws && state.draws.length),
        resetSelection: () => { state.drawId = null; state.sel = null; },
    };
}
