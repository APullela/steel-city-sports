/*
 * Game detail (box score, team stat bars, player tables, scoring timeline)
 * and player detail (bio, this game, season/career, last-5 trend, injury).
 */
(() => {
  const { esc } = UI;
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  const title = (s = '') => s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
  const playerHref = (league, id, eventId) => `#player/${league}/${id}${eventId ? '/' + eventId : ''}`;

  function backButton(fallback) {
    return `<button type="button" class="back" data-action="back" data-fallback="${esc(fallback)}"><span aria-hidden="true">←</span> Back</button>`;
  }

  // ---------- team stats comparison ----------
  const num = (s) => {
    if (s == null) return 0;
    const t = String(s);
    if (/^\d+:\d{2}$/.test(t)) { const [m, sec] = t.split(':'); return +m * 60 + +sec; } // possession time
    if (/^\d+-\d+$/.test(t)) return +t.split('-')[0];                                   // "6-57" penalties, "10-16" 3rd downs
    return parseFloat(t) || 0;
  };
  // [label shown, keys to look for]
  const COMPARE = {
    nhl: [['Shots', ['Shots']], ['Faceoff %', ['Faceoff Win Percent']], ['Hits', ['Hits']], ['Blocked shots', ['Blocked Shots']],
      ['Power play goals', ['Power Play Goals']], ['Penalty minutes', ['Penalty Minutes']], ['Giveaways', ['Giveaways']], ['Takeaways', ['Takeaways']]],
    nfl: [['Total yards', ['Total Yards']], ['Passing yards', ['Passing']], ['Rushing yards', ['Rushing']], ['First downs', ['1st Downs']],
      ['3rd down conversions', ['3rd down efficiency']], ['Turnovers', ['Turnovers']], ['Penalties', ['Penalties']], ['Time of possession', ['Possession']]],
    mlb: [['Runs', ['batting.R']], ['Hits', ['batting.H']], ['Home runs', ['batting.HR']], ['Walks', ['batting.BB']], ['Strikeouts (batting)', ['batting.SO', 'batting.K']],
      ['Left on base', ['batting.LOB']], ['Errors', ['fielding.E']], ['Pitches', ['pitching.P', 'pitching.PC', 'pitching.#P']]],
  };
  function statMap(teamBox) {
    const m = new Map();
    (teamBox.statistics || []).forEach((s) => {
      if (s.stats) s.stats.forEach((x) => { m.set(`${s.name}.${x.abbreviation}`, x.displayValue); m.set(`${s.name}.${x.name}`, x.displayValue); });
      else m.set(s.label || s.name, s.displayValue);
    });
    return m;
  }
  function compareHTML(sum, league, away, home) {
    const boxes = (sum.boxscore && sum.boxscore.teams) || [];
    const A = boxes.find((t) => String(t.team.id) === away.id), H = boxes.find((t) => String(t.team.id) === home.id);
    if (!A || !H) return '';
    const ma = statMap(A), mh = statMap(H);
    const bars = COMPARE[league].map(([label, keys]) => {
      const k = keys.find((x) => ma.has(x) && mh.has(x));
      if (!k) return '';
      return UI.compareBar(label, num(ma.get(k)), num(mh.get(k)), ma.get(k), mh.get(k), away.abbr, home.abbr);
    }).join('');
    if (!bars) return '';
    return `<section class="card"><h2>Team stats</h2>
      <div class="cmp-legend"><span class="cmp-key a">${esc(away.abbr)}</span><span class="cmp-key b">${esc(home.abbr)}</span></div>${bars}</section>`;
  }

  // ---------- box score ----------
  function boxScoreHTML(league, away, home, comp) {
    const periods = Math.max(away.linescores.length, home.linescores.length);
    if (!periods) return '';
    const lbl = (i) => {
      if (league === 'nhl') return i < 3 ? String(i + 1) : i === 3 ? 'OT' : 'SO';
      if (league === 'nfl') return i < 4 ? String(i + 1) : i === 4 ? 'OT' : `OT${i - 3}`;
      return String(i + 1);
    };
    const mlb = league === 'mlb';
    const cells = (s) => Array.from({ length: periods }, (_, i) => `<td class="num">${esc(s.linescores[i] ? s.linescores[i].displayValue ?? s.linescores[i].value : '')}</td>`).join('');
    const extra = (c) => (mlb ? `<td class="num">${esc(c.hits ?? '')}</td><td class="num">${esc(c.errors ?? '')}</td>` : '');
    const ca = comp.competitors.find((c) => c.homeAway === 'away'), ch = comp.competitors.find((c) => c.homeAway === 'home');
    return `<section class="card"><h2>Box score</h2><div class="table-wrap"><table class="boxscore">
      <caption class="sr-only">Scoring by ${league === 'nhl' ? 'period' : league === 'mlb' ? 'inning' : 'quarter'}</caption>
      <thead><tr><th scope="col">Team</th>${Array.from({ length: periods }, (_, i) => `<th scope="col" class="num">${lbl(i)}</th>`).join('')}<th scope="col" class="num">${mlb ? 'R' : 'T'}</th>${mlb ? '<th scope="col" class="num">H</th><th scope="col" class="num">E</th>' : ''}</tr></thead>
      <tbody>
        <tr><th scope="row">${UI.logo(away.logo, away.name, 'logo xs')} ${esc(away.abbr)}</th>${cells(away)}<td class="num total" data-flash="box-a">${esc(away.score)}</td>${extra(ca)}</tr>
        <tr><th scope="row">${UI.logo(home.logo, home.name, 'logo xs')} ${esc(home.abbr)}</th>${cells(home)}<td class="num total" data-flash="box-h">${esc(home.score)}</td>${extra(ch)}</tr>
      </tbody></table></div></section>`;
  }

  // ---------- player tables ----------
  function playersHTML(sum, league, eventId) {
    const groups = (sum.boxscore && sum.boxscore.players) || [];
    if (!groups.length) return '';
    return groups.map((tp) => {
      const tables = (tp.statistics || []).filter((g) => g.athletes && g.athletes.length).map((g) => {
        const gname = title(g.name || g.type || '');
        const cols = [{ label: 'Player' }].concat(g.labels.map((l, i) => ({ label: l, title: (g.descriptions || [])[i] || l, num: true })));
        const rows = g.athletes.map((a) => [
          { html: `<a href="${playerHref(league, a.athlete.id, eventId)}">${esc(a.athlete.shortName || a.athlete.displayName)}</a>${a.athlete.position ? ` <small>${esc(a.athlete.position.abbreviation)}</small>` : ''}`, v: a.athlete.displayName },
          ...a.stats.map((s) => ({ html: esc(s), v: s })),
        ]);
        return `<h4>${esc(gname)}</h4>${UI.table(cols, rows, { key: `p-${tp.team.id}-${gname}` })}`;
      }).join('');
      return `<section class="card"><h3>${UI.logo(tp.team.logo, tp.team.displayName, 'logo sm')} ${esc(tp.team.displayName)} players</h3>${tables || UI.empty('No player stats yet.')}</section>`;
    }).join('');
  }

  // ---------- scoring timeline ----------
  function timelineHTML(sum, league, away, home) {
    const logoById = { [away.id]: away, [home.id]: home };
    let plays;
    if (league === 'nfl') {
      plays = (sum.scoringPlays || []).map((p) => ({
        when: `Q${p.period.number}${p.period.number > 4 ? ' (OT)' : ''} ${p.clock ? p.clock.displayValue : ''}`,
        team: logoById[String(p.team && p.team.id)] || {}, text: `${p.type ? p.type.abbreviation + ': ' : ''}${p.text}`,
        score: `${p.awayScore}-${p.homeScore}`,
      }));
    } else {
      const keyPlay = (p) => p.scoringPlay || (league === 'nhl' && /Penalty/i.test(p.type && p.type.text || ''));
      plays = (sum.plays || []).filter(keyPlay).map((p) => ({
        when: league === 'mlb'
          ? `${p.period.type ? p.period.type + ' ' : ''}${ord(p.period.number)}`
          : `${p.period.displayValue || ord(p.period.number)} ${p.clock ? p.clock.displayValue : ''}`,
        team: logoById[String(p.team && p.team.id)] || {}, text: p.text,
        score: p.scoringPlay ? `${p.awayScore}-${p.homeScore}` : '', penalty: !p.scoringPlay,
      }));
    }
    if (!plays.length) return `<section class="card"><h2>Scoring</h2>${UI.empty('No scoring yet.')}</section>`;
    return `<section class="card"><h2>${league === 'nhl' ? 'Goals and penalties' : 'Scoring plays'}</h2><ol class="timeline">${plays.map((p) => `
      <li class="${p.penalty ? 'pen' : ''}"><span class="t-when">${esc(p.when)}</span>${UI.logo(p.team.logo, p.team.name || '', 'logo xs')}
        <span class="t-text">${p.penalty ? '<b>Penalty</b> ' : ''}${esc(p.text)}</span>${p.score ? `<span class="t-score" title="${esc(away.abbr)}-${esc(home.abbr)}">${esc(p.score)}</span>` : ''}</li>`).join('')}
    </ol></section>`;
  }

  function sideOf(c, league) {
    return {
      id: String(c.team.id), abbr: c.team.abbreviation, name: c.team.displayName,
      logo: (c.team.logos && c.team.logos[0] && c.team.logos[0].href) || c.team.logo || '',
      score: c.score ?? '', linescores: c.linescores || [], winner: c.winner,
      record: (c.record && c.record[0] && (c.record[0].displayValue || c.record[0].summary)) || '',
    };
  }

  async function gameHTML(league, id) {
    const T = TEAM_BY_LEAGUE[league];
    const firstTry = await API.summary(league, id, 30);
    const comp = firstTry.header.competitions[0];
    const isLive = comp.status.type.state === 'in';
    const sum = isLive ? await API.summary(league, id, 8) : firstTry;
    const c2 = sum.header.competitions[0];
    const away = sideOf(c2.competitors.find((c) => c.homeAway === 'away'), league);
    const home = sideOf(c2.competitors.find((c) => c.homeAway === 'home'), league);
    const st = c2.status.type;
    App.viewLive = isLive; // a live game page refreshes every 10 seconds, whoever is playing
    if (away.id === T.id || home.id === T.id) App.noteLive(T.key, isLive ? { id } : null, true);

    // live extras come from the scoreboard (possession, outs, power play)
    let live = '';
    if (isLive) {
      const ev = await API.liveGame(T).catch(() => null);
      const pp = league === 'nhl' ? await API.nhlSituation() : null;
      if (ev && ev.id === String(id)) live = Views.situationHTML(ev, T, { pp });
    }
    const date = new Date(c2.date);
    const flag = /POSTPONED|DELAY|SUSPENDED|CANCEL/.test(st.name) ? `<span class="flag-pill">${esc(st.description)}</span>` : '';
    const venue = sum.gameInfo && sum.gameInfo.venue;
    const tv = (c2.broadcasts || []).map((b) => b.media && b.media.shortName).filter(Boolean);
    const share = st.completed ? `<button type="button" class="btn" data-action="share" data-text="${esc(`Final${/OT|SO/.test(st.detail) ? ' (' + st.shortDetail.replace('Final/', '') + ')' : ''}: ${away.name} ${away.score}, ${home.name} ${home.score} (${UI.shortDate(date)})`)}">Copy final score</button>` : '';
    const mineHome = home.id === T.id;

    return `${backButton('#' + T.key)}
      <section class="card game-head${isLive ? ' is-live' : ''}">
        <p class="g-status">${isLive ? UI.live() : ''} <span data-flash="g-status">${esc(st.detail)}</span> ${flag}</p>
        <div class="g-teams">
          <div class="g-team${away.id === T.id ? ' mine' : ''}">${UI.logo(away.logo, away.name, 'logo xl')}<b>${esc(away.name)}</b><span class="muted">${esc(away.record)}</span></div>
          <div class="g-score"><span data-flash="g-away">${esc(away.score)}</span><span class="dash" aria-hidden="true">–</span><span data-flash="g-home">${esc(home.score)}</span></div>
          <div class="g-team${mineHome ? ' mine' : ''}">${UI.logo(home.logo, home.name, 'logo xl')}<b>${esc(home.name)}</b><span class="muted">${esc(home.record)}</span></div>
        </div>
        ${live}
        <p class="muted g-meta">${esc(UI.when(date))}${venue ? ` · ${esc(venue.fullName)}` : ''}${sum.gameInfo && sum.gameInfo.attendance ? ` · ${sum.gameInfo.attendance.toLocaleString()} fans` : ''}${tv.length ? ` · ${esc(tv.join(', '))}` : ''}</p>
        ${share}
      </section>
      ${st.state === 'pre' ? `<section class="card"><p>The game hasn't started yet. It begins in ${UI.countdown(date)}.</p></section>` : ''}
      ${boxScoreHTML(league, away, home, c2)}
      <div class="grid2">${compareHTML(sum, league, away, home)}${timelineHTML(sum, league, away, home)}</div>
      <h2>Player stats</h2>
      <div class="grid2">${playersHTML(sum, league, id)}</div>`;
  }

  Views.game = {
    async render(root, { league, id }) {
      root.innerHTML = `${backButton('#' + TEAM_BY_LEAGUE[league].key)}${UI.skeleton('cards', 1)}${UI.skeleton('rows', 8)}`;
      root.innerHTML = await gameHTML(league, id);
    },
    async refresh(root, params) { root.innerHTML = await gameHTML(params.league, params.id); },
  };

  // ---------- player ----------
  function keyStat(league, labels, group) {
    const has = (l) => labels.includes(l);
    if (league === 'nhl') return has('PTS') ? 'PTS' : has('SV%') ? 'SV%' : has('SV') ? 'SV' : labels[0];
    if (league === 'mlb') return has('AVG') ? 'AVG' : has('ERA') ? 'ERA' : has('H') ? 'H' : labels[0];
    return has('YDS') ? 'YDS' : has('TOT') ? 'TOT' : labels[0];
  }

  async function playerHTML(league, id, eventId) {
    const T = TEAM_BY_LEAGUE[league];
    const { bio, overview } = await API.athlete(league, id);
    const known = API.rosterIndex[league] && API.rosterIndex[league].get(String(id));
    const injury = (bio.injuries && bio.injuries[0]) || (known && known.injury);
    const facts = [
      ['Number', bio.displayJersey || (bio.jersey ? '#' + bio.jersey : '')],
      ['Position', bio.position && bio.position.displayName],
      ['Team', bio.team && bio.team.displayName],
      ['Age', bio.age],
      ['Height / weight', [bio.displayHeight, bio.displayWeight].filter(Boolean).join(', ')],
      ['Born', [bio.displayDOB, bio.displayBirthPlace].filter(Boolean).join(', ')],
      ['Experience', bio.displayExperience],
      ['Draft', bio.displayDraft],
    ].filter(([, v]) => v);

    // this game
    let gameStats = '';
    if (eventId) {
      try {
        const sum = await API.summary(league, eventId, 60);
        const rows = [];
        (sum.boxscore.players || []).forEach((tp) => tp.statistics.forEach((g) => {
          const a = (g.athletes || []).find((x) => String(x.athlete.id) === String(id));
          if (a) rows.push({ name: title(g.name || g.type || ''), labels: g.labels, stats: a.stats });
        }));
        const comp = sum.header.competitions[0];
        const vs = comp.competitors.map((c) => c.team.abbreviation).join(' vs ');
        gameStats = `<section class="card"><h2>This game <small class="muted">${esc(vs)}, ${esc(UI.shortDate(new Date(comp.date)))}</small></h2>
          ${rows.length ? rows.map((r) => `<h4>${esc(r.name)}</h4>${UI.table(r.labels.map((l) => ({ label: l, num: true })), [r.stats])}`).join('') : UI.empty('Did not record stats in this game.')}</section>`;
      } catch (e) { gameStats = ''; }
    }

    // season and career
    const st = overview && overview.statistics;
    const splits = st ? st.splits.filter((s) => !/Projected/.test(s.displayName)) : [];
    const seasonHTML = splits.length
      ? UI.table([{ label: '' }].concat(st.labels.map((l, i) => ({ label: l, title: (st.displayNames || [])[i] || l, num: true }))),
        splits.map((s) => [{ html: `<b>${esc(s.displayName)}</b>`, v: s.displayName }, ...s.stats.map((v) => ({ html: esc(v), v }))]))
      : UI.empty('No season stats yet.');

    // last five games
    let trend = UI.empty('No recent games.');
    let recent = '';
    const gl = overview && overview.gameLog;
    if (gl && gl.statistics && gl.statistics[0]) {
      const grp = gl.statistics[0];
      const k = keyStat(league, grp.labels, grp);
      const ki = grp.labels.indexOf(k);
      const last5 = (grp.events || []).slice(0, 5).reverse();
      const pts = last5.map((g) => {
        const ev = gl.events[g.eventId] || {};
        const opp = ev.opponent ? ev.opponent.abbreviation : '';
        const d = ev.gameDate ? new Date(ev.gameDate) : null;
        return { v: parseFloat(g.stats[ki]) || 0, label: `${ev.atVs || ''} ${opp} ${d ? UI.shortDate(d) : ''}`.trim(), short: opp || (d ? UI.shortDate(d) : '') };
      });
      const fmt = (v) => (k === 'AVG' || k === 'SV%' ? v.toFixed(3).replace(/^0/, '') : String(Math.round(v * 100) / 100));
      trend = UI.lineChart(pts, { label: `${(grp.displayNames || [])[ki] || k} (${grp.displayName || k})`, fmt });
      recent = UI.table([{ label: 'Game' }, { label: 'Result' }].concat(grp.labels.map((l) => ({ label: l, num: true }))),
        (grp.events || []).slice(0, 5).map((g) => {
          const ev = gl.events[g.eventId] || {};
          return [{ html: `<a href="#game/${league}/${g.eventId}">${esc(`${ev.atVs || ''} ${ev.opponent ? ev.opponent.abbreviation : ''}`)}</a> <small>${ev.gameDate ? esc(UI.shortDate(new Date(ev.gameDate))) : ''}</small>`, v: ev.gameDate || '' },
            `${ev.gameResult || ''} ${ev.score || ''}`, ...g.stats.map((v) => ({ html: esc(v), v }))];
        }));
    }

    const back = eventId ? `#game/${league}/${eventId}` : `#${T.key}`;
    return `${backButton(back)}
      <section class="card player-head">
        ${bio.headshot ? `<img class="headshot" src="${esc(bio.headshot.href)}" alt="Photo of ${esc(bio.displayName)}">` : '<div class="headshot none" aria-hidden="true"></div>'}
        <div><h1>${esc(bio.displayName || 'Player')} ${UI.star(league, id, bio.displayName || '')}</h1>
          ${injury ? `<p><span class="inj-pill">${esc(injury.status || 'Injured')}</span>${injury.detail ? ` <span class="muted">${esc(injury.detail)}</span>` : ''}</p>` : '<p class="muted">No injury listed</p>'}
          <dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></div>
      </section>
      ${gameStats}
      <section class="card"><h2>Season and career</h2>${seasonHTML}</section>
      <div class="grid2"><section class="card"><h2>Last 5 games</h2>${trend}</section><section class="card"><h2>Recent games</h2>${recent || UI.empty('No recent games.')}</section></div>`;
  }

  Views.player = {
    async render(root, { league, id, eventId }) {
      root.innerHTML = `${UI.skeleton('rows', 6)}`;
      root.innerHTML = await playerHTML(league, id, eventId);
    },
    async refresh(root, p) { root.innerHTML = await playerHTML(p.league, p.id, p.eventId); },
  };
})();
