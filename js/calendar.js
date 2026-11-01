/*
 * Calendar tab: one month at a time, every Penguins, Pirates and Steelers
 * game, from three months back to three months ahead. Past games show the
 * result, upcoming ones the start time. On phones the grid becomes a list.
 */
(() => {
  const { esc } = UI;
  const RANGE = 3; // months either side of this one
  const STATE_KEY = 'scs:cal-teams';
  let offset = 0;  // months from the current month
  let shown = (() => {
    try { const v = JSON.parse(localStorage.getItem(STATE_KEY)); if (Array.isArray(v) && v.length) return new Set(v); } catch (e) { /* default */ }
    return new Set(Object.keys(TEAMS));
  })();

  const monthStart = (off) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + off, 1); };
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

  function chip(T, e) {
    const res = e.state === 'in' ? `<b class="cal-live">LIVE ${esc(e.us.score)}-${esc(e.them.score)}</b>`
      : e.completed ? `${e.result} ${esc(e.us.score)}-${esc(e.them.score)}`
      : e.flag ? esc(e.flag)
      : e.timeKnown ? esc(UI.time(e.date)) : 'TBA';
    const pre = e.seasonType === 1 ? ' <i>pre</i>' : e.seasonType === 3 ? ' <i>playoff</i>' : '';
    return `<a class="cal-game team-${T.key}${e.completed ? ' done' : ''}" href="#game/${T.league}/${e.id}"
      aria-label="${esc(T.name)} ${e.home ? 'versus' : 'at'} ${esc(e.them.name)}, ${esc(res.replace(/<[^>]+>/g, ''))}">
      <span class="tag">${T.short}</span> ${e.home ? 'vs' : '@'} ${esc(e.them.abbr)}${pre}<small>${res}</small></a>`;
  }

  function draw(root) {
    const all = root._cal || [];
    const start = monthStart(offset);
    const end = monthStart(offset + 1);
    const byDay = new Map();
    let count = 0;
    const tally = {};
    all.forEach(({ T, games }) => {
      if (!shown.has(T.key)) return;
      games.forEach((e) => {
        if (e.date < start || e.date >= end) return;
        const k = dayKey(e.date);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push({ T, e });
        count++;
        const t = (tally[T.key] = tally[T.key] || { n: 0, w: 0, l: 0 });
        t.n++;
        if (e.result === 'W') t.w++;
        if (e.result === 'L') t.l++;
      });
    });
    byDay.forEach((list) => list.sort((a, b) => a.e.date - b.e.date));

    const title = start.toLocaleDateString([], { month: 'long', year: 'numeric' });
    const lead = start.getDay();
    const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    const today = new Date();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<li class="cal-cell blank" aria-hidden="true"></li>');
    for (let d = 1; d <= days; d++) {
      const date = new Date(start.getFullYear(), start.getMonth(), d);
      const games = byDay.get(dayKey(date)) || [];
      cells.push(`<li class="cal-cell${UI.sameDay(date, today) ? ' today' : ''}${games.length ? ' has' : ''}">
        <span class="cal-num" aria-label="${esc(date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))}">${d}</span>
        ${games.map(({ T, e }) => chip(T, e)).join('')}</li>`);
    }
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w) => `<li aria-hidden="true">${w}</li>`).join('');

    // phone list: only days with games
    const agenda = [...byDay.entries()].sort((a, b) => a[1][0].e.date - b[1][0].e.date).map(([, list]) => {
      const date = list[0].e.date;
      return `<li class="ag-day${UI.sameDay(date, today) ? ' today' : ''}"><h3>${esc(date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}</h3>
        <div>${list.map(({ T, e }) => chip(T, e)).join('')}</div></li>`;
    }).join('');

    const summary = Object.values(TEAMS).filter((T) => tally[T.key]).map((T) => {
      const t = tally[T.key];
      return `${T.name} ${t.n}${t.w + t.l ? ` (${t.w}-${t.l})` : ''}`;
    }).join(' · ');

    const toggles = Object.values(TEAMS).map((T) => `<button type="button" class="cal-toggle team-${T.key}${shown.has(T.key) ? ' on' : ''}"
      data-action="cal-team" data-v="${T.key}" aria-pressed="${shown.has(T.key)}"><span class="tag">${T.short}</span> ${T.name}</button>`).join('');

    root.innerHTML = `<div class="cal-head">
        <button type="button" class="icon-btn cal-nav" data-action="cal-move" data-v="-1" ${offset <= -RANGE ? 'disabled' : ''} aria-label="Previous month">‹</button>
        <h1 class="page-title" aria-live="polite">${esc(title)}</h1>
        <button type="button" class="icon-btn cal-nav" data-action="cal-move" data-v="1" ${offset >= RANGE ? 'disabled' : ''} aria-label="Next month">›</button>
        ${offset ? '<button type="button" class="btn" data-action="cal-move" data-v="0">This month</button>' : ''}
      </div>
      <p class="muted cal-sum">${count ? `${count} game${count === 1 ? '' : 's'}: ${esc(summary)}` : 'No games this month.'}</p>
      <div class="cal-toggles" role="group" aria-label="Show teams">${toggles}</div>
      <div class="card cal-card">
        <ol class="cal-week" aria-hidden="true">${weekdays}</ol>
        <ol class="cal-grid">${cells.join('')}</ol>
        <ol class="cal-agenda">${agenda || '<li class="muted">No games this month.</li>'}</ol>
      </div>
      <p class="hint">Up to ${RANGE} months back and ahead. Swipe sideways or use the arrows to change months.</p>`;
  }

  Views.calendar = {
    async render(root) {
      root.innerHTML = `<h1 class="page-title">Calendar</h1>${UI.skeleton('rows', 8)}`;
      root._cal = await Promise.all(Object.values(TEAMS).map((T) =>
        API.allGames(T).then((games) => ({ T, games })).catch(() => ({ T, games: [] }))));
      draw(root);
    },
    refresh(root) { return this.render(root); },
    move(root, v) {
      offset = v === 0 ? 0 : Math.max(-RANGE, Math.min(RANGE, offset + v));
      draw(root);
    },
    toggle(root, key) {
      if (shown.has(key)) { if (shown.size > 1) shown.delete(key); } else shown.add(key);
      try { localStorage.setItem(STATE_KEY, JSON.stringify([...shown])); } catch (e) { /* ignore */ }
      draw(root);
    },
  };
})();
