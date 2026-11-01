/*
 * Data layer.
 * - Fetches from ESPN's public site APIs, with the NHL (api-web.nhle.com) and
 *   MLB (statsapi.mlb.com) APIs as fallbacks / for things ESPN lacks.
 * - Goes through the local proxy (server.py) when it's running, otherwise
 *   tries the APIs directly.
 * - Caches in memory for a short time, keeps the last good copy of small
 *   responses in localStorage, and serves that (flagged as stale) if a request fails.
 * - Turns the raw responses into small, consistent objects for the views.
 */

const TEAMS = {
  penguins: { key: 'penguins', name: 'Penguins', full: 'Pittsburgh Penguins', short: 'PEN', sport: 'hockey', league: 'nhl', abbr: 'pit', id: '16', unit: 'Period' },
  pirates: { key: 'pirates', name: 'Pirates', full: 'Pittsburgh Pirates', short: 'PIR', sport: 'baseball', league: 'mlb', abbr: 'pit', id: '23', unit: 'Inning' },
  steelers: { key: 'steelers', name: 'Steelers', full: 'Pittsburgh Steelers', short: 'STL', sport: 'football', league: 'nfl', abbr: 'pit', id: '23', unit: 'Quarter' },
};
const TEAM_BY_LEAGUE = { nhl: TEAMS.penguins, mlb: TEAMS.pirates, nfl: TEAMS.steelers };
const SPORT_OF = { nhl: 'hockey', mlb: 'baseball', nfl: 'football' };

const API = (() => {
  const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
  const STANDINGS = 'https://site.api.espn.com/apis/v2/sports';
  const WEB = 'https://site.web.api.espn.com/apis/common/v3/sports';
  const CORE = 'https://sports.core.api.espn.com/v2/sports';
  const NHLE = 'https://api-web.nhle.com/v1';
  const MLBS = 'https://statsapi.mlb.com/api/v1';

  let mode = 'direct';           // 'proxy' when server.py is answering
  const mem = new Map();         // url -> { t, data }
  const inflight = new Map();    // url -> Promise, so parallel callers share one request
  const health = { stale: false, failed: 0 };

  async function init() {
    if (location.protocol.startsWith('http')) {
      try {
        const r = await fetch('/api/health', { cache: 'no-store' });
        if (r.ok) mode = 'proxy';
      } catch (e) { /* no proxy */ }
    }
    return mode;
  }

  // ---- last-good-copy storage (small responses only) ----
  const STORE_PREFIX = 'scs:c:';
  function persist(url, text) {
    if (text.length > 250000) return;
    try {
      localStorage.setItem(STORE_PREFIX + url, text);
    } catch (e) { // full: drop the cached copies and carry on
      Object.keys(localStorage).filter((k) => k.startsWith(STORE_PREFIX)).forEach((k) => localStorage.removeItem(k));
    }
  }
  function restore(url) {
    try { const s = localStorage.getItem(STORE_PREFIX + url); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }

  /**
   * Fetch JSON with a cache.
   * @param {string} url   upstream URL
   * @param {number} ttl   seconds a cached copy counts as fresh
   */
  async function get(url, ttl = 60) {
    const hit = mem.get(url);
    if (hit && Date.now() - hit.t < ttl * 1000) return hit.data;
    if (inflight.has(url)) return inflight.get(url);

    const job = (async () => {
      try {
        const target = mode === 'proxy' ? '/api?url=' + encodeURIComponent(url) : url;
        const res = await fetch(target);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (res.headers.get('X-Stale')) health.stale = true;
        const text = await res.text();
        const data = JSON.parse(text);
        mem.set(url, { t: Date.now(), data });
        persist(url, text);
        return data;
      } catch (err) {
        health.failed++;
        const old = hit ? hit.data : restore(url);
        if (old) { health.stale = true; return old; }
        throw err;
      } finally {
        inflight.delete(url);
      }
    })();
    inflight.set(url, job);
    return job;
  }

  // ---------- small helpers ----------
  const scoreOf = (s) => (s == null ? null : typeof s === 'object' ? (s.displayValue ?? s.value) : s);
  const logoOf = (team, league) => {
    if (!team) return '';
    if (team.logo) return team.logo;
    const l = team.logos && (team.logos.find((x) => (x.rel || []).includes('default')) || team.logos[0]);
    if (l) return l.href;
    return team.abbreviation ? `https://a.espncdn.com/i/teamlogos/${league}/500/${team.abbreviation.toLowerCase()}.png` : '';
  };
  function broadcastsOf(c) {
    const out = new Set();
    (c.broadcasts || []).forEach((b) => {
      (b.names || []).forEach((n) => out.add(n));
      if (b.media && b.media.shortName) out.add(b.media.shortName);
      if (b.station) out.add(b.station);
    });
    if (c.broadcast) out.add(c.broadcast);
    (c.geoBroadcasts || []).forEach((b) => b.media && b.media.shortName && out.add(b.media.shortName));
    return [...out].filter(Boolean);
  }
  function flagOf(type) {
    const name = (type.name || '') + ' ' + (type.description || '') + ' ' + (type.detail || '');
    if (/POSTPONED|Postponed/.test(name)) return 'Postponed';
    if (/RAIN|Rain/.test(name)) return 'Rain delay';
    if (/DELAY|Delay/.test(name)) return 'Delayed';
    if (/SUSPENDED|Suspended/.test(name)) return 'Suspended';
    if (/CANCEL|Cancel/.test(name)) return 'Canceled';
    return '';
  }

  /** One game, from Pittsburgh's point of view (us / them). */
  function normEvent(e, teamId, league) {
    const c = (e.competitions && e.competitions[0]) || {};
    const st = c.status || e.status || {};
    const type = st.type || {};
    const comps = c.competitors || [];
    const us = comps.find((x) => String((x.team && x.team.id) || x.id) === String(teamId)) || comps[0] || {};
    const them = comps.find((x) => x !== us) || {};
    const side = (x) => ({
      id: String((x.team && x.team.id) || x.id || ''),
      abbr: x.team ? x.team.abbreviation : '',
      name: x.team ? x.team.displayName : '',
      short: x.team ? x.team.shortDisplayName || x.team.name : '',
      logo: logoOf(x.team, league),
      score: scoreOf(x.score),
      winner: x.winner,
      record: (x.record && x.record[0] && x.record[0].displayValue) || (x.records && x.records[0] && x.records[0].summary) || '',
      linescores: x.linescores || [],
    });
    const U = side(us), T = side(them);
    let result = null;
    if (type.completed && U.score != null && T.score != null) {
      result = us.winner ? 'W' : them.winner ? 'L' : (+U.score > +T.score ? 'W' : +U.score < +T.score ? 'L' : 'T');
    }
    return {
      id: String(e.id), league, date: new Date(e.date),
      timeKnown: e.timeValid !== false && c.timeValid !== false,
      state: type.state || 'pre', completed: !!type.completed,
      detail: type.shortDetail || type.detail || '', fullDetail: type.detail || '',
      flag: flagOf(type),
      period: st.period, clock: st.displayClock,
      home: us.homeAway === 'home', us: U, them: T, result,
      venue: c.venue ? c.venue.fullName : '', city: c.venue && c.venue.address ? c.venue.address.city : '',
      tv: broadcastsOf(c),
      seasonType: (e.seasonType && e.seasonType.type) || (e.season && e.season.type),
      week: e.week ? e.week.text || `Week ${e.week.number}` : '',
      situation: c.situation || null,
      name: e.name, shortName: e.shortName,
    };
  }

  function formatRecord(league, s, fallback) {
    if (!s || s.wins == null) return fallback || '';
    if (league === 'nhl') return `${s.wins}-${s.losses}-${s.otLosses ?? s.overtimeLosses ?? 0}`;
    if (league === 'nfl' && s.ties) return `${s.wins}-${s.losses}-${s.ties}`;
    return `${s.wins}-${s.losses}`;
  }

  // ---------- teams ----------
  // ESPN's team endpoint is the only one that blocks direct browser requests,
  // so without the proxy the same facts are built from standings and schedules.
  async function team(T) {
    if (mode === 'proxy') {
      try { return await teamFromEndpoint(T); } catch (e) { /* fall back below */ }
    }
    return teamFromStandings(T);
  }

  async function teamFromStandings(T) {
    const st = await standings(T.league);
    const place = placeIn(st, T.id);
    const e = place && place.entry;
    const stats = {};
    if (e) Object.entries(e.stats).forEach(([k, v]) => { stats[k] = v.v; });
    return {
      id: T.id, name: T.full,
      logo: `https://a.espncdn.com/i/teamlogos/${T.league}/500/${T.abbr}.png`,
      record: e ? recordFromEntry(T.league, e) : '',
      stats,
      next: await nextSeasonOpener(T),
    };
  }

  // Only needed in the off-season: the first game on next season's schedule.
  async function nextSeasonOpener(T) {
    const s = await schedule(T).catch(() => null);
    if (!s || !s.year || s.events.some((e) => e.state === 'pre')) return null;
    const base = `${SITE}/${T.sport}/${T.league}/teams/${T.id}/schedule?season=${s.year + 1}`;
    for (const type of [1, 2]) {
      const d = await get(`${base}&seasontype=${type}`, 3600).catch(() => null);
      const ev = d && (d.events || []).map((x) => normEvent(x, T.id, T.league)).filter((x) => +x.date > Date.now()).sort((a, b) => a.date - b.date)[0];
      if (ev) return ev;
    }
    return null;
  }

  async function teamFromEndpoint(T) {
    const d = await get(`${SITE}/${T.sport}/${T.league}/teams/${T.abbr}`, 60);
    const t = d.team;
    const item = (t.record && t.record.items || []).find((i) => i.type === 'total') || (t.record && t.record.items || [])[0];
    const stats = Object.fromEntries(((item && item.stats) || []).map((s) => [s.name, s.value]));
    return {
      id: t.id, name: t.displayName,
      logo: logoOf(t, T.league),
      record: formatRecord(T.league, stats, item && item.summary),
      stats,
      next: t.nextEvent && t.nextEvent[0] ? normEvent(t.nextEvent[0], t.id, T.league) : null,
    };
  }

  async function schedule(T) {
    const base = `${SITE}/${T.sport}/${T.league}/teams/${T.id}/schedule`;
    let d = await get(base, 60);
    const year = (d.season && d.season.year) || (d.requestedSeason && d.requestedSeason.year);
    let events = (d.events || []).map((e) => normEvent(e, T.id, T.league));
    if (!events.length && year) {
      // Off-season: the default request returns an empty postseason. Show the regular season.
      const reg = await get(`${base}?season=${year}&seasontype=2`, 600);
      events = (reg.events || []).map((e) => normEvent(e, T.id, T.league));
    } else if (d.season && d.season.type === 3 && year) {
      // In the playoffs: show the regular season too.
      const reg = await get(`${base}?season=${year}&seasontype=2`, 600);
      events = (reg.events || []).map((e) => normEvent(e, T.id, T.league)).concat(events);
    }
    events.sort((a, b) => a.date - b.date);
    return { year, type: d.season && d.season.type, seasonName: d.season && d.season.displayName, events, byeWeek: d.byeWeek };
  }

  // Every game we can find for the calendar: this season plus its preseason,
  // and next season's opening games once this one is over.
  async function allGames(T) {
    const s = await schedule(T);
    const base = `${SITE}/${T.sport}/${T.league}/teams/${T.id}/schedule`;
    const extra = [`${base}?season=${s.year}&seasontype=1`];
    if (!s.events.some((e) => e.state === 'pre')) extra.push(`${base}?season=${s.year + 1}&seasontype=1`, `${base}?season=${s.year + 1}&seasontype=2`);
    const lists = await Promise.all(extra.map((u) => get(u, 3600).then((d) => (d.events || []).map((e) => normEvent(e, T.id, T.league))).catch(() => [])));
    const byId = new Map();
    [s.events, ...lists].flat().forEach((e) => byId.set(e.id, e));
    return [...byId.values()].sort((a, b) => a.date - b.date);
  }

  // ---------- rosters ----------
  const rosterIndex = {}; // league -> Map(id -> athlete)
  const NFL_POS_ORDER = ['QB', 'RB', 'FB', 'WR', 'TE', 'OT', 'G', 'C', 'DE', 'DT', 'NT', 'LB', 'CB', 'S', 'K', 'P', 'LS'];

  function normAthlete(a, group) {
    const inj = a.injuries && a.injuries[0];
    return {
      id: String(a.id), name: a.fullName || a.displayName, short: a.shortName || a.displayName,
      jersey: a.jersey || '', pos: a.position ? a.position.abbreviation : '', posName: a.position ? a.position.displayName : '',
      age: a.age, ht: a.displayHeight || '', wt: a.displayWeight || '',
      headshot: a.headshot ? a.headshot.href : '',
      injury: inj ? { status: inj.status || (inj.type && inj.type.description) || 'Injured', date: inj.date, detail: (inj.details && [inj.details.side, inj.details.location || inj.details.type].filter(Boolean).join(' ')) || inj.longComment || inj.shortComment || '' } : null,
      status: a.status ? a.status.name : '', group,
    };
  }

  async function roster(T) {
    const d = await get(`${SITE}/${T.sport}/${T.league}/teams/${T.id}/roster`, 600);
    const raw = d.athletes || [];
    let groups;
    if (T.league === 'nfl') {
      // ESPN groups the NFL roster as offense/defense/...; regroup by position.
      const special = { injuredReserveOrOut: 'Injured reserve / out', suspended: 'Suspended', practiceSquad: 'Practice squad' };
      const byPos = new Map();
      const extra = [];
      raw.forEach((g) => g.items.forEach((a) => {
        const p = normAthlete(a, special[g.position] || (a.position && a.position.displayName) || 'Other');
        if (special[g.position]) extra.push(p);
        else {
          if (!byPos.has(p.pos)) byPos.set(p.pos, { label: p.posName || p.pos, key: p.pos, athletes: [] });
          byPos.get(p.pos).athletes.push(p);
        }
      }));
      groups = [...byPos.values()].sort((a, b) => (NFL_POS_ORDER.indexOf(a.key) + 99) % 99 - (NFL_POS_ORDER.indexOf(b.key) + 99) % 99);
      Object.values(special).forEach((label) => {
        const list = extra.filter((p) => p.group === label);
        if (list.length) groups.push({ label, key: label, athletes: list });
      });
    } else {
      groups = raw.map((g) => ({ label: g.position, key: g.position, athletes: g.items.map((a) => normAthlete(a, g.position)) }))
        .filter((g) => g.athletes.length);
    }
    const index = rosterIndex[T.league] || (rosterIndex[T.league] = new Map());
    groups.forEach((g) => g.athletes.forEach((a) => index.set(a.id, Object.assign({ team: T.key }, a))));
    return groups;
  }

  // ---------- standings ----------
  // Division-level standings: { conferences: [{ name, divisions: [{ name, entries }] }] }
  async function standings(league) {
    const d = await get(`${STANDINGS}/${SPORT_OF[league]}/${league}/standings?level=3`, 300);
    const entry = (e) => {
      const stats = {};
      (e.stats || []).forEach((s) => { stats[s.name] = { v: s.value, d: s.displayValue, summary: s.summary }; });
      return { teamId: String(e.team.id), abbr: e.team.abbreviation, name: e.team.displayName, short: e.team.shortDisplayName || e.team.name, logo: logoOf(e.team, league), stats };
    };
    const conferences = (d.children || []).map((conf) => ({
      name: conf.name, abbr: conf.abbreviation,
      divisions: (conf.children || [conf]).map((div) => ({
        name: div.name, abbr: div.abbreviation,
        entries: sortStandings(league, ((div.standings && div.standings.entries) || []).map(entry)),
      })),
    }));
    return { season: d.seasons && d.seasons[0] ? d.seasons[0].year : null, conferences };
  }

  const sv = (e, k) => (e.stats[k] ? +e.stats[k].v || 0 : 0);
  const sd = (e, ...keys) => { for (const k of keys) if (e.stats[k] && e.stats[k].d != null) return e.stats[k].d; return '—'; };

  function sortStandings(league, list) {
    return list.map((e, i) => [e, i]).sort(([a, ia], [b, ib]) => {
      let diff;
      if (league === 'nhl') diff = sv(b, 'points') - sv(a, 'points') || sv(a, 'gamesPlayed') - sv(b, 'gamesPlayed') || sv(b, 'regWins') - sv(a, 'regWins');
      else diff = sv(b, 'winPercent') - sv(a, 'winPercent') || (sv(a, 'playoffSeed') || 99) - (sv(b, 'playoffSeed') || 99);
      return diff || ia - ib;
    }).map(([e]) => e);
  }

  function recordFromEntry(league, e) {
    if (league === 'nhl') return `${sv(e, 'wins')}-${sv(e, 'losses')}-${sv(e, 'otLosses')}`;
    if (league === 'nfl' && sv(e, 'ties')) return `${sv(e, 'wins')}-${sv(e, 'losses')}-${sv(e, 'ties')}`;
    return `${sv(e, 'wins')}-${sv(e, 'losses')}`;
  }

  /** Where a team sits: { conf, div, rank } */
  function placeIn(st, teamId) {
    for (const conf of st.conferences) {
      for (const div of conf.divisions) {
        const i = div.entries.findIndex((e) => e.teamId === String(teamId));
        if (i >= 0) return { conf, div, rank: i + 1, entry: div.entries[i] };
      }
    }
    return null;
  }

  // ---------- live data ----------
  async function scoreboard(league, ttl = 8) {
    const d = await get(`${SITE}/${SPORT_OF[league]}/${league}/scoreboard`, ttl);
    return d.events || [];
  }
  async function liveGame(T, ttl = 8) {
    const events = await scoreboard(T.league, ttl);
    const e = events.find((ev) => (ev.competitions[0].competitors || []).some((c) => String(c.team && c.team.id) === T.id));
    return e ? normEvent(e, T.id, T.league) : null;
  }
  async function summary(league, eventId, ttl = 60) {
    return get(`${SITE}/${SPORT_OF[league]}/${league}/summary?event=${eventId}`, ttl);
  }
  // NHL power-play status for the Penguins' live game (ESPN doesn't expose it).
  // Returns undefined when it can't be known (the NHL API needs the proxy),
  // null at even strength, or { team, time } during a power play.
  async function nhlSituation() {
    if (mode !== 'proxy') return undefined;
    try {
      const d = await get(`${NHLE}/score/now`, 8);
      const g = (d.games || []).find((x) => [x.homeTeam.abbrev, x.awayTeam.abbrev].includes('PIT'));
      if (!g || !g.situation) return null;
      const s = g.situation;
      const pp = ['homeTeam', 'awayTeam'].find((k) => s[k] && (s[k].situationDescriptions || []).includes('PP'));
      return pp ? { team: s[pp].abbrev, time: s.timeRemaining, strength: `${s.awayTeam.strength}-on-${s.homeTeam.strength}`, empty: [s.homeTeam, s.awayTeam].some((t) => (t.situationDescriptions || []).includes('EN')) } : null;
    } catch (e) { return undefined; }
  }

  // ---------- players ----------
  async function athlete(league, id) {
    const [bio, overview] = await Promise.all([
      get(`${WEB}/${SPORT_OF[league]}/${league}/athletes/${id}`, 600),
      get(`${WEB}/${SPORT_OF[league]}/${league}/athletes/${id}/overview`, 300).catch(() => null),
    ]);
    return { bio: bio.athlete || {}, overview };
  }

  // ---------- team leaders ----------
  const LEADER_CATS = {
    nhl: [['goals', 'Goals'], ['assists', 'Assists'], ['points', 'Points'], ['savePct', 'Save %']],
    mlb: [['avg', 'Batting avg'], ['homeRuns', 'Home runs'], ['RBIs', 'RBI'], ['ERA', 'ERA']],
    nfl: [['passingYards', 'Passing yards'], ['rushingYards', 'Rushing yards'], ['receivingYards', 'Receiving yards'], ['sacks', 'Sacks']],
  };
  async function leaders(T, year) {
    const d = await get(`${CORE}/${T.sport}/leagues/${T.league}/seasons/${year}/types/2/teams/${T.id}/leaders`, 600);
    const cats = d.categories || [];
    const out = [];
    for (const [key, label] of LEADER_CATS[T.league]) {
      const c = cats.find((x) => x.name === key);
      if (!c) { out.push({ key, label, leaders: [] }); continue; }
      // ESPN pads short lists with players on zero (a punter under passing yards); drop those
      const top = (c.leaders || []).filter((l) => l.value > 0).slice(0, 3);
      const rows = await Promise.all(top.map(async (l) => {
        const ref = l.athlete && l.athlete.$ref || '';
        const id = (ref.match(/athletes\/(\d+)/) || [])[1];
        return { id, value: l.displayValue, name: await athleteName(T.league, id, ref) };
      }));
      out.push({ key, label, leaders: rows });
    }
    return out;
  }
  async function athleteName(league, id, ref) {
    const known = rosterIndex[league] && rosterIndex[league].get(String(id));
    if (known) return known.name;
    try { const a = await get(ref, 86400); return a.displayName || a.fullName || `#${id}`; } catch (e) { return `Player ${id}`; }
  }

  // ---------- playoffs ----------
  const nhlBracket = (year) => get(`${NHLE}/playoff-bracket/${year}`, 300);
  const mlbPostseason = (year) => get(`${MLBS}/schedule/postseason/series?season=${year}&sportId=1&hydrate=team`, 300);
  // NFL playoff weeks: 1 wild card, 2 divisional, 3 conference, 5 Super Bowl (4 is the Pro Bowl)
  async function nflPostseason(year) {
    const weeks = await Promise.all([1, 2, 3, 5].map((w) =>
      get(`${SITE}/football/nfl/scoreboard?seasontype=3&week=${w}&dates=${year}`, 300).then((d) => d.events || []).catch(() => [])));
    return weeks;
  }
  const nflWeek = (year, week) => get(`${SITE}/football/nfl/scoreboard?seasontype=2&week=${week}&dates=${year}`, 1800);

  return {
    init, get, health, get mode() { return mode; },
    team, schedule, allGames, roster, rosterIndex, standings, placeIn, recordFromEntry, sv, sd,
    scoreboard, liveGame, summary, nhlSituation, athlete, leaders, LEADER_CATS,
    nhlBracket, mlbPostseason, nflPostseason, nflWeek, normEvent,
  };
})();
