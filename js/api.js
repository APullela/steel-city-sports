/*
 * Data layer.
 * - Fetches from ESPN's public APIs, with the NHL (api-web.nhle.com) and
 *   MLB (statsapi.mlb.com) APIs for the few things ESPN lacks.
 * - Goes through the local proxy (server.py) when it's running, otherwise
 *   calls the APIs directly.
 * - Built to use as little mobile data as possible:
 *   - Responses are cut down to the fields the app uses and saved on the
 *     device with the time they were fetched. Each kind of data has its own
 *     shelf life, so reopening the app usually downloads nothing.
 *   - A schedule counts as fresh until one of its games should be over.
 *   - Live games are followed through ESPN's tiny per-game endpoints
 *     (status, score, situation: about 1 KB a check) instead of
 *     whole-league scoreboards (10-20 KB each).
 *   - Data saver (on by default unless the browser says it's on Wi-Fi)
 *     keeps things longer and checks live games less often.
 * - If a request fails, the last good copy is shown and flagged as stale.
 */

const TEAMS = {
  penguins: { key: 'penguins', name: 'Penguins', full: 'Pittsburgh Penguins', short: 'PEN', sport: 'hockey', league: 'nhl', abbr: 'pit', id: '16', unit: 'Period' },
  pirates: { key: 'pirates', name: 'Pirates', full: 'Pittsburgh Pirates', short: 'PIR', sport: 'baseball', league: 'mlb', abbr: 'pit', id: '23', unit: 'Inning' },
  steelers: { key: 'steelers', name: 'Steelers', full: 'Pittsburgh Steelers', short: 'STL', sport: 'football', league: 'nfl', abbr: 'pit', id: '23', unit: 'Quarter' },
};
const TEAM_BY_LEAGUE = { nhl: TEAMS.penguins, mlb: TEAMS.pirates, nfl: TEAMS.steelers };
const SPORT_OF = { nhl: 'hockey', mlb: 'baseball', nfl: 'football' };

// ---------- data saver setting and the data meter ----------
const Data = (() => {
  const KEY = 'scs:saver';     // 'auto' | 'on' | 'off'
  const METER = 'scs:meter';
  const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
  const conn = navigator.connection;
  const onWifi = () => !!(conn && /wifi|ethernet/.test(conn.type || ''));

  const month = () => new Date().toISOString().slice(0, 7);
  let meter = (() => { try { const m = JSON.parse(read(METER, '')); if (m && m.month === month()) return m; } catch (e) { /* new */ } return { month: month(), bytes: 0, req: 0 }; })();
  let saveTimer = 0;
  return {
    get mode() { return read(KEY, 'auto'); },
    set mode(v) { write(KEY, v); },
    // the browser's own "Lite mode" / data saver switch also counts
    get saver() { const m = this.mode; return m === 'on' || (m === 'auto' && (!onWifi() || !!(conn && conn.saveData))); },
    get onWifi() { return onWifi(); },
    /** Count bytes downloaded (compressed size, plus a little for headers). */
    add(bytes, requests = 1) {
      if (meter.month !== month()) meter = { month: month(), bytes: 0, req: 0 };
      meter.bytes += bytes + requests * 350;
      meter.req += requests;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => write(METER, JSON.stringify(meter)), 1500);
    },
    get used() { return meter.month === month() ? meter : { bytes: 0, req: 0 }; },
  };
})();

const API = (() => {
  const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
  const STANDINGS = 'https://site.api.espn.com/apis/v2/sports';
  const WEB = 'https://site.web.api.espn.com/apis/common/v3/sports';
  const CORE = 'https://sports.core.api.espn.com/v2/sports';
  const NHLE = 'https://api-web.nhle.com/v1';
  const MLBS = 'https://statsapi.mlb.com/api/v1';
  const H = 3600e3, MIN = 60e3, DAY = 24 * H;

  // How long each kind of data stays fresh: [data saver, normal], in ms.
  const LIFE = {
    standings: [12 * H, 1 * H],    // and whenever a Pittsburgh game has finished since
    roster: [24 * H, 6 * H],
    leaders: [12 * H, 3 * H],
    bio: [7 * DAY, DAY],
    overview: [12 * H, 3 * H],
    bracket: [6 * H, 30 * MIN],
    later: [7 * DAY, DAY],          // next season's schedule, preseason
    schedMax: [24 * H, 2 * H],      // a schedule with no game coming up soon
    overdue: [20 * MIN, 5 * MIN],   // a game that should be over but isn't marked final yet
    summaryLive: [5 * MIN, 20e3],   // plus whenever the score changes
    summaryPre: [2 * H, 20 * MIN],
    live: [25e3, 8e3],              // live status / score checks
    forever: [30 * DAY, 30 * DAY],  // finished games and past weeks never change
  };
  const life = (k) => LIFE[k][Data.saver ? 0 : 1];
  const GAME_LENGTH = 3.5 * H;      // a game is expected to be over this long after it starts

  let mode = 'direct';           // 'proxy' when server.py is answering
  const mem = new Map();         // url -> { t, data, dead }
  const inflight = new Map();    // url -> Promise, so parallel callers share one request
  const health = { stale: false, failed: 0 };

  async function init() {
    // only look for server.py on this computer or the home network (saves a request on a web host)
    const h = location.hostname;
    const local = ['localhost', '127.0.0.1'].includes(h) || /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$/.test(h);
    if (location.protocol.startsWith('http') && local) {
      try {
        const r = await fetch('/api/health', { cache: 'no-store' });
        if (r.ok) mode = 'proxy';
      } catch (e) { /* no proxy */ }
    }
    return mode;
  }

  // ---------- saved copies on the device ----------
  // Each entry is { t: fetched at, data: the trimmed response }. They're kept
  // under a size budget; the oldest go first.
  const PREFIX = 'scs:c:';
  const BUDGET = 1200000; // characters (about 2.4 MB of the browser's 5 MB allowance)
  let sizes = null;       // key -> [t, length]
  (function migrate() {
    try {
      if (localStorage.getItem('scs:store-v') === '4') return;
      Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => localStorage.removeItem(k));
      localStorage.setItem('scs:store-v', '4');
    } catch (e) { /* storage blocked */ }
  })();
  function index() {
    if (sizes) return sizes;
    sizes = new Map();
    try {
      Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => {
        const s = localStorage.getItem(k) || '';
        sizes.set(k, [+(s.match(/^\{"t":(\d+)/) || [0, 0])[1], s.length]);
      });
    } catch (e) { /* ignore */ }
    return sizes;
  }
  function persist(url, entry) {
    const text = JSON.stringify({ t: entry.t, data: entry.data });
    if (text.length > 300000) return;
    const key = PREFIX + url;
    const idx = index();
    idx.set(key, [entry.t, text.length]);
    let total = 0;
    idx.forEach(([, n]) => { total += n; });
    // over budget: drop the oldest copies first
    const oldest = [...idx.entries()].filter(([k]) => k !== key).sort((a, b) => a[1][0] - b[1][0]);
    while (total > BUDGET && oldest.length) {
      const [k, [, n]] = oldest.shift();
      try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
      idx.delete(k); total -= n;
    }
    try { localStorage.setItem(key, text); } catch (e) {
      // storage full (other sites' data, private mode): keep it in memory only
      idx.delete(key);
    }
  }
  function restore(url) {
    try {
      const s = localStorage.getItem(PREFIX + url);
      const v = s && JSON.parse(s);
      return v && v.t ? { t: v.t, data: v.data } : null;
    } catch (e) { return null; }
  }
  function clearSaved() {
    mem.clear();
    try { Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* ignore */ }
    sizes = null;
  }
  function savedSize() {
    let n = 0;
    index().forEach(([, len]) => { n += len; });
    return n * 2; // UTF-16
  }

  // ttl is seconds, or a function (data, fetchedAt) -> time it goes stale (ms)
  const expiry = (ttl, hit) => (typeof ttl === 'function' ? ttl(hit.data, hit.t) : hit.t + ttl * 1000);

  /**
   * Fetch JSON, using a fresh copy from memory or the device when there is one.
   * @param {string} url
   * @param {number|function} ttl  seconds, or (data, fetchedAt) => stale-at time in ms
   * @param {object} opts  shape: trims the response before it's kept;
   *                       live: always ask the server, never save;
   *                       keep: false to keep in memory only
   */
  async function get(url, ttl = 60, opts = {}) {
    let hit = mem.get(url);
    if (!hit && !opts.live) { hit = restore(url); if (hit) mem.set(url, hit); }
    if (hit && !hit.dead && Date.now() < expiry(ttl, hit)) return hit.data;
    if (inflight.has(url)) return inflight.get(url);
    if (hit && !navigator.onLine) { health.stale = true; return hit.data; } // offline: don't even try

    const job = (async () => {
      try {
        const target = mode === 'proxy' ? '/api?url=' + encodeURIComponent(url) : url;
        const res = await fetch(target, opts.live ? { cache: 'no-cache' } : undefined);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (res.headers.get('X-Stale')) health.stale = true;
        const text = await res.text();
        Data.add(+res.headers.get('Content-Length') || Math.round(text.length / 7));
        let data = JSON.parse(text);
        if (opts.shape) data = opts.shape(data);
        const entry = { t: Date.now(), data };
        mem.set(url, entry);
        if (!opts.live && opts.keep !== false) persist(url, entry);
        return data;
      } catch (err) {
        health.failed++;
        if (hit) { health.stale = true; return hit.data; }
        throw err;
      } finally {
        inflight.delete(url);
      }
    })();
    inflight.set(url, job);
    return job;
  }

  /** Mark cached copies as out of date (they're still used if the network fails). */
  function invalidate(test) {
    mem.forEach((v, k) => { if (test(k)) v.dead = true; });
  }

  // ---------- trimming: keep only what the app shows ----------
  const pick = (o, keys) => {
    if (!o) return o;
    const out = {};
    keys.forEach((k) => { if (o[k] !== undefined) out[k] = o[k]; });
    return out;
  };
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
  // the logo address is only kept when it isn't the standard one (which logoOf can rebuild)
  const trimTeam = (t, league) => {
    if (!t) return t;
    const out = pick(t, ['id', 'abbreviation', 'displayName', 'shortDisplayName', 'name']);
    const logo = logoOf(t, league);
    if (logo !== logoOf({ abbreviation: t.abbreviation }, league)) out.logo = logo;
    return out;
  };

  // one game from a schedule or scoreboard: same shape, far fewer fields
  // (a finished game needs even less: no venue, TV or records)
  function trimEvent(e, league) {
    const c = (e.competitions && e.competitions[0]) || {};
    const st = c.status || e.status || {};
    const type = st.type || {};
    const done = !!type.completed;
    return {
      id: e.id, date: e.date, timeValid: e.timeValid, name: e.name, shortName: e.shortName,
      seasonType: e.seasonType && { type: e.seasonType.type }, season: e.season && pick(e.season, ['type', 'year']),
      week: e.week && pick(e.week, ['text', 'number']),
      competitions: [{
        timeValid: c.timeValid,
        status: done
          ? { type: { state: type.state, completed: true, shortDetail: type.shortDetail, detail: type.detail !== type.shortDetail ? type.detail : undefined } }
          : { type: pick(type, ['state', 'completed', 'name', 'description', 'detail', 'shortDetail']), period: st.period, displayClock: st.displayClock },
        venue: !done && c.venue ? { fullName: c.venue.fullName, address: c.venue.address && { city: c.venue.address.city } } : undefined,
        broadcasts: done ? undefined : [{ names: broadcastsOf(c) }],
        competitors: (c.competitors || []).map((x) => ({
          id: x.id, homeAway: x.homeAway, winner: x.winner, score: scoreOf(x.score),
          record: done ? undefined : [{ displayValue: (x.record && x.record[0] && x.record[0].displayValue) || (x.records && x.records[0] && x.records[0].summary) || '' }],
          team: trimTeam(x.team, league),
        })),
      }],
    };
  }
  const trimSchedule = (league) => (d) => ({
    season: d.season && pick(d.season, ['year', 'type', 'displayName']),
    requestedSeason: d.requestedSeason && { year: d.requestedSeason.year },
    byeWeek: d.byeWeek && { number: d.byeWeek.number },
    events: (d.events || []).map((e) => trimEvent(e, league)),
  });
  const trimScoreboard = (league) => (d) => ({ events: (d.events || []).map((e) => trimEvent(e, league)) });

  // A schedule stays fresh until one of its games should be over.
  // One that's all played (last season, the first half of a baseball season) barely changes.
  function scheduleLife(d, t) {
    let exp = t + life('schedMax');
    let pending = false;
    (d.events || []).forEach((e) => {
      const st = (e.competitions[0].status || {}).type || {};
      if (st.completed || /POSTPONED|CANCEL/.test(st.name || '')) return;
      pending = true;
      const end = +new Date(e.date) + GAME_LENGTH;
      if (end > t) exp = Math.min(exp, end);
      else if (t - end < DAY) exp = Math.min(exp, t + life('overdue'));
    });
    return !pending && (d.events || []).length ? t + life('later') : exp;
  }
  // a scoreboard week that is all finished never changes
  const weekLife = (d, t) => t + ((d.events || []).length && d.events.every((e) => e.competitions[0].status.type.completed) ? life('forever') : life('bracket'));

  function flagOf(type) {
    const name = (type.name || '') + ' ' + (type.description || '') + ' ' + (type.detail || '');
    if (/POSTPONED|Postponed/.test(name)) return 'Postponed';
    if (/RAIN|Rain/.test(name)) return 'Rain delay';
    if (/DELAY|Delay/.test(name)) return 'Delayed';
    if (/SUSPENDED|Suspended/.test(name)) return 'Suspended';
    if (/CANCEL|Cancel/.test(name)) return 'Canceled';
    return '';
  }

  // ---------- live games ----------
  // eventId -> { state, completed, type, period, clock, scores: { teamId: score }, situation }
  const overlay = new Map();
  const listeners = [];

  // ESPN's per-game "situation" as one flat object for every sport
  function normSituation(s) {
    if (!s) return null;
    const id = (ref) => (String((ref && ref.$ref) || '').match(/teams\/(\d+)/) || [])[1];
    return {
      possession: id(s.team), downDistanceText: s.downDistanceText, isRedZone: s.isRedZone,
      balls: s.balls, strikes: s.strikes, outs: s.outs,
      onFirst: !!s.onFirst, onSecond: !!s.onSecond, onThird: !!s.onThird,
      powerPlay: s.powerPlay, emptyNet: s.emptyNet,
    };
  }

  /**
   * Check one game's status, and its score and situation while it's on.
   * About 1 KB, against 10-20 KB for a league scoreboard.
   */
  async function liveCheck(league, eventId, teamIds) {
    const base = `${CORE}/${SPORT_OF[league]}/leagues/${league}/events/${eventId}/competitions/${eventId}`;
    const ttl = life('live') / 1000;
    const st = await get(`${base}/status`, ttl, { live: true });
    const type = st.type || {};
    const prev = overlay.get(String(eventId));
    const o = { state: type.state || 'pre', completed: !!type.completed, type, period: st.period, clock: st.displayClock, scores: Object.assign({}, prev && prev.scores), situation: prev ? prev.situation : null };
    const justEnded = o.state === 'post' && (!prev || prev.state !== 'post');
    if (o.state === 'in' || justEnded) {
      const [scores, sit] = await Promise.all([
        Promise.all(teamIds.map((id) => get(`${base}/competitors/${id}/score`, ttl, { live: true }).catch(() => null))),
        o.state === 'in' ? get(`${base}/situation`, ttl, { live: true }).catch(() => null) : null,
      ]);
      teamIds.forEach((id, i) => { if (scores[i]) o.scores[String(id)] = scoreOf(scores[i]); });
      o.situation = o.state === 'in' ? normSituation(sit) : null;
    }
    overlay.set(String(eventId), o);
    const scored = prev && JSON.stringify(prev.scores) !== JSON.stringify(o.scores);
    if (scored || justEnded || (prev && prev.state !== o.state)) {
      // the box score is out of date now
      invalidate((k) => k.includes(`summary?event=${eventId}`));
    }
    if (justEnded && prev) {
      // pick up the final in the schedule and the new standings
      invalidate((k) => k.includes(`/${league}/teams/`) || k.includes(`/${league}/standings`));
    }
    listeners.forEach((fn) => fn(league, String(eventId), prev, o));
    return o;
  }
  const onLive = (fn) => listeners.push(fn);
  const liveOf = (id) => overlay.get(String(id));

  // The game a team is playing now, about to play, or just finished (and not
  // yet marked final in the schedule): only these are checked live.
  async function activeGame(T) {
    const s = await schedule(T);
    const now = Date.now();
    const ev = s.events.find((e) => !e.completed && !/Postponed|Canceled/.test(e.flag)
      && (e.state === 'in' || (+e.date - 20 * MIN <= now && now <= +e.date + 8 * H)));
    if (!ev) return null;
    await liveCheck(T.league, ev.id, [ev.us.id, ev.them.id]).catch(() => null);
    return (await schedule(T)).events.find((e) => e.id === ev.id) || null;
  }

  // The next start time across all three teams, from saved schedules only.
  function nextStart() {
    let best = Infinity;
    Object.values(TEAMS).forEach((T) => {
      const hit = mem.get(`${SITE}/${T.sport}/${T.league}/teams/${T.id}/schedule`);
      ((hit && hit.data.events) || []).forEach((e) => {
        const d = +new Date(e.date);
        if (d > Date.now() && !e.competitions[0].status.type.completed) best = Math.min(best, d);
      });
    });
    return best;
  }

  /** One game, from Pittsburgh's point of view (us / them), with any live update laid on top. */
  function normEvent(e, teamId, league) {
    const c = (e.competitions && e.competitions[0]) || {};
    const st = c.status || e.status || {};
    let type = st.type || {};
    let period = st.period, clock = st.displayClock;
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
    });
    const U = side(us), T = side(them);
    let situation = c.situation || null;
    const o = overlay.get(String(e.id));
    const applied = !!(o && !type.completed);
    if (applied) { // the live check is newer than this copy of the schedule
      type = o.type; period = o.period; clock = o.clock; situation = o.situation;
      if (o.scores[U.id] != null) U.score = o.scores[U.id];
      if (o.scores[T.id] != null) T.score = o.scores[T.id];
    }
    let result = null;
    if (type.completed && U.score != null && T.score != null) {
      result = us.winner && !applied ? 'W' : them.winner && !applied ? 'L' : (+U.score > +T.score ? 'W' : +U.score < +T.score ? 'L' : 'T');
    }
    return {
      id: String(e.id), league, date: new Date(e.date),
      timeKnown: e.timeValid !== false && c.timeValid !== false,
      state: type.state || 'pre', completed: !!type.completed,
      detail: type.shortDetail || type.detail || '', fullDetail: type.detail || '',
      flag: flagOf(type),
      period, clock,
      home: us.homeAway === 'home', us: U, them: T, result,
      venue: c.venue ? c.venue.fullName : '', city: c.venue && c.venue.address ? c.venue.address.city : '',
      tv: broadcastsOf(c),
      seasonType: (e.seasonType && e.seasonType.type) || (e.season && e.season.type),
      week: e.week ? e.week.text || `Week ${e.week.number}` : '',
      situation,
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
  // ESPN's team endpoint blocks direct browser requests, so without the proxy
  // the same facts are built from standings and schedules.
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
      const d = await get(`${base}&seasontype=${type}`, (x, t) => t + life('later'), { shape: trimSchedule(T.league) }).catch(() => null);
      const ev = d && (d.events || []).map((x) => normEvent(x, T.id, T.league)).filter((x) => +x.date > Date.now()).sort((a, b) => a.date - b.date)[0];
      if (ev) return ev;
    }
    return null;
  }

  async function teamFromEndpoint(T) {
    const d = await get(`${SITE}/${T.sport}/${T.league}/teams/${T.abbr}`, (x, t) => t + life('standings'), {
      shape: (r) => ({ team: Object.assign(pick(r.team, ['id', 'displayName', 'record']), { logo: logoOf(r.team, T.league), nextEvent: (r.team.nextEvent || []).slice(0, 1).map((e) => trimEvent(e, T.league)) }) }),
    });
    const t = d.team;
    const item = (t.record && t.record.items || []).find((i) => i.type === 'total') || (t.record && t.record.items || [])[0];
    const stats = Object.fromEntries(((item && item.stats) || []).map((s) => [s.name, s.value]));
    return {
      id: t.id, name: t.displayName,
      logo: t.logo,
      record: formatRecord(T.league, stats, item && item.summary),
      stats,
      next: t.nextEvent && t.nextEvent[0] ? normEvent(t.nextEvent[0], t.id, T.league) : null,
    };
  }

  async function schedule(T) {
    const base = `${SITE}/${T.sport}/${T.league}/teams/${T.id}/schedule`;
    const opts = { shape: trimSchedule(T.league) };
    const d = await get(base, scheduleLife, opts);
    const year = (d.season && d.season.year) || (d.requestedSeason && d.requestedSeason.year);
    let events = (d.events || []).map((e) => normEvent(e, T.id, T.league));
    if (T.league === 'mlb' && year) {
      // ESPN splits a baseball season into halves and the default request returns
      // only one. Each half is kept on its own: a finished half never changes.
      const current = d.season && d.season.type === 2 ? d.season.half : null; // already in d
      const halves = await Promise.all([1, 2].filter((h) => h !== current).map((h) =>
        get(`${base}?season=${year}&seasontype=2&half=${h}`, scheduleLife, opts).then((x) => x.events || []).catch(() => [])));
      const byId = new Map();
      [...halves.flat().map((e) => normEvent(e, T.id, T.league)), ...events].forEach((e) => byId.set(e.id, e));
      events = [...byId.values()];
    } else if (!events.length && year) {
      // Off-season: the default request returns an empty postseason. Show the regular season.
      const reg = await get(`${base}?season=${year}&seasontype=2`, scheduleLife, opts);
      events = (reg.events || []).map((e) => normEvent(e, T.id, T.league));
    } else if (d.season && d.season.type === 3 && year) {
      // In the playoffs: show the regular season too.
      const reg = await get(`${base}?season=${year}&seasontype=2`, scheduleLife, opts);
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
    const lists = await Promise.all(extra.map((u) => get(u, (x, t) => t + life('later'), { shape: trimSchedule(T.league) })
      .then((d) => (d.events || []).map((e) => normEvent(e, T.id, T.league))).catch(() => [])));
    const byId = new Map();
    [...lists.flat(), ...s.events].forEach((e) => byId.set(e.id, e)); // this season's copy (with live updates) wins
    return [...byId.values()].sort((a, b) => a.date - b.date);
  }

  // ---------- rosters ----------
  const rosterIndex = {}; // league -> Map(id -> athlete)
  const NFL_POS_ORDER = ['QB', 'RB', 'FB', 'WR', 'TE', 'OT', 'G', 'C', 'DE', 'DT', 'NT', 'LB', 'CB', 'S', 'K', 'P', 'LS'];

  const trimInjury = (i) => i && {
    status: i.status, type: i.type && { description: i.type.description }, date: i.date,
    details: i.details && pick(i.details, ['side', 'location', 'type']), longComment: i.longComment, shortComment: i.shortComment,
  };
  const trimAthlete = (a) => Object.assign(pick(a, ['id', 'fullName', 'displayName', 'shortName', 'jersey', 'age', 'displayHeight', 'displayWeight']), {
    position: a.position && pick(a.position, ['abbreviation', 'displayName']),
    headshot: a.headshot && { href: a.headshot.href },
    injuries: (a.injuries || []).slice(0, 1).map(trimInjury),
    status: a.status && { name: a.status.name },
  });

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
    const d = await get(`${SITE}/${T.sport}/${T.league}/teams/${T.id}/roster`, (x, t) => t + life('roster'), {
      shape: (r) => ({ athletes: (r.athletes || []).map((g) => ({ position: g.position, items: (g.items || []).map(trimAthlete) })) }),
    });
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
  // the standings stats the app reads (ESPN sends about 40 per team)
  const STAT_NAMES = ['wins', 'losses', 'ties', 'otLosses', 'overtimeLosses', 'gamesPlayed', 'points', 'winPercent', 'playoffSeed', 'regWins',
    'streak', 'Last Ten Games', 'gamesBehind', 'pointsFor', 'pointsAgainst', 'clincher'];
  const trimStandingsNode = (n, league) => n && {
    name: n.name, abbreviation: n.abbreviation,
    children: n.children && n.children.map((c) => trimStandingsNode(c, league)),
    standings: n.standings && {
      entries: (n.standings.entries || []).map((e) => ({
        team: trimTeam(e.team, league),
        stats: (e.stats || []).filter((x) => STAT_NAMES.includes(x.name)).map((x) => pick(x, ['name', 'value', 'displayValue'])),
      })),
    },
  };

  // Standings are kept for hours, but go stale as soon as a Pittsburgh game
  // has finished since they were fetched, so the record is right straight away.
  function standingsLife(league, t) {
    const T = TEAM_BY_LEAGUE[league];
    let exp = t + life('standings');
    mem.forEach((hit, url) => {
      if (!url.startsWith(`${SITE}/${T.sport}/${T.league}/teams/${T.id}/schedule`)) return;
      (hit.data.events || []).forEach((e) => {
        if (!e.competitions[0].status.type.completed) return;
        const end = +new Date(e.date) + 2.5 * H; // a little before GAME_LENGTH: finals often land sooner
        if (end > t && end < exp) exp = Math.max(end, t + 30 * MIN);
      });
    });
    return exp;
  }

  // Division-level standings: { conferences: [{ name, divisions: [{ name, entries }] }] }
  async function standings(league) {
    const d = await get(`${STANDINGS}/${SPORT_OF[league]}/${league}/standings?level=3`, (x, t) => standingsLife(league, t), {
      shape: (r) => ({ seasons: (r.seasons || []).slice(0, 1).map((s) => ({ year: s.year })), children: (r.children || []).map((c) => trimStandingsNode(c, league)) }),
    });
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

  // ---------- game summaries (box scores) ----------
  // Big (about 40 KB), so they're kept in memory only. A finished game's never changes.
  function summaryLife(d, t) {
    const type = (((d.header || {}).competitions || [{}])[0].status || {}).type || {};
    if (type.completed) return t + life('forever');
    if (type.state === 'in') return t + life('summaryLive');
    return t + life('summaryPre');
  }
  const summary = (league, eventId) => get(`${SITE}/${SPORT_OF[league]}/${league}/summary?event=${eventId}`, summaryLife, { keep: false });

  // NHL power-play details (which team, time left) for the Penguins' live game.
  // Needs the proxy; without it the app uses ESPN's yes/no power-play flag.
  // Returns undefined when it can't be known, null at even strength, or { team, time }.
  async function nhlSituation() {
    if (mode !== 'proxy') return undefined;
    try {
      const d = await get(`${NHLE}/score/now`, life('live') / 1000, { live: true });
      const g = (d.games || []).find((x) => [x.homeTeam.abbrev, x.awayTeam.abbrev].includes('PIT'));
      if (!g || !g.situation) return null;
      const s = g.situation;
      const pp = ['homeTeam', 'awayTeam'].find((k) => s[k] && (s[k].situationDescriptions || []).includes('PP'));
      return pp ? { team: s[pp].abbrev, time: s.timeRemaining, strength: `${s.awayTeam.strength}-on-${s.homeTeam.strength}`, empty: [s.homeTeam, s.awayTeam].some((t) => (t.situationDescriptions || []).includes('EN')) } : null;
    } catch (e) { return undefined; }
  }

  // ---------- players ----------
  const trimBio = (r) => {
    const a = r.athlete || {};
    return {
      athlete: Object.assign(pick(a, ['id', 'displayName', 'displayJersey', 'jersey', 'age', 'displayHeight', 'displayWeight', 'displayDOB', 'displayBirthPlace', 'displayExperience', 'displayDraft']), {
        headshot: a.headshot && { href: a.headshot.href },
        position: a.position && pick(a.position, ['abbreviation', 'displayName']),
        team: a.team && { displayName: a.team.displayName },
        injuries: (a.injuries || []).slice(0, 1).map((i) => Object.assign(trimInjury(i), { detail: i.detail })),
      }),
    };
  };
  const trimOverview = (o) => {
    const st = o.statistics;
    const gl = o.gameLog;
    const g0 = gl && gl.statistics && gl.statistics[0];
    const recent = g0 ? (g0.events || []).slice(0, 5) : [];
    return {
      statistics: st && { labels: st.labels, displayNames: st.displayNames, splits: (st.splits || []).map((s) => pick(s, ['displayName', 'stats'])) },
      gameLog: g0 && {
        statistics: [{ labels: g0.labels, displayNames: g0.displayNames, displayName: g0.displayName, events: recent }],
        events: Object.fromEntries(recent.map((g) => {
          const ev = (gl.events || {})[g.eventId] || {};
          return [g.eventId, Object.assign(pick(ev, ['atVs', 'gameDate', 'gameResult', 'score']), { opponent: ev.opponent && { abbreviation: ev.opponent.abbreviation } })];
        })),
      },
    };
  };
  async function athlete(league, id) {
    const [bio, overview] = await Promise.all([
      get(`${WEB}/${SPORT_OF[league]}/${league}/athletes/${id}`, (x, t) => t + life('bio'), { shape: trimBio }),
      get(`${WEB}/${SPORT_OF[league]}/${league}/athletes/${id}/overview`, (x, t) => t + life('overview'), { shape: trimOverview }).catch(() => null),
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
    const wanted = LEADER_CATS[T.league].map(([k]) => k);
    const d = await get(`${CORE}/${T.sport}/leagues/${T.league}/seasons/${year}/types/2/teams/${T.id}/leaders`, (x, t) => t + life('leaders'), {
      shape: (r) => ({
        categories: (r.categories || []).filter((c) => wanted.includes(c.name)).map((c) => ({
          name: c.name,
          leaders: (c.leaders || []).slice(0, 6).map((l) => ({ value: l.value, displayValue: l.displayValue, athlete: { $ref: l.athlete && l.athlete.$ref } })),
        })),
      }),
    });
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
    try {
      const a = await get(ref.replace(/^http:/, 'https:'), (x, t) => t + life('forever'), { shape: (r) => ({ displayName: r.displayName || r.fullName }) });
      return a.displayName || `#${id}`;
    } catch (e) { return `Player ${id}`; }
  }

  // ---------- playoffs ----------
  const bracketLife = (x, t) => t + life('bracket');
  const nhlBracket = (year) => get(`${NHLE}/playoff-bracket/${year}`, bracketLife);
  const mlbPostseason = (year) => get(`${MLBS}/schedule/postseason/series?season=${year}&sportId=1&hydrate=team`, bracketLife);
  // NFL playoff weeks: 1 wild card, 2 divisional, 3 conference, 5 Super Bowl (4 is the Pro Bowl)
  async function nflPostseason(year) {
    const weeks = await Promise.all([1, 2, 3, 5].map((w) =>
      get(`${SITE}/football/nfl/scoreboard?seasontype=3&week=${w}&dates=${year}`, weekLife, { shape: trimScoreboard('nfl') }).then((d) => d.events || []).catch(() => [])));
    return weeks;
  }
  const nflWeek = (year, week) => get(`${SITE}/football/nfl/scoreboard?seasontype=2&week=${week}&dates=${year}`, weekLife, { shape: trimScoreboard('nfl') });

  return {
    init, get, invalidate, health, get mode() { return mode; },
    team, schedule, allGames, roster, rosterIndex, standings, placeIn, recordFromEntry, sv, sd,
    summary, nhlSituation, athlete, leaders, LEADER_CATS,
    liveCheck, liveOf, onLive, activeGame, nextStart,
    nhlBracket, mlbPostseason, nflPostseason, nflWeek, normEvent,
    clearSaved, savedSize,
  };
})();
