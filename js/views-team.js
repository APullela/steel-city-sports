/*
 * Home dashboard and the three team pages.
 * Each view has render(root) for a full draw and refresh(root) for the
 * periodic update, which only redraws the parts that change during a game
 * (so a half-typed roster search isn't wiped out every 10 seconds).
 */
const Views = window.Views || (window.Views = {});

(() => {
  const { esc } = UI;
  const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  const shortDiv = (name = '') => name
    .replace(' Division', '')
    .replace('American League', 'AL').replace('National League', 'NL');
  const lastName = (n = '') => (n.split(' ').length > 1 ? n.split(' ').slice(1).join(' ') : n);
  const gameHref = (league, id) => `#game/${league}/${id}`;
  const playerHref = (league, id, eventId) => `#player/${league}/${id}${eventId ? '/' + eventId : ''}`;

  // ---------- loading one team's data ----------
  async function loadTeam(T) {
    const [info, sched, st, live] = await Promise.all([
      API.team(T),
      API.schedule(T),
      API.standings(T.league).catch(() => null),
      API.liveGame(T, App.liveAny ? 8 : 60).catch(() => null),
    ]);
    const now = Date.now();
    const events = sched.events;
    let liveEv = live && live.state === 'in' ? live : events.find((e) => e.state === 'in') || null;
    const done = events.filter((e) => e.completed);
    const last = done[done.length - 1] || null;
    const upcoming = events.filter((e) => e.state === 'pre' && +e.date > now - 3 * 3600e3);
    const next = upcoming.find((e) => !liveEv || e.id !== liveEv.id) || null;
    const place = st ? API.placeIn(st, T.id) : null;
    const offseason = !liveEv && !upcoming.length;
    // playoff odds only make sense during the regular season
    const odds = !offseason && sched.type !== 3 && st ? Odds.compute(T.league, st).get('PIT') : null;
    return { T, info, sched, st, place, live: liveEv, last, next, offseason, events, odds };
  }
  Views.loadTeam = loadTeam;

  function standingText(d) {
    if (!d.place) return '';
    return `${ordinal(d.place.rank)} in ${shortDiv(d.place.div.name)}`;
  }

  // ---------- pieces shared with the game view ----------
  // "Crosby: 1G, 2A" style line for Pittsburgh's best player in a finished game.
  function topPerformer(sum, T) {
    if (!sum || !sum.boxscore) return '';
    const mine = (sum.boxscore.players || []).find((p) => String(p.team.id) === T.id);
    if (T.league === 'nfl') {
      const l = (sum.leaders || []).find((x) => String(x.team.id) === T.id);
      if (!l) return '';
      const pick = ['passingYards', 'rushingYards', 'receivingYards'].map((k) => l.leaders.find((c) => c.name === k)).filter((c) => c && c.leaders[0]);
      // whoever had the most yards: a 120-yard rusher beats a 150-yard passer
      const scored = pick.map((c) => ({ c, yds: parseFloat((c.leaders[0].displayValue.match(/([\d,]+) YDS/) || [0, '0'])[1].replace(',', '')) * (c.name === 'passingYards' ? 0.55 : 1) }));
      scored.sort((a, b) => b.yds - a.yds);
      if (!scored[0]) return '';
      const top = scored[0].c.leaders[0];
      return `${lastName(top.athlete.displayName)}: ${top.displayValue}`;
    }
    if (!mine) return '';
    if (T.league === 'nhl') {
      let best = null;
      mine.statistics.forEach((g) => {
        const iG = g.labels.indexOf('G'), iA = g.labels.indexOf('A');
        if (iG < 0 || iA < 0) return;
        g.athletes.forEach((a) => {
          const goals = +a.stats[iG] || 0, ast = +a.stats[iA] || 0;
          const score = goals * 2.1 + ast * 2;
          if (score > 0 && (!best || score > best.score)) best = { score, name: a.athlete.displayName, goals, ast };
        });
      });
      if (best) return `${lastName(best.name)}: ${[best.goals && `${best.goals}G`, best.ast && `${best.ast}A`].filter(Boolean).join(', ')}`;
      const goalie = mine.statistics.find((g) => g.name === 'goalies');
      const g0 = goalie && goalie.athletes[0];
      if (g0) {
        const i = goalie.labels.indexOf('SV'), j = goalie.labels.indexOf('SA');
        return `${lastName(g0.athlete.displayName)}: ${g0.stats[i]} saves on ${g0.stats[j]} shots`;
      }
      return '';
    }
    // MLB: the best line at the plate
    const bat = mine.statistics.find((g) => (g.type || g.name) === 'batting');
    if (!bat) return '';
    const L = (k) => bat.labels.indexOf(k);
    let best = null;
    bat.athletes.forEach((a) => {
      const s = (k) => +a.stats[L(k)] || 0;
      const score = s('H') + s('HR') * 2 + s('RBI') + s('R') * 0.5;
      if (!best || score > best.score) best = { score, a, s };
    });
    if (!best || !best.score) return '';
    const s = best.s;
    const bits = [`${s('H')}-${s('AB')}`];
    if (s('HR')) bits.push(s('HR') > 1 ? `${s('HR')} HR` : 'HR');
    if (s('RBI')) bits.push(`${s('RBI')} RBI`);
    if (s('R')) bits.push(`${s('R')} R`);
    return `${lastName(best.a.athlete.displayName)}: ${bits.join(', ')}`;
  }
  Views.topPerformer = topPerformer;

  // Live details: possession (NFL), outs/bases/count (MLB), power play (NHL).
  function situationHTML(ev, T, extra = {}) {
    const s = ev.situation || {};
    const out = [];
    if (T.league === 'nfl') {
      if (s.possession) {
        const who = s.possession === ev.us.id ? ev.us.abbr : ev.them.abbr;
        out.push(`<span class="sit"><b>Ball:</b> ${esc(who)} <span aria-hidden="true">🏈</span></span>`);
      }
      if (s.downDistanceText) out.push(`<span class="sit">${esc(s.downDistanceText)}</span>`);
      if (s.isRedZone) out.push('<span class="sit red">Red zone</span>');
    } else if (T.league === 'mlb') {
      const on = (b) => (s[b] ? 'on' : '');
      out.push(`<span class="sit bases" aria-label="Runners: ${['onFirst', 'onSecond', 'onThird'].filter((b) => s[b]).map((b) => b.replace('on', '')).join(', ') || 'none'}">
        <svg viewBox="0 0 40 30" aria-hidden="true"><rect class="${on('onSecond')}" x="15" y="2" width="10" height="10" transform="rotate(45 20 7)"/>
        <rect class="${on('onThird')}" x="4" y="13" width="10" height="10" transform="rotate(45 9 18)"/>
        <rect class="${on('onFirst')}" x="26" y="13" width="10" height="10" transform="rotate(45 31 18)"/></svg></span>`);
      if (s.outs != null) out.push(`<span class="sit"><b>${s.outs}</b> out${s.outs === 1 ? '' : 's'} <span class="outs" aria-hidden="true">${[0, 1, 2].map((i) => `<i class="${i < s.outs ? 'on' : ''}"></i>`).join('')}</span></span>`);
      if (s.balls != null) out.push(`<span class="sit">Count ${s.balls}-${s.strikes}</span>`);
      if (s.batter && s.batter.athlete) out.push(`<span class="sit">At bat: ${esc(s.batter.athlete.shortName || s.batter.athlete.displayName)}</span>`);
    } else if (T.league === 'nhl') {
      if (extra.pp) out.push(`<span class="sit red">Power play: ${esc(extra.pp.team)}${extra.pp.time ? ` (${esc(extra.pp.time)})` : ''}</span>`);
      else if (extra.pp === null) out.push('<span class="sit">Even strength</span>');
      if (extra.pp && extra.pp.empty) out.push('<span class="sit">Empty net</span>');
    }
    return out.length ? `<div class="situation">${out.join('')}</div>` : '';
  }
  Views.situationHTML = situationHTML;

  const vsAt = (ev) => (ev.home ? 'vs' : 'at');
  const scoreLine = (ev, flashKey) => `<div class="scoreline">
      <span class="side">${UI.logo(ev.us.logo, ev.us.name, 'logo sm')}<b>${esc(ev.us.abbr)}</b><span class="pts" data-flash="${flashKey}-us">${esc(ev.us.score ?? '-')}</span></span>
      <span class="dash" aria-hidden="true">–</span>
      <span class="side"><span class="pts" data-flash="${flashKey}-them">${esc(ev.them.score ?? '-')}</span><b>${esc(ev.them.abbr)}</b>${UI.logo(ev.them.logo, ev.them.name, 'logo sm')}</span>
    </div>`;

  function seriesVs(d, oppId) {
    const games = d.events.filter((e) => e.completed && e.them.id === oppId);
    const w = games.filter((g) => g.result === 'W').length;
    const l = games.filter((g) => g.result === 'L').length;
    const t = games.filter((g) => g.result === 'T').length;
    return { games, text: `${w}-${l}${t ? '-' + t : ''}`, last: games[games.length - 1] };
  }

  // ---------- the three game cards ----------
  function lastCard(d, perf) {
    const ev = d.last;
    if (!ev) return `<article class="card game-card"><h3>Last game</h3>${UI.empty('No games played yet this season.')}</article>`;
    return `<article class="card game-card clickable" data-href="${gameHref(d.T.league, ev.id)}" tabindex="0" role="link"
        aria-label="Last game: ${esc(ev.us.abbr)} ${esc(ev.us.score)}, ${esc(ev.them.name)} ${esc(ev.them.score)}. Open box score.">
      <h3>Last game ${UI.badge(ev.result, ev.detail)}</h3>
      <div class="opp">${UI.logo(ev.them.logo, ev.them.name)}<div><b>${vsAt(ev)} ${esc(ev.them.name)}</b><span>${esc(UI.dayLabel(ev.date))} · ${esc(ev.detail)}</span></div></div>
      ${scoreLine(ev, 'last')}
      <p class="performer">${perf ? `<b>Top performer</b> ${esc(perf)}` : '<span class="muted">Box score inside</span>'}</p>
    </article>`;
  }

  function currentCard(d, pp) {
    const ev = d.live;
    if (!ev) {
      const nx = d.next || d.info.next;
      return `<article class="card game-card quiet"><h3>Current game</h3>
        <p class="nogame">No game right now</p>
        ${nx ? `<p class="muted">Next: ${vsAt(nx)} ${esc(nx.them.short || nx.them.name)}</p><p class="big-count">${UI.countdown(nx.date, 'Time until the next game')}</p>` : ''}
      </article>`;
    }
    const delayed = ev.flag ? UI.flagPill(ev.flag) : '';
    return `<article class="card game-card is-live clickable" data-href="${gameHref(d.T.league, ev.id)}" tabindex="0" role="link"
        aria-label="Live: ${esc(ev.us.abbr)} ${esc(ev.us.score)}, ${esc(ev.them.abbr)} ${esc(ev.them.score)}, ${esc(ev.detail)}">
      <h3>Current game ${UI.live()} ${delayed}</h3>
      <div class="opp">${UI.logo(ev.them.logo, ev.them.name)}<div><b>${vsAt(ev)} ${esc(ev.them.name)}</b><span data-flash="cur-detail">${esc(ev.detail)}</span></div></div>
      ${scoreLine(ev, 'cur')}
      ${d.T.league !== 'mlb' ? `<p class="period">${esc(d.T.unit)} ${esc(ev.period || '')}${ev.clock ? ` · <span data-flash="cur-clock">${esc(ev.clock)}</span>` : ''}</p>` : ''}
      ${situationHTML(ev, d.T, { pp })}
    </article>`;
  }

  function nextCard(d) {
    const ev = d.next;
    if (!ev) return `<article class="card game-card"><h3>Next game</h3>${UI.empty('Nothing scheduled.')}</article>`;
    const h2h = seriesVs(d, ev.them.id);
    const lastMeet = h2h.last
      ? `Last meeting: ${h2h.last.result} ${esc(h2h.last.us.score)}-${esc(h2h.last.them.score)}, ${esc(UI.shortDate(h2h.last.date))}`
      : 'First meeting this season';
    return `<article class="card game-card">
      <h3>Next game ${UI.flagPill(ev.flag)}</h3>
      <div class="opp">${UI.logo(ev.them.logo, ev.them.name)}<div><b>${vsAt(ev)} ${esc(ev.them.name)}</b><span>${ev.home ? 'Home' : 'Away'}${ev.them.record ? ` · they're ${esc(ev.them.record)}` : ''}</span></div></div>
      <dl class="facts">
        <div><dt>When</dt><dd>${esc(UI.when(ev.date, ev.timeKnown))}</dd></div>
        ${ev.venue ? `<div><dt>Where</dt><dd>${esc(ev.venue)}${ev.city ? `, ${esc(ev.city)}` : ''}</dd></div>` : ''}
        ${ev.tv.length ? `<div><dt>Watch</dt><dd>${esc(ev.tv.join(', '))}</dd></div>` : ''}
        <div><dt>Series</dt><dd>${h2h.games.length ? `${esc(h2h.text)} this season` : 'No games yet'}. ${lastMeet}</dd></div>
      </dl>
      <p class="big-count">${UI.countdown(ev.date, 'Time until the next game')}</p>
    </article>`;
  }

  function offseasonCards(d) {
    const s = d.info.stats || {};
    const home = d.events.filter((e) => e.completed && e.home), away = d.events.filter((e) => e.completed && !e.home);
    const wl = (list) => `${list.filter((e) => e.result === 'W').length}-${list.filter((e) => e.result === 'L').length}`;
    const entry = d.place && d.place.entry;
    const clinch = entry && entry.stats.clincher && entry.stats.clincher.d;
    const made = clinch && /[xyzw*]/i.test(clinch);
    const diff = s.pointsFor != null ? s.pointsFor - s.pointsAgainst : null;
    const nx = d.info.next;
    return `<article class="card game-card"><h3>Season summary</h3>
        <p class="big">${esc(d.info.record)}</p>
        <p>${esc(standingText(d) || '')}${made ? '. Made the playoffs.' : '. Missed the playoffs.'}</p>
        <dl class="facts">
          <div><dt>Home</dt><dd>${wl(home)}</dd></div><div><dt>Away</dt><dd>${wl(away)}</dd></div>
          ${diff != null ? `<div><dt>${d.T.league === 'mlb' ? 'Run' : 'Point'} diff.</dt><dd>${diff > 0 ? '+' : ''}${diff}</dd></div>` : ''}
        </dl>
      </article>
      ${lastCard(d, d.perf)}
      <article class="card game-card"><h3>Next season</h3>
        ${nx ? `<p>${nx.seasonType === 1 ? (d.T.league === 'mlb' ? 'Spring training opens: ' : 'Preseason opens: ') : ''}${esc(nx.name || '')}</p><p class="muted">${esc(UI.when(nx.date, nx.timeKnown))}</p><p class="big-count">${UI.countdown(nx.date, 'Time until next season')}</p>`
        : UI.empty('The new schedule has not been released yet.')}
      </article>`;
  }

  // ---------- team page sections ----------
  const scheduleFilter = {}; // team key -> 'all' | 'home' | 'away'
  function scheduleHTML(d) {
    const f = scheduleFilter[d.T.key] || 'all';
    const list = d.events.filter((e) => f === 'all' || (f === 'home') === e.home);
    // played games newest first; games still to come in a separate list, soonest first
    const played = list.filter((e) => e.completed || e.state === 'in' || (e.flag && +e.date < Date.now())).sort((a, b) => b.date - a.date);
    const ahead = list.filter((e) => !played.includes(e));
    const block = (title, games, note) => (games.length ? `<h3 class="sched-title">${title} <small>${games.length}${note ? ' · ' + note : ''}</small></h3><ol class="sched card">${rowsFor(games)}</ol>` : '');
    const btn = (v, label) => `<button type="button" class="seg${f === v ? ' on' : ''}" data-action="sched-filter" data-team="${d.T.key}" data-v="${v}" aria-pressed="${f === v}">${label}</button>`;
    return `<div class="section-head"><h2 id="schedule">Schedule</h2><div class="segs" role="group" aria-label="Filter games">${btn('all', 'All')}${btn('home', 'Home')}${btn('away', 'Away')}</div></div>
      ${d.sched.byeWeek ? `<p class="muted">Bye week: ${esc(d.sched.byeWeek.number ? `Week ${d.sched.byeWeek.number}` : '')}</p>` : ''}
      ${block('Results', played, 'most recent first')}${block('Coming up', ahead, 'next game first')}
      ${!list.length ? UI.empty('No games.') : ''}`;
  }

  function rowsFor(list) {
    let month = '';
    return list.map((e) => {
      const m = e.date.toLocaleDateString([], { month: 'long', year: 'numeric' });
      const head = m !== month ? `<li class="month">${esc(m)}</li>` : '';
      month = m;
      const res = e.state === 'in' ? `${UI.live()} ${esc(e.us.score)}-${esc(e.them.score)}`
        : e.completed ? `${UI.badge(e.result, e.detail)} ${esc(e.us.score)}-${esc(e.them.score)} <small>${/OT|SO/.test(e.detail) ? esc(e.detail.replace('Final/', '')) : ''}</small>`
        : e.flag ? UI.flagPill(e.flag)
        : `${esc(UI.time(e.date))}${e.tv.length ? ` <small>${esc(e.tv[0])}</small>` : ''}`;
      const clickable = e.completed || e.state === 'in';
      return `${head}<li class="sched-row${clickable ? ' clickable' : ''}${e.state === 'in' ? ' is-live' : ''}" ${clickable ? `data-href="${gameHref(e.league, e.id)}" tabindex="0" role="link"` : ''}>
        <span class="d">${esc(e.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}</span>
        <span class="o">${e.home ? 'vs' : '@'} ${UI.logo(e.them.logo, e.them.name, 'logo xs')} ${esc(e.them.short || e.them.name)}${e.seasonType === 3 ? ' <small>playoffs</small>' : ''}</span>
        <span class="r">${res}</span></li>`;
    }).join('');
  }

  function standingsHTML(d) {
    if (!d.place) return `<h2 id="standings">Standings</h2>${UI.empty('Standings are unavailable right now.')}`;
    const L = d.T.league;
    const cols = {
      nhl: [['GP', 'gamesPlayed'], ['PTS', 'points'], ['Last 10', 'Last Ten Games'], ['Streak', 'streak']],
      nfl: [['PCT', 'winPercent'], ['PF', 'pointsFor'], ['PA', 'pointsAgainst'], ['Streak', 'streak']],
      mlb: [['PCT', 'winPercent'], ['GB', 'gamesBehind'], ['Last 10', 'Last Ten Games'], ['Streak', 'streak']],
    }[L];
    const rows = d.place.div.entries.map((e, i) => {
      const mine = e.teamId === d.T.id;
      return `<tr class="${mine ? 'mine' : ''}"${mine ? ' aria-current="true"' : ''}>
        <td>${i + 1}</td>
        <th scope="row">${UI.logo(e.logo, e.name, 'logo xs')} ${esc(e.short)}${mine ? ' <span class="you">★ you</span>' : ''}</th>
        <td class="num">${API.recordFromEntry(L, e)}</td>
        ${cols.map(([, k]) => `<td class="num">${esc(String(API.sd(e, k)).replace(', 0 PTS', ''))}</td>`).join('')}
      </tr>`;
    }).join('');
    return `<h2 id="standings">${esc(d.place.div.name)}</h2>
      <div class="table-wrap card"><table class="standings"><thead><tr><th scope="col">#</th><th scope="col">Team</th><th scope="col" class="num">Record</th>
      ${cols.map(([t]) => `<th scope="col" class="num">${t}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  const rosterState = {}; // team key -> { q, pos }
  function rosterHTML(T, groups) {
    const st = rosterState[T.key] || { q: '', pos: '' };
    const q = st.q.trim().toLowerCase();
    const shown = groups.filter((g) => !st.pos || g.key === st.pos).map((g) => {
      const list = g.athletes.filter((a) => !q || a.name.toLowerCase().includes(q) || a.jersey === q);
      if (!list.length) return '';
      return `<h3 class="group">${esc(g.label)} <small>${list.length}</small></h3><ul class="roster">${list.map((a) => `
        <li>${UI.star(T.league, a.id, a.name)}
          <span class="jersey">${esc(a.jersey ? '#' + a.jersey : '')}</span>
          <a href="${playerHref(T.league, a.id)}" class="pname">${esc(a.name)}</a>
          <span class="muted">${esc(a.pos)}${a.age ? ` · ${a.age}` : ''}${a.ht ? ` · ${esc(a.ht)}` : ''}${a.wt ? `, ${esc(a.wt)}` : ''}</span>
          ${a.injury ? `<span class="inj-pill">${esc(a.injury.status)}</span>` : ''}
        </li>`).join('')}</ul>`;
    }).join('');
    return shown || UI.empty('No players match.');
  }

  function rosterSection(T, groups) {
    const st = rosterState[T.key] || (rosterState[T.key] = { q: '', pos: '' });
    return `<div class="section-head"><h2 id="roster">Roster</h2>
        <div class="filters">
          <label class="sr-only" for="rq-${T.key}">Search the roster</label>
          <input id="rq-${T.key}" type="search" placeholder="Name or number" value="${esc(st.q)}" data-action="roster-q" data-team="${T.key}">
          <label class="sr-only" for="rp-${T.key}">Position</label>
          <select id="rp-${T.key}" data-action="roster-pos" data-team="${T.key}">
            <option value="">All positions</option>${groups.map((g) => `<option value="${esc(g.key)}"${st.pos === g.key ? ' selected' : ''}>${esc(g.label)}</option>`).join('')}
          </select></div></div>
      <div class="card" id="roster-list-${T.key}">${rosterHTML(T, groups)}</div>`;
  }

  function leadersHTML(T, cats) {
    return `<h2 id="leaders">Team leaders</h2><div class="grid4">${cats.map((c) => `
      <div class="card leader"><h3>${esc(c.label)}</h3>${c.leaders.length ? `<ol>${c.leaders.map((l, i) => `
        <li><span class="rank">${i + 1}</span><a href="${playerHref(T.league, l.id)}">${esc(l.name)}</a><b>${esc(l.value)}</b></li>`).join('')}</ol>` : UI.empty('No stats yet.')}
      </div>`).join('')}</div>`;
  }

  function injuriesHTML(T, groups) {
    const seen = new Set();
    const list = [];
    groups.forEach((g) => g.athletes.forEach((a) => {
      if (seen.has(a.id)) return;
      if (a.injury || /Injured/.test(g.label)) { seen.add(a.id); list.push(a); }
    }));
    if (!list.length) return `<h2 id="injuries">Injury report</h2>${UI.empty('No injuries reported.')}`;
    return `<h2 id="injuries">Injury report</h2>${UI.table(
      [{ label: 'Player' }, { label: 'Pos' }, { label: 'Status' }, { label: 'Detail' }, { label: 'Updated' }],
      list.map((a) => [
        { html: `<a href="${playerHref(T.league, a.id)}">${esc(a.name)}</a>`, v: a.name },
        a.pos,
        { html: `<span class="inj-pill">${esc(a.injury ? a.injury.status : 'Out')}</span>`, v: a.injury ? a.injury.status : 'Out' },
        a.injury ? a.injury.detail || '—' : a.group,
        a.injury && a.injury.date ? { html: esc(UI.shortDate(new Date(a.injury.date))), v: a.injury.date } : '—',
      ]), { cls: 'card' })}`;
  }

  function headHTML(d) {
    const live = d.live ? ` ${UI.live()}` : '';
    return `<div class="team-head">${UI.logo(d.info.logo, d.T.full, 'logo xl')}
      <div><h1>${esc(d.T.name)}${live}</h1>
      <p class="team-sub"><span data-flash="rec-${d.T.key}">${esc(d.info.record)}</span>${standingText(d) ? ` · ${esc(standingText(d))}` : ''}${d.sched.seasonName ? ` · ${esc(d.sched.seasonName)} season` : ''}</p>
      ${d.odds != null ? `<a class="odds-pill" href="#playoffs" title="Simulated ${Odds.SIMS.toLocaleString()} times from the current standings">Playoff odds <b data-flash="odds-${d.T.key}">${Odds.format(d.odds)}</b></a>` : ''}</div></div>`;
  }

  async function cardsHTML(d) {
    // the last game's summary gives us its top performer
    if (d.last) {
      try { d.perf = topPerformer(await API.summary(d.T.league, d.last.id, 3600), d.T); } catch (e) { d.perf = ''; }
    }
    if (d.offseason) return `<p class="offseason-note">The ${esc(d.T.name)} season is over.</p><div class="grid3">${offseasonCards(d)}</div>`;
    const pp = d.live && d.T.league === 'nhl' ? await API.nhlSituation() : null;
    return `<div class="grid3">${lastCard(d, d.perf)}${currentCard(d, pp)}${nextCard(d)}</div>`;
  }

  // ---------- team view ----------
  Views.team = {
    async render(root, { team }) {
      const T = TEAMS[team];
      root.innerHTML = `<div class="team-head skel"><div class="sk sk-logo"></div><div class="sk sk-title"></div></div>${UI.skeleton('cards')}${UI.skeleton('rows', 6)}`;
      const d = await loadTeam(T);
      App.noteLive(T.key, d.live);
      root.innerHTML = `
        <div data-part="head">${headHTML(d)}</div>
        <nav class="jump" aria-label="On this page"><a href="#" data-jump="games">Games</a><a href="#" data-jump="schedule">Schedule</a><a href="#" data-jump="roster">Roster</a><a href="#" data-jump="leaders">Leaders</a><a href="#" data-jump="standings">Standings</a><a href="#" data-jump="injuries">Injuries</a></nav>
        <h2 id="games" class="sr-only">Games</h2>
        <div data-part="cards">${await cardsHTML(d)}</div>
        <section data-part="schedule">${scheduleHTML(d)}</section>
        <section data-part="roster">${UI.skeleton('rows', 5)}</section>
        <section data-part="leaders">${UI.skeleton('cards', 4)}</section>
        <section data-part="standings">${standingsHTML(d)}</section>
        <section data-part="injuries"></section>`;
      root._team = d;

      loadExtras(root, T, d);
    },

    async refresh(root, { team }) {
      const T = TEAMS[team];
      const d = await loadTeam(T);
      App.noteLive(T.key, d.live);
      const set = (part, html) => { const el = root.querySelector(`[data-part="${part}"]`); if (el) el.innerHTML = html; };
      set('head', headHTML(d));
      set('cards', await cardsHTML(d));
      set('schedule', scheduleHTML(d));
      set('standings', standingsHTML(d));
      root._team = d;
      if (!root._roster) loadExtras(root, T, d); // retry anything that failed the first time
    },

    // live UI state that main.js updates from inputs
    setScheduleFilter(team, v) { scheduleFilter[team] = v; },
    setRoster(root, team, patch) {
      const T = TEAMS[team];
      rosterState[team] = Object.assign(rosterState[team] || { q: '', pos: '' }, patch);
      const box = root.querySelector(`#roster-list-${team}`);
      if (box && root._roster) box.innerHTML = rosterHTML(T, root._roster);
    },
    scheduleHTML,
  };

  // Roster, leaders and injuries load after the rest of the page is up.
  function loadExtras(root, T, d) {
      API.roster(T).then((groups) => {
        root._roster = groups;
        const r = root.querySelector('[data-part="roster"]');
        if (r) r.innerHTML = rosterSection(T, groups);
        const i = root.querySelector('[data-part="injuries"]');
        if (i) i.innerHTML = injuriesHTML(T, groups);
        return API.leaders(T, d.sched.year);
      }).then((cats) => {
        const l = root.querySelector('[data-part="leaders"]');
        if (l) l.innerHTML = leadersHTML(T, cats);
      }).catch(() => {
        root.querySelectorAll('[data-part="roster"], [data-part="leaders"]').forEach((el) => {
          if (el.querySelector('.skel')) el.innerHTML = UI.empty('Could not load this section. It will retry on the next refresh.');
        });
      });
  }

  // ---------- home ----------
  function liveBanner(all) {
    const live = all.filter((d) => d.live);
    if (!live.length) return '';
    return `<section class="live-banner" aria-label="Live now">${live.map((d) => `
      <a class="live-item" href="${gameHref(d.T.league, d.live.id)}">${UI.live()}
        ${UI.logo(d.info.logo, d.T.full, 'logo sm')}<b>${esc(d.T.name)}</b>
        <span class="pts" data-flash="banner-${d.T.key}-us">${esc(d.live.us.score)}</span>–<span class="pts" data-flash="banner-${d.T.key}-them">${esc(d.live.them.score)}</span>
        <span>${esc(d.live.them.abbr)}</span><span class="muted" data-flash="banner-${d.T.key}-d">${esc(d.live.detail)}</span></a>`).join('')}
    </section>`;
  }

  function summaryCard(d) {
    const last = d.last, next = d.next || d.info.next;
    return `<article class="card team-card clickable team-${d.T.key}" data-href="#${d.T.key}" tabindex="0" role="link" aria-label="${esc(d.T.full)}: open team page">
      <div class="tc-head">${UI.logo(d.info.logo, d.T.full, 'logo lg')}<div><h2>${esc(d.T.name)}${d.live ? ` ${UI.live()}` : ''}</h2>
        <p class="team-sub"><b data-flash="home-rec-${d.T.key}">${esc(d.info.record)}</b>${standingText(d) ? ` · ${esc(standingText(d))}` : ''}</p></div></div>
      ${d.live ? `<p class="tc-line"><span class="lbl">Now</span> ${vsAt(d.live)} ${esc(d.live.them.abbr)} <b data-flash="home-live-${d.T.key}">${esc(d.live.us.score)}-${esc(d.live.them.score)}</b> <span class="muted">${esc(d.live.detail)}</span></p>` : ''}
      <p class="tc-line"><span class="lbl">Last</span> ${last ? `${UI.badge(last.result, last.detail)} ${esc(last.us.score)}-${esc(last.them.score)} ${vsAt(last)} ${esc(last.them.abbr)} <span class="muted">${esc(UI.shortDate(last.date))}</span>` : '<span class="muted">None yet</span>'}</p>
      <p class="tc-line"><span class="lbl">Next</span> ${next ? `${d.offseason ? '' : `${vsAt(next)} ${esc(next.them.abbr)} `}<span class="muted">${esc(d.offseason ? (next.seasonType === 1 && d.T.league === 'mlb' ? 'Spring training: ' : '') + (next.shortName || next.name || '') + ', ' : '')}${esc(UI.when(next.date, next.timeKnown))}</span>` : '<span class="muted">TBA</span>'}</p>
      ${d.offseason ? '<p class="tc-line muted">Off-season</p>' : next ? `<p class="tc-line"><span class="lbl">In</span> ${UI.countdown(next.date)}</p>` : ''}
      ${d.odds != null ? `<p class="tc-line"><span class="lbl">Odds</span> <b data-flash="home-odds-${d.T.key}">${Odds.format(d.odds)}</b> <span class="muted">to make the playoffs</span></p>` : ''}
    </article>`;
  }

  function weekCalendar(all) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
    const cols = days.map((day) => {
      const games = [];
      all.forEach((d) => d.events.forEach((e) => { if (UI.sameDay(e.date, day)) games.push({ d, e }); }));
      games.sort((a, b) => a.e.date - b.e.date);
      return `<li class="day${UI.sameDay(day, new Date()) ? ' today' : ''}"><h3>${esc(day.toLocaleDateString([], { weekday: 'short' }))} <span>${day.getDate()}</span></h3>
        ${games.length ? games.map(({ d, e }) => `<a class="cal-game team-${d.T.key}" href="${e.state === 'pre' ? '#' + d.T.key : gameHref(d.T.league, e.id)}">
          <span class="tag">${d.T.short}</span> ${e.home ? 'vs' : '@'} ${esc(e.them.abbr)}
          <small>${e.state === 'in' ? 'LIVE' : e.completed ? `${e.result} ${esc(e.us.score)}-${esc(e.them.score)}` : e.flag || esc(UI.time(e.date))}</small></a>`).join('') : '<p class="muted">—</p>'}
      </li>`;
    }).join('');
    return `<h2>This week</h2><ol class="week">${cols}</ol>
      <p class="legend"><span class="tag team-penguins">PEN</span> Penguins <span class="tag team-pirates">PIR</span> Pirates <span class="tag team-steelers">STL</span> Steelers</p>`;
  }

  async function favoritesHTML() {
    const favs = UI.favorites.all();
    if (!favs.length) return '';
    const cards = await Promise.all(favs.map(async (f) => {
      try {
        const { bio, overview } = await API.athlete(f.league, f.id);
        const st = overview && overview.statistics;
        const split = st && st.splits && st.splits[0];
        const line = split ? st.labels.slice(0, 5).map((l, i) => `${l} ${split.stats[i]}`).join(' · ') : 'No stats yet';
        return `<li class="card fav"><div class="fav-head">${bio.headshot ? `<img class="headshot sm" src="${esc(bio.headshot.href)}" alt="${esc(bio.displayName)}">` : ''}
          <div><a href="${playerHref(f.league, f.id)}"><b>${esc(bio.displayName || f.name)}</b></a><span class="muted">${esc(TEAM_BY_LEAGUE[f.league].name)} · ${esc(bio.position ? bio.position.abbreviation : '')}</span></div>
          ${UI.star(f.league, f.id, bio.displayName || f.name)}</div><p class="fav-line">${esc(split ? split.displayName : '')}: ${esc(line)}</p></li>`;
      } catch (e) { return `<li class="card fav"><b>${esc(f.name)}</b> <span class="muted">stats unavailable</span> ${UI.star(f.league, f.id, f.name)}</li>`; }
    }));
    return `<h2>Pinned players</h2><ul class="favs">${cards.join('')}</ul>`;
  }

  async function homeHTML() {
    const all = await Promise.all(Object.values(TEAMS).map((T) => loadTeam(T).catch(() => null)));
    const ok = all.filter(Boolean);
    ok.forEach((d) => App.noteLive(d.T.key, d.live));
    const favs = await favoritesHTML();
    return `<div data-part="banner">${liveBanner(ok)}</div>
      ${favs ? `<section data-part="favs">${favs}</section>` : ''}
      <h1 class="sr-only">Dashboard</h1>
      <div class="grid3">${ok.map(summaryCard).join('')}${all.length !== ok.length ? `<div class="card">${UI.empty('Some teams could not be loaded.')}</div>` : ''}</div>
      <section class="card week-card">${weekCalendar(ok)}</section>`;
  }

  Views.home = {
    async render(root) {
      root.innerHTML = `${UI.skeleton('cards')}${UI.skeleton('rows', 4)}`;
      root.innerHTML = await homeHTML();
    },
    async refresh(root) { root.innerHTML = await homeHTML(); },
  };
})();
