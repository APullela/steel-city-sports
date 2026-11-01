/*
 * Playoff odds by simulation.
 *
 * For every team: take its record so far, pull it toward .500 (early-season
 * records say little), and play out its remaining games at that strength.
 * Do that for the whole league 4,000 times, apply the league's playoff format
 * each time, and count how often each team gets in.
 *
 * This is an estimate. It doesn't know who plays whom in the remaining games,
 * and it uses simple tiebreakers.
 */
const Odds = (() => {
  const SEASON = { nhl: 82, nfl: 17, mlb: 162 };
  // how many games of "average team" to blend in: more = more cautious early on
  const PRIOR = { nhl: 20, nfl: 6, mlb: 35 };
  const SIMS = 4000;
  const OTL_SHARE = 0.22; // share of NHL losses that come in overtime (worth a point)
  const cache = new WeakMap(); // standings object -> Map(abbr -> probability)
  const sv = (e, k) => API.sv(e, k);

  // Seeded random numbers: the same standings always give the same odds, so the
  // numbers only move when a result changes (and don't flicker every refresh).
  let rand = Math.random;
  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hash = (s) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

  function gauss() {
    let u = 0;
    while (!u) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }
  // number of successes in n tries at chance p (normal approximation for big n)
  function binom(n, p) {
    if (n <= 0) return 0;
    if (n < 30) { let k = 0; for (let i = 0; i < n; i++) if (rand() < p) k++; return k; }
    return Math.max(0, Math.min(n, Math.round(n * p + Math.sqrt(n * p * (1 - p)) * gauss())));
  }
  const clamp = (x) => Math.max(0.05, Math.min(0.95, x));

  function teamsFrom(league, st) {
    const teams = [];
    st.conferences.forEach((c, ci) => c.divisions.forEach((d, di) => d.entries.forEach((e) => {
      const w = sv(e, 'wins'), l = sv(e, 'losses'), t = sv(e, 'ties'), otl = sv(e, 'otLosses');
      const gp = league === 'nfl' ? w + l + t : sv(e, 'gamesPlayed') || w + l + (league === 'nhl' ? otl : 0);
      const pct = !gp ? 0.5 : league === 'nhl' ? sv(e, 'points') / (2 * gp) : (w + t / 2) / gp;
      const strength = 0.5 + (pct - 0.5) * (gp / (gp + PRIOR[league]));
      const clinch = e.stats.clincher && e.stats.clincher.d;
      teams.push({
        abbr: e.abbr, conf: ci, div: `${ci}-${di}`,
        base: league === 'nhl' ? sv(e, 'points') : w + t / 2,
        left: Math.max(0, SEASON[league] - gp),
        // chance of winning a game; for the NHL, solve for the win rate that gives this points share
        p: clamp(league === 'nhl' ? (strength - OTL_SHARE / 2) / (1 - OTL_SHARE / 2) : strength),
        eliminated: !!(clinch && /e/i.test(clinch)),
        made: 0, final: 0,
      });
    })));
    return teams;
  }

  const byFinal = (a, b) => b.final - a.final;

  // who gets in, given everyone's final total
  function qualifiers(league, teams) {
    const inSet = new Set();
    const confs = [...new Set(teams.map((t) => t.conf))];
    confs.forEach((c) => {
      const conf = teams.filter((t) => t.conf === c);
      const divs = [...new Set(conf.map((t) => t.div))];
      const perDiv = league === 'nhl' ? 3 : 1;          // NHL: top 3 per division; NFL/MLB: division winners
      const wild = league === 'nhl' ? 2 : 3;            // then wild cards
      divs.forEach((d) => conf.filter((t) => t.div === d).sort(byFinal).slice(0, perDiv).forEach((t) => inSet.add(t)));
      conf.filter((t) => !inSet.has(t)).sort(byFinal).slice(0, wild).forEach((t) => inSet.add(t));
    });
    return inSet;
  }

  function compute(league, st) {
    if (cache.has(st)) return cache.get(st);
    const teams = teamsFrom(league, st);
    rand = seeded(hash(league + teams.map((t) => `${t.abbr}${t.base}/${t.left}`).join(',')));
    for (let s = 0; s < SIMS; s++) {
      teams.forEach((t) => {
        let add;
        if (league === 'nhl') {
          const wins = binom(t.left, t.p);
          add = 2 * wins + binom(t.left - wins, OTL_SHARE);
        } else {
          add = binom(t.left, t.p);
        }
        t.final = t.eliminated ? -1 : t.base + add + rand() * 0.1; // the fraction breaks ties at random
      });
      qualifiers(league, teams).forEach((t) => { t.made++; });
    }
    const out = new Map(teams.map((t) => [t.abbr, t.made / SIMS]));
    cache.set(st, out);
    return out;
  }

  function format(p) {
    if (p == null) return '—';
    if (p < 0.005) return p === 0 ? '0%' : '<1%';
    if (p > 0.995) return p === 1 ? '100%' : '>99%';
    return `${Math.round(p * 100)}%`;
  }

  return { compute, format, SIMS };
})();
