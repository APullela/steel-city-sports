/*
 * Playoffs tab: one bracket per league.
 * - Regular season: a projected bracket ("if the season ended today") built
 *   from the current standings using each league's seeding rules.
 * - Playoffs / off-season: the real bracket (NHL API, MLB Stats API, ESPN
 *   for the NFL), with the champion once decided.
 * Under each bracket is a standings table with seed, record, games back
 * (points for the NHL), last 10, streak and a playoff status badge.
 */
(() => {
  const { esc } = UI;
  const SUB_KEY = 'scs:playoffs-sub';
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  const sv = API.sv, sd = API.sd;
  const BUBBLE = { nhl: 4, nfl: 1, mlb: 3 }; // how close (points / games) counts as "on the bubble"
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const fmtGB = (g) => (g === 0 ? '0' : Number.isInteger(g) ? String(g) : g.toFixed(1));

  // ---------- bracket drawing ----------
  const slot = (o = {}) => Object.assign({ seed: '', abbr: '', name: 'TBD', logo: '', score: '', winner: false, tbd: !o.name && !o.abbr }, o, { mine: o.abbr === 'PIT' });
  const TBD = () => slot();
  const fromEntry = (e, seed) => slot({ seed, abbr: e.abbr, name: e.short || e.name, logo: e.logo });

  function matchupHTML(m) {
    const row = (s) => `<div class="slot${s.winner ? ' won' : ''}${s.mine ? ' mine' : ''}${s.tbd ? ' tbd' : ''}">
      <span class="seed">${esc(s.seed)}</span>${s.logo ? UI.logo(s.logo, s.name, 'logo xs') : '<span class="logo xs"></span>'}
      <span class="tname">${esc(s.abbr || s.name)}${s.mine ? ' <span class="you">★<span class="sr-only"> Pittsburgh</span></span>' : ''}</span>
      <span class="sc">${esc(s.score)}</span>${s.winner ? '<span class="adv" aria-label="advanced">✓</span>' : ''}</div>`;
    const mine = m.a.mine || (m.b && m.b.mine);
    return `<div class="matchup${mine ? ' has-mine' : ''}${m.bye ? ' bye' : ''}">${row(m.a)}${m.b ? row(m.b) : '<p class="m-note">First-round bye</p>'}${m.note ? `<p class="m-note">${esc(m.note)}</p>` : ''}</div>`;
  }
  function bracketHTML(rounds, label) {
    return `<div class="bracket-scroll" tabindex="0" aria-label="${esc(label)} (scrolls sideways)"><div class="bracket">${rounds.map((r) => `
      <section class="round" aria-label="${esc(r.name)}"><h3>${esc(r.name)}</h3><div class="matchups">${r.matchups.map(matchupHTML).join('')}</div></section>`).join('')}</div></div>`;
  }

  // ---------- standings table ----------
  function statusOf(e, inSpot, behind, league) {
    const c = e.stats.clincher && e.stats.clincher.d;
    if (c && /e/i.test(c)) return 'Out';
    if (c && c !== '-' && c.trim()) return 'Clinched';
    if (inSpot) return 'In';
    return behind <= BUBBLE[league] ? 'Bubble' : 'Out';
  }
  function standingsTable(title, rows, league, odds) {
    const col4 = league === 'nhl' ? 'PTS' : 'GB';
    const body = rows.map((r) => `<tr class="${r.e.abbr === 'PIT' ? 'mine' : ''}${r.cut ? ' cut' : ''}">
      <td>${esc(r.seed || '')}</td>
      <th scope="row">${UI.logo(r.e.logo, r.e.name, 'logo xs')} ${esc(r.e.short)}${r.e.abbr === 'PIT' ? ' <span class="you">★ you</span>' : ''}</th>
      <td class="num">${API.recordFromEntry(league, r.e)}</td>
      <td class="num">${esc(league === 'nhl' ? sv(r.e, 'points') : r.gb)}</td>
      <td class="num" data-l10="${esc(r.e.abbr)}">${esc(String(sd(r.e, 'Last Ten Games')).replace(/, \d+ PTS/, ''))}</td>
      <td class="num">${esc(sd(r.e, 'streak'))}</td>
      <td><span class="status st-${r.status.toLowerCase()}">${r.status}</span></td>
      ${odds ? `<td class="num"><b>${Odds.format(odds.get(r.e.abbr))}</b></td>` : ''}</tr>`).join('');
    return `<div class="card"><h3>${esc(title)}</h3><div class="table-wrap"><table class="po-table">
      <thead><tr><th scope="col">Seed</th><th scope="col">Team</th><th scope="col" class="num">Record</th><th scope="col" class="num">${col4}</th>
      <th scope="col" class="num">Last 10</th><th scope="col" class="num">Streak</th><th scope="col">Status</th>${odds ? '<th scope="col" class="num" title="Chance of making the playoffs">Playoff %</th>' : ''}</tr></thead><tbody>${body}</tbody></table></div>
      <p class="hint">${league === 'nhl' ? 'PTS = points. ' : 'GB = games behind the last playoff spot. '}The line marks the playoff cut.${odds ? ` Playoff % comes from playing out the rest of the season ${Odds.SIMS.toLocaleString()} times at each team's current strength.` : ''}</p></div>`;
  }

  // ---------- NHL ----------
  const nhlSort = (a, b) => sv(b, 'points') - sv(a, 'points') || sv(a, 'gamesPlayed') - sv(b, 'gamesPlayed') || sv(b, 'regWins') - sv(a, 'regWins');

  function nhlProjected(st) {
    const confs = st.conferences.map((conf) => {
      const divs = conf.divisions.map((d) => ({ name: d.name, letter: d.name[0], teams: d.entries.slice().sort(nhlSort) }));
      const rest = divs.flatMap((d) => d.teams.slice(3)).sort(nhlSort);
      const wc = rest.slice(0, 2);
      const leaders = divs.map((d, i) => ({ i, t: d.teams[0] })).sort((a, b) => nhlSort(a.t, b.t));
      const seedOf = new Map();
      divs.forEach((d) => d.teams.slice(0, 3).forEach((t, k) => seedOf.set(t.abbr, `${d.letter}${k + 1}`)));
      wc.forEach((t, k) => seedOf.set(t.abbr, `WC${k + 1}`));
      const matchups = [];
      divs.forEach((d, i) => {
        const wcOpp = i === leaders[0].i ? wc[1] : wc[0];
        matchups.push({ a: fromEntry(d.teams[0], `${d.letter}1`), b: wcOpp ? fromEntry(wcOpp, seedOf.get(wcOpp.abbr)) : TBD() });
        matchups.push({ a: fromEntry(d.teams[1], `${d.letter}2`), b: fromEntry(d.teams[2], `${d.letter}3`) });
      });
      const lastIn = wc[1], firstOut = rest[2];
      const all = conf.divisions.flatMap((d) => d.entries).sort(nhlSort);
      const rows = all.map((e) => {
        const inSpot = seedOf.has(e.abbr);
        const behind = lastIn ? sv(lastIn, 'points') - sv(e, 'points') : 99;
        return { e, seed: seedOf.get(e.abbr) || '', status: statusOf(e, inSpot, behind, 'nhl') };
      });
      // seeded teams first (division seeds, then wild cards), then everyone else
      const order = (s) => (!s ? 99 : s.startsWith('WC') ? 10 + +s[2] : +s[1]); // D1s, D2s, D3s, WC1, WC2
      rows.sort((a, b) => order(a.seed) - order(b.seed) || nhlSort(a.e, b.e));
      const cutAt = rows.findIndex((r) => !r.seed);
      if (cutAt > 0) rows[cutAt].cut = true;
      return { name: conf.name, matchups, rows, lastIn, firstOut, seedOf, divs };
    });
    const rounds = [
      { name: 'First round', matchups: confs.flatMap((c) => c.matchups) },
      { name: 'Second round', matchups: Array.from({ length: 4 }, () => ({ a: TBD(), b: TBD() })) },
      { name: 'Conference finals', matchups: Array.from({ length: 2 }, () => ({ a: TBD(), b: TBD() })) },
      { name: 'Stanley Cup Final', matchups: [{ a: TBD(), b: TBD() }] },
    ];
    return { confs, rounds };
  }

  function nhlSummary(proj) {
    for (const c of proj.confs) {
      const row = c.rows.find((r) => r.e.abbr === 'PIT');
      if (!row) continue;
      const e = row.e;
      const div = c.divs.find((d) => d.teams.includes(e));
      const divPlace = div ? `${ord(div.teams.indexOf(e) + 1)} in the ${div.name.replace(' Division', '')}` : '';
      if (row.seed) {
        const ahead = c.firstOut ? sv(e, 'points') - sv(c.firstOut, 'points') : 0;
        const spot = row.seed.startsWith('WC') ? `the ${row.seed === 'WC1' ? 'first' : 'second'} wild-card spot` : `a playoff spot as the ${divPlace} team`;
        return `The Penguins currently hold ${spot}, ${plural(ahead, 'point')} clear of the first team out${c.firstOut ? ` (${c.firstOut.short})` : ''}.`;
      }
      const behind = c.lastIn ? sv(c.lastIn, 'points') - sv(e, 'points') : 0;
      const inHand = c.lastIn ? sv(c.lastIn, 'gamesPlayed') - sv(e, 'gamesPlayed') : 0;
      return `The Penguins are ${divPlace} and ${plural(behind, 'point')} behind the last wild-card spot${c.lastIn ? ` (${c.lastIn.short})` : ''}${inHand > 0 ? `, with ${plural(inHand, 'game')} in hand` : inHand < 0 ? `, having played ${plural(-inHand, 'more game')}` : ''}.`;
    }
    return '';
  }

  function nhlActual(data) {
    const series = (data.series || []).slice().sort((a, b) => a.playoffRound - b.playoffRound || a.seriesLetter.localeCompare(b.seriesLetter));
    const names = ['First round', 'Second round', 'Conference finals', 'Stanley Cup Final'];
    const side = (t, seed, wins, winId) => (t && t.abbrev
      ? slot({ seed, abbr: t.abbrev, name: (t.commonName && t.commonName.default) || (t.name && t.name.default) || t.abbrev, logo: t.logo, score: wins ?? '', winner: winId != null && winId === t.id })
      : TBD());
    const rounds = names.map((name, i) => ({
      name,
      matchups: series.filter((s) => s.playoffRound === i + 1).map((s) => ({
        a: side(s.topSeedTeam, s.topSeedRankAbbrev, s.topSeedWins, s.winningTeamId),
        b: side(s.bottomSeedTeam, s.bottomSeedRankAbbrev, s.bottomSeedWins, s.winningTeamId),
      })),
    })).filter((r) => r.matchups.length);
    const fin = series.find((s) => s.playoffRound === 4);
    let champ = null;
    if (fin && fin.winningTeamId) {
      const t = [fin.topSeedTeam, fin.bottomSeedTeam].find((x) => x && x.id === fin.winningTeamId);
      if (t) champ = { name: (t.name && t.name.default) || t.abbrev, logo: t.logo };
    }
    const pit = series.filter((s) => [s.topSeedTeam, s.bottomSeedTeam].some((t) => t && t.abbrev === 'PIT'));
    let summary = 'The Penguins did not make these playoffs.';
    if (pit.length) {
      const lastS = pit[pit.length - 1];
      const won = lastS.winningTeamId && [lastS.topSeedTeam, lastS.bottomSeedTeam].find((t) => t && t.abbrev === 'PIT').id === lastS.winningTeamId;
      summary = lastS.winningTeamId
        ? (won && lastS.playoffRound === 4 ? 'The Penguins won the Stanley Cup.' : `The Penguins were knocked out in the ${names[lastS.playoffRound - 1].toLowerCase()}.`)
        : `The Penguins are playing in the ${names[lastS.playoffRound - 1].toLowerCase()}.`;
    }
    return { rounds, champ, summary };
  }

  // ---------- NFL ----------
  const wpSort = (a, b) => sv(b, 'winPercent') - sv(a, 'winPercent') || (sv(a, 'playoffSeed') || 99) - (sv(b, 'playoffSeed') || 99);
  const gamesBehind = (leader, e) => ((sv(leader, 'wins') - sv(e, 'wins')) + (sv(e, 'losses') - sv(leader, 'losses'))) / 2;

  // Seeds for one conference/league: ESPN's own seeds when present, otherwise
  // division leaders first, then the best of the rest.
  function seedConference(conf, spots) {
    const all = conf.divisions.flatMap((d) => d.entries);
    const espn = all.filter((e) => sv(e, 'playoffSeed') >= 1).sort((a, b) => sv(a, 'playoffSeed') - sv(b, 'playoffSeed'));
    if (espn.length >= spots) return { all, seeded: espn.slice(0, spots), rest: espn.slice(spots).concat(all.filter((e) => !espn.includes(e))) };
    const leaders = conf.divisions.map((d) => d.entries.slice().sort(wpSort)[0]).sort(wpSort);
    const others = all.filter((e) => !leaders.includes(e)).sort(wpSort);
    const seeded = leaders.concat(others.slice(0, spots - leaders.length));
    return { all, seeded, rest: others.slice(spots - leaders.length) };
  }

  function projectedRows(league, conf, spots) {
    const { seeded, rest } = seedConference(conf, spots);
    const lastIn = seeded[seeded.length - 1], firstOut = rest[0];
    const rows = seeded.map((e, i) => ({ e, seed: String(i + 1), gb: '—', status: statusOf(e, true, 0, league) }))
      .concat(rest.sort(wpSort).map((e) => {
        const gb = gamesBehind(lastIn, e);
        return { e, seed: '', gb: fmtGB(gb), status: statusOf(e, false, gb, league) };
      }));
    if (rows[spots]) rows[spots].cut = true;
    return { seeded, rest, rows, lastIn, firstOut };
  }

  function nflProjected(st) {
    const confs = st.conferences.map((c) => Object.assign({ name: c.name, abbr: c.abbr || (c.name.startsWith('American') ? 'AFC' : 'NFC') }, projectedRows('nfl', c, 7)));
    const wc = confs.flatMap((c) => {
      const s = c.seeded;
      const e = (i) => (s[i] ? fromEntry(s[i], String(i + 1)) : TBD());
      return [{ a: e(0), bye: true }, { a: e(3), b: e(4) }, { a: e(2), b: e(5) }, { a: e(1), b: e(6) }];
    });
    const rounds = [
      { name: 'Wild card', matchups: wc },
      { name: 'Divisional', matchups: Array.from({ length: 4 }, () => ({ a: TBD(), b: TBD() })) },
      { name: 'Conference', matchups: Array.from({ length: 2 }, () => ({ a: TBD(), b: TBD() })) },
      { name: 'Super Bowl', matchups: [{ a: TBD(), b: TBD() }] },
    ];
    return { confs, rounds };
  }

  function seedSummary(proj, nick, spots, unit) {
    for (const c of proj.confs) {
      const i = c.seeded.findIndex((e) => e.abbr === 'PIT');
      if (i >= 0) {
        const ahead = c.firstOut ? gamesBehind(c.seeded[i], c.firstOut) : 0;
        const bye = unit === 'nfl' ? (i === 0 ? ', which comes with the only first-round bye' : '') : i < 2 ? ', which comes with a first-round bye' : '';
        return `The ${nick} are currently the #${i + 1} seed in the ${c.abbr || c.name}${bye}, and ${fmtGB(ahead)} ${ahead === 1 ? 'game' : 'games'} ahead of the first team out${c.firstOut ? ` (${c.firstOut.short})` : ''}.`;
      }
      const e = c.rest.find((x) => x.abbr === 'PIT');
      if (e) {
        const gb = gamesBehind(c.lastIn, e);
        const place = c.rows.findIndex((r) => r.e === e) + 1;
        return `The ${nick} are ${ord(place)} in the ${c.abbr || c.name}, ${fmtGB(gb)} ${gb === 1 ? 'game' : 'games'} behind the last playoff spot (${c.lastIn.short}).`;
      }
    }
    return '';
  }

  function nflActual(weeks) {
    const names = ['Wild card', 'Divisional', 'Conference', 'Super Bowl'];
    const conf = (e) => (((e.competitions[0].notes || [])[0] || {}).headline || '').slice(0, 3);
    const rounds = weeks.map((events, i) => ({
      name: names[i],
      matchups: events.slice().sort((a, b) => conf(a).localeCompare(conf(b))).map((e) => {
        const c = e.competitions[0];
        const s = (x) => slot({ abbr: x.team.abbreviation, name: x.team.shortDisplayName, logo: x.team.logo, score: c.status.type.state === 'pre' ? '' : x.score, winner: !!x.winner });
        const away = c.competitors.find((x) => x.homeAway === 'away'), home = c.competitors.find((x) => x.homeAway === 'home');
        return { a: s(away), b: s(home), note: c.status.type.state === 'pre' ? UI.when(new Date(e.date)) : '' };
      }),
    })).filter((r) => r.matchups.length);
    const sb = weeks[3] && weeks[3][0];
    let champ = null;
    if (sb && sb.competitions[0].status.type.completed) {
      const w = sb.competitions[0].competitors.find((x) => x.winner);
      if (w) champ = { name: w.team.displayName, logo: w.team.logo };
    }
    const games = weeks.flat().filter((e) => e.competitions[0].competitors.some((x) => x.team.abbreviation === 'PIT'));
    let summary = 'The Steelers did not make these playoffs.';
    if (games.length) {
      const g = games[games.length - 1], c = g.competitions[0];
      const me = c.competitors.find((x) => x.team.abbreviation === 'PIT');
      const round = names[weeks.findIndex((w) => w.includes(g))].toLowerCase();
      summary = !c.status.type.completed ? `The Steelers are playing in the ${round} round.`
        : me.winner ? (round === 'super bowl' ? 'The Steelers won the Super Bowl.' : `The Steelers won in the ${round} round.`)
          : `The Steelers lost in the ${round} round.`;
    }
    return { rounds, champ, summary };
  }

  // NFL standings don't include "last 10", so it is worked out from each week's results.
  async function fillNflLast10(root, year, throughWeek) {
    const results = {};
    const weeks = await Promise.all(Array.from({ length: throughWeek }, (_, i) => API.nflWeek(year, i + 1).then((d) => d.events || []).catch(() => [])));
    weeks.forEach((events) => events.forEach((e) => {
      const c = e.competitions[0];
      if (!c.status.type.completed) return;
      const [x, y] = c.competitors;
      const r = (me, them) => (+me.score > +them.score ? 'W' : +me.score < +them.score ? 'L' : 'T');
      (results[x.team.abbreviation] = results[x.team.abbreviation] || []).push(r(x, y));
      (results[y.team.abbreviation] = results[y.team.abbreviation] || []).push(r(y, x));
    }));
    root.querySelectorAll('[data-l10]').forEach((td) => {
      const list = (results[td.dataset.l10] || []).slice(-10);
      if (!list.length) return;
      const n = (k) => list.filter((v) => v === k).length;
      td.textContent = `${n('W')}-${n('L')}${n('T') ? '-' + n('T') : ''}`;
    });
  }

  // ---------- MLB ----------
  function mlbProjected(st) {
    const confs = st.conferences.map((c) => Object.assign({ name: c.name, abbr: c.abbr || (c.name.startsWith('American') ? 'AL' : 'NL') }, projectedRows('mlb', c, 6)));
    const wcCol = confs.flatMap((c) => {
      const s = c.seeded, e = (i) => (s[i] ? fromEntry(s[i], String(i + 1)) : TBD());
      return [{ a: e(0), bye: true }, { a: e(3), b: e(4) }, { a: e(1), bye: true }, { a: e(2), b: e(5) }];
    });
    const rounds = [
      { name: 'Wild Card Series', matchups: wcCol },
      { name: 'Division Series', matchups: Array.from({ length: 4 }, () => ({ a: TBD(), b: TBD() })) },
      { name: 'Championship Series', matchups: Array.from({ length: 2 }, () => ({ a: TBD(), b: TBD() })) },
      { name: 'World Series', matchups: [{ a: TBD(), b: TBD() }] },
    ];
    return { confs, rounds };
  }

  function mlbActual(data, st) {
    // seeds from that season's standings, matched by team name
    const seedByName = {};
    if (st) st.conferences.forEach((c) => c.divisions.forEach((d) => d.entries.forEach((e) => { if (sv(e, 'playoffSeed') >= 1 && sv(e, 'playoffSeed') <= 6) seedByName[e.name] = sv(e, 'playoffSeed'); })));
    const list = (data.series || []).map((s) => {
      const g = s.games[s.games.length - 1];
      const desc = g.description || '';
      const t = (x) => slot({
        seed: seedByName[x.team.name] ? String(seedByName[x.team.name]) : '',
        abbr: x.team.abbreviation || x.team.teamName || x.team.name, name: x.team.teamName || x.team.name,
        logo: `https://www.mlbstatic.com/team-logos/${x.team.id}.svg`,
        score: x.leagueRecord ? x.leagueRecord.wins : '', winner: !!x.isWinner,
      });
      const round = s.series.id[0]; // F wild card, D division, L championship, W world series
      const lg = /^AL/.test(desc) ? 'AL' : /^NL/.test(desc) ? 'NL' : '';
      return { round, lg, a: t(g.teams.away), b: t(g.teams.home), final: g.status.abstractGameState === 'Final' };
    });
    const minSeed = (m) => Math.min(+m.a.seed || 9, +m.b.seed || 9);
    const byeFor = (lg, seed) => {
      const name = Object.keys(seedByName).find((n) => seedByName[n] === seed && list.some((m) => m.lg === lg && [m.a.name, m.b.name].some((x) => n.endsWith(x))));
      const m = list.find((x) => x.lg === lg && x.round === 'D' && [x.a, x.b].some((s) => +s.seed === seed));
      const s = m && [m.a, m.b].find((x) => +x.seed === seed);
      return s ? { a: slot({ seed: String(seed), abbr: s.abbr, name: s.name, logo: s.logo }), bye: true } : name ? { a: slot({ seed: String(seed), name }), bye: true } : null;
    };
    const col = (round) => ['AL', 'NL'].flatMap((lg) => {
      const ms = list.filter((m) => m.round === round && m.lg === lg).sort((x, y) => minSeed(x) - minSeed(y));
      if (round === 'F') {
        // keep the tree lined up: 1 seed bye, 4v5, 2 seed bye, 3v6
        const w45 = ms.find((m) => [4, 5].includes(minSeed(m))), w36 = ms.find((m) => minSeed(m) === 3) || ms.find((m) => m !== w45);
        return [byeFor(lg, 1), w45, byeFor(lg, 2), w36].filter(Boolean);
      }
      return ms;
    });
    const rounds = [['F', 'Wild Card Series'], ['D', 'Division Series'], ['L', 'Championship Series'], ['W', 'World Series']]
      .map(([k, name]) => ({ name, matchups: k === 'W' ? list.filter((m) => m.round === 'W') : col(k) }))
      .filter((r) => r.matchups.length);
    const ws = list.find((m) => m.round === 'W');
    const champWinner = ws && [ws.a, ws.b].find((s) => s.winner);
    const champ = champWinner ? { name: champWinner.name, logo: champWinner.logo, full: Object.keys(seedByName).find((n) => n.endsWith(champWinner.name)) || champWinner.name } : null;
    return { rounds, champ };
  }

  // ---------- the view ----------
  async function leagueHTML(league, root) {
    const T = TEAM_BY_LEAGUE[league];
    const [d, st] = await Promise.all([Views.loadTeam(T), API.standings(league)]);
    const regular = !d.offseason && d.sched.type !== 3;
    const odds = regular ? Odds.compute(league, st) : null;
    let label, rounds, champ = null, summary = '', tables = '';

    if (league === 'nhl') {
      const proj = nhlProjected(st);
      tables = proj.confs.map((c) => standingsTable(c.name, c.rows, 'nhl', odds)).join('');
      if (regular) {
        ({ rounds } = proj);
        label = 'Projected: if the season ended today';
        summary = nhlSummary(proj);
      } else {
        let data = await API.nhlBracket(d.sched.year).catch(() => null);
        if (!data || !(data.series || []).length) data = await API.nhlBracket(d.sched.year - 1).catch(() => ({ series: [] }));
        ({ rounds, champ, summary } = nhlActual(data));
        label = champ ? 'Final bracket from the most recent playoffs' : 'Playoffs in progress';
        if (!rounds.length) { // the NHL bracket API needs the local server; fall back to the standings
          ({ rounds } = proj);
          summary = nhlSummary(proj);
          label = 'Seeding from the final standings (the live NHL bracket needs the local server)';
        }
      }
    } else if (league === 'nfl') {
      const proj = nflProjected(st);
      tables = proj.confs.map((c) => standingsTable(c.name, c.rows, 'nfl', odds)).join('');
      if (regular) {
        ({ rounds } = proj);
        label = 'Projected: if the season ended today';
        summary = seedSummary(proj, 'Steelers', 7, 'nfl');
      } else {
        const weeks = await API.nflPostseason(d.sched.year);
        ({ rounds, champ, summary } = nflActual(weeks));
        label = champ ? 'Final bracket from the most recent playoffs' : 'Playoffs in progress';
      }
    } else {
      const proj = mlbProjected(st);
      tables = proj.confs.map((c) => standingsTable(c.name, c.rows, 'mlb', odds)).join('');
      if (regular) {
        ({ rounds } = proj);
        label = 'Projected: if the season ended today';
        summary = seedSummary(proj, 'Pirates', 6, 'mlb');
      } else {
        const data = await API.mlbPostseason(d.sched.year);
        ({ rounds, champ } = mlbActual(data, st));
        const inIt = rounds.some((r) => r.matchups.some((m) => m.a.mine || (m.b && m.b.mine)));
        const place = d.place ? `${ord(d.place.rank)} in the ${d.place.div.name.replace('National League', 'NL').replace('American League', 'AL')}` : '';
        summary = `The Pirates finished ${d.info.record}${place ? `, ${place}` : ''}, and ${inIt ? 'made the playoffs' : 'missed the playoffs'}.${champ ? ` The ${champ.full} won the ${d.sched.year} World Series.` : ''}`;
        label = champ ? `Final bracket from the ${d.sched.year} playoffs` : 'Playoffs in progress';
      }
    }

    if (odds && odds.has('PIT')) summary += ` Their chance of making the playoffs: about ${Odds.format(odds.get('PIT'))}.`;
    const html = `<p class="po-summary">${esc(summary)}</p>
      <p class="po-label"><span class="tag-label">${regular ? 'Projected' : champ ? 'Final' : 'Live'}</span> ${esc(label)}</p>
      ${champ ? `<div class="champ card">${UI.logo(champ.logo, champ.name, 'logo lg')}<div><span class="muted">Champion</span><b>${esc(champ.full || champ.name)}</b></div><span class="trophy" aria-hidden="true">🏆</span></div>` : ''}
      <div class="card">${bracketHTML(rounds, `${league.toUpperCase()} bracket`)}</div>
      <h2>Standings</h2><div class="grid2">${tables}</div>`;

    if (league === 'nfl' && regular) {
      const weeksPlayed = Math.max(0, ...d.events.filter((e) => e.completed).map((e) => parseInt((e.week || '').replace(/\D/g, ''), 10) || 0));
      setTimeout(() => fillNflLast10(root, d.sched.year, Math.max(weeksPlayed, 1)).catch(() => {}), 0);
    }
    return html;
  }

  function current() {
    try { return localStorage.getItem(SUB_KEY) || 'nhl'; } catch (e) { return 'nhl'; }
  }

  Views.playoffs = {
    async render(root) {
      const sub = current();
      const tabs = ['nhl', 'mlb', 'nfl'].map((l) => `<button type="button" role="tab" class="subtab${l === sub ? ' on' : ''}" aria-selected="${l === sub}" data-action="po-sub" data-v="${l}">${l.toUpperCase()}</button>`).join('');
      root.innerHTML = `<h1 class="page-title">Playoffs</h1><div class="subtabs" role="tablist" aria-label="League">${tabs}</div><div id="po-body">${UI.skeleton('rows', 8)}</div>`;
      const body = root.querySelector('#po-body');
      try {
        body.innerHTML = await leagueHTML(sub, root);
      } catch (e) {
        body.innerHTML = `<div class="card">${UI.empty('The playoff picture could not be loaded. It will try again on the next refresh.')}</div>`;
      }
    },
    refresh(root) { return this.render(root); },
    setSub(v) { try { localStorage.setItem(SUB_KEY, v); } catch (e) { /* ignore */ } },
  };
})();
