/*
 * App shell: routing, tabs (remembered, swipeable), the refresh loop,
 * "last updated", stale-data warning, notifications, global search,
 * theme toggle and all the delegated click/keyboard handlers.
 *
 * Refresh intervals live here:
 */
const REFRESH_LIVE_MS = 10 * 1000;        // while any Pittsburgh game is live
const REFRESH_IDLE_MS = 5 * 60 * 1000;    // otherwise
const PLAYOFFS_MIN_MS = 60 * 1000;        // the playoffs page redraws at most once a minute

const App = (window.App = {
  live: {},   // team key -> true while that team is playing
  viewLive: false, // the game page on screen is live (any teams)
  games: {},  // team key -> latest scoreboard game (for notifications)
  get liveAny() { return Object.values(this.live).some(Boolean); },
  get fast() { return this.liveAny || this.viewLive; },
  // Views report what they found so the refresh rate can follow live games.
  noteLive(key, ev, fromGameView = false) {
    if (fromGameView && !ev) return;
    this.live[key] = !!ev;
  },
});

(() => {
  const TABS = ['home', 'penguins', 'pirates', 'steelers', 'calendar', 'playoffs'];
  const root = document.getElementById('view');
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem('scs:' + k); return v == null ? d : v; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem('scs:' + k, v); } catch (e) { /* ignore */ } },
  };

  // ---------- routing ----------
  let route = null;
  let navCount = 0;           // in-app navigations, so Back can use history
  let lastPlayoffsDraw = 0;
  const sortMemory = {};      // table key -> [column, direction], kept across refreshes

  function parse() {
    const [a, b, c, d] = location.hash.replace(/^#/, '').split('/');
    if (a === 'game' && TEAM_BY_LEAGUE[b] && c) return { view: 'game', params: { league: b, id: c }, tab: TEAM_BY_LEAGUE[b].key };
    if (a === 'player' && TEAM_BY_LEAGUE[b] && c) return { view: 'player', params: { league: b, id: c, eventId: d }, tab: TEAM_BY_LEAGUE[b].key };
    if (TEAMS[a]) return { view: 'team', params: { team: a }, tab: a, top: true };
    if (a === 'home' || a === 'playoffs' || a === 'calendar') return { view: a, params: {}, tab: a, top: true };
    return null;
  }

  function setActiveTab(tab) {
    document.querySelectorAll('.tabs [data-tab]').forEach((t) => {
      const on = t.dataset.tab === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
  }

  async function navigate(first = false) {
    const r = parse();
    if (!r) { location.replace('#home'); return; }
    route = r;
    setActiveTab(r.tab);
    if (r.top) store.set('tab', r.tab);
    document.title = `${r.view === 'home' ? 'Steel City Sports' : (TEAMS[r.tab] ? TEAMS[r.tab].name : r.tab[0].toUpperCase() + r.tab.slice(1)) + ' · Steel City Sports'}`;
    if (!first) { navCount++; window.scrollTo(0, 0); root.focus({ preventScroll: true }); }
    API.health.stale = false;
    App.viewLive = false;
    try {
      await Views[r.view].render(root, r.params);
      if (r.view === 'playoffs') lastPlayoffsDraw = Date.now();
      restoreSorts();
      stamp();
    } catch (err) {
      console.error(err);
      root.innerHTML = `<div class="card error"><h2>Couldn't load this page</h2><p>${UI.esc(err.message || err)}</p>
        <p>${API.mode === 'direct' ? 'The page is talking to the sports APIs directly and some of them block that. Start the local server with <code>python3 server.py</code> and open <a href="http://localhost:8000">http://localhost:8000</a>.' : 'The sports APIs may be down. It will try again automatically.'}</p>
        <button type="button" class="btn" data-action="retry">Try again</button></div>`;
    }
    schedule();
  }
  window.addEventListener('hashchange', () => navigate());

  // ---------- refresh loop ----------
  let timer = 0;
  let lastTick = Date.now();
  let ticking = false;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => tick(), App.fast ? REFRESH_LIVE_MS : REFRESH_IDLE_MS);
  }

  async function tick(manual = false) {
    if (ticking) return;
    ticking = true;
    lastTick = Date.now();
    clearTimeout(timer);
    API.health.stale = false;
    const btn = document.getElementById('refresh');
    btn.classList.add('spinning');
    try {
      await checkGames();
      const view = route && Views[route.view];
      const skipPlayoffs = route && route.view === 'playoffs' && !manual && Date.now() - lastPlayoffsDraw < PLAYOFFS_MIN_MS;
      if (view && view.refresh && !skipPlayoffs) {
        UI.snapshot(root);
        await view.refresh(root, route.params);
        if (route.view === 'playoffs') lastPlayoffsDraw = Date.now();
        restoreSorts();
        UI.flashChanges(root);
      }
      stamp();
    } catch (err) {
      console.error(err);
      API.health.stale = true;
      stamp();
    } finally {
      btn.classList.remove('spinning');
      ticking = false;
      schedule();
    }
  }

  // Phones pause timers while the app is in the background, so catch up the
  // moment it's back on screen, and again when the connection returns.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastTick > (App.fast ? 5000 : 30000)) tick();
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) tick(); });
  window.addEventListener('online', () => tick(true));
  window.addEventListener('offline', () => stamp());

  function stamp() {
    const el = document.getElementById('updated');
    el.innerHTML = `<span class="lu-label">Last updated: </span>${UI.clock(new Date())}${App.fast ? ' · live' : ''}`;
    const notice = document.getElementById('notice');
    if (!navigator.onLine) {
      notice.hidden = false;
      notice.innerHTML = "You're offline. Showing the last scores loaded; they'll update when you reconnect.";
    } else if (API.health.stale) {
      notice.hidden = false;
      notice.innerHTML = 'Data may be out of date. Showing the last good copy while the sports APIs catch up.';
    } else if (API.mode === 'direct' && location.protocol === 'file:') {
      notice.hidden = false;
      notice.innerHTML = 'Opened as a file, so some data may not load. For everything, run <code>python3 server.py</code> and open <a href="http://localhost:8000">localhost:8000</a>.';
    } else {
      notice.hidden = true;
    }
  }

  // ---------- live detection + notifications ----------
  let primed = false;
  async function checkGames() {
    const results = await Promise.all(Object.values(TEAMS).map((T) => API.liveGame(T, 8).catch(() => null).then((ev) => [T, ev])));
    results.forEach(([T, ev]) => {
      const prev = App.games[T.key];
      App.games[T.key] = ev;
      App.live[T.key] = !!(ev && ev.state === 'in');
      if (primed && ev && notifyOn()) {
        const same = prev && prev.id === ev.id;
        if (ev.state === 'in' && (!same || prev.state === 'pre')) notify(T, `${T.name} game has started`, `${ev.home ? 'vs' : 'at'} ${ev.them.name}`, ev);
        if (same && ev.state === 'in' && +ev.us.score > +prev.us.score) notify(T, `${T.name} score!`, `${ev.us.abbr} ${ev.us.score}, ${ev.them.abbr} ${ev.them.score} · ${ev.detail}`, ev);
        if (same && prev.state === 'in' && ev.state === 'post') notify(T, `Final: ${T.name} ${ev.result === 'W' ? 'win' : ev.result === 'L' ? 'lose' : 'tie'}`, `${ev.us.abbr} ${ev.us.score}, ${ev.them.abbr} ${ev.them.score}`, ev);
      }
    });
    primed = true;
  }

  const notifyOn = () => store.get('notify', '0') === '1' && 'Notification' in window && Notification.permission === 'granted';
  function notify(T, title, body, ev) {
    try {
      const n = new Notification(title, { body, icon: `https://a.espncdn.com/i/teamlogos/${T.league}/500/pit.png`, tag: `${T.key}-${ev.id}` });
      n.onclick = () => { window.focus(); location.hash = `#game/${T.league}/${ev.id}`; };
    } catch (e) { /* some browsers only allow notifications from a service worker */ }
  }
  function paintNotifyButton() {
    const b = document.getElementById('notify');
    const on = notifyOn();
    b.setAttribute('aria-pressed', on);
    b.setAttribute('aria-label', on ? 'Score alerts on' : 'Score alerts off');
    b.classList.toggle('on', on);
  }
  document.getElementById('notify').addEventListener('click', async () => {
    if (!('Notification' in window)) return UI.toast('This browser does not support notifications.');
    if (notifyOn()) { store.set('notify', '0'); paintNotifyButton(); return UI.toast('Score alerts off'); }
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (perm !== 'granted') return UI.toast('Notifications are blocked for this site in your browser settings.');
    store.set('notify', '1');
    paintNotifyButton();
    UI.toast('You will be alerted when Pittsburgh scores, or a game starts or ends.');
  });

  // ---------- theme ----------
  function paintTheme() {
    const t = document.documentElement.dataset.theme || 'dark';
    const b = document.getElementById('theme');
    b.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    b.innerHTML = t === 'dark'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  }
  document.getElementById('theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
    paintTheme();
  });

  document.getElementById('refresh').addEventListener('click', () => tick(true));

  // ---------- sortable tables ----------
  function applySort(table, col, dir) {
    const btn = table.querySelector(`[data-sort="${col}"]`);
    if (!btn) return;
    table.querySelectorAll('th').forEach((x) => x.removeAttribute('aria-sort'));
    btn.closest('th').setAttribute('aria-sort', dir === 'descending' ? 'ascending' : 'descending'); // sortTable flips it
    UI.sortTable(btn);
  }
  function restoreSorts() {
    root.querySelectorAll('table[data-key]').forEach((t) => {
      const m = sortMemory[t.dataset.key];
      if (m) applySort(t, m[0], m[1]);
    });
  }

  // ---------- delegated events ----------
  function go(href) { if (href) location.hash = href.replace(/^#/, ''); }

  document.addEventListener('click', async (e) => {
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      UI.sortTable(sortBtn);
      const table = sortBtn.closest('table');
      if (table.dataset.key) sortMemory[table.dataset.key] = [+sortBtn.dataset.sort, sortBtn.closest('th').getAttribute('aria-sort')];
      return;
    }
    const jump = e.target.closest('[data-jump]');
    if (jump) {
      e.preventDefault();
      const target = document.getElementById(jump.dataset.jump);
      if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }
      return;
    }
    const act = e.target.closest('[data-action]');
    if (act && act.tagName !== 'INPUT' && act.tagName !== 'SELECT') {
      const a = act.dataset.action;
      if (a === 'fav') {
        const pinned = UI.favorites.toggle({ league: act.dataset.league, id: act.dataset.id, name: act.dataset.name });
        document.querySelectorAll(`[data-action="fav"][data-league="${act.dataset.league}"][data-id="${act.dataset.id}"]`).forEach((s) => {
          s.classList.toggle('on', pinned); s.textContent = pinned ? '★' : '☆'; s.setAttribute('aria-pressed', pinned);
          s.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} ${act.dataset.name} ${pinned ? 'from' : 'to'} Home`);
        });
        UI.toast(pinned ? `${act.dataset.name} pinned to Home` : `${act.dataset.name} unpinned`);
      } else if (a === 'sched-filter') {
        Views.team.setScheduleFilter(act.dataset.team, act.dataset.v);
        const part = root.querySelector('[data-part="schedule"]');
        if (part && root._team) part.innerHTML = Views.team.scheduleHTML(root._team);
      } else if (a === 'share') {
        const text = act.dataset.text;
        try { await navigator.clipboard.writeText(text); } catch (err) {
          const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        }
        UI.toast('Copied: ' + text);
      } else if (a === 'back') {
        if (navCount > 0 && history.length > 1) history.back(); else go(act.dataset.fallback);
      } else if (a === 'po-sub') {
        Views.playoffs.setSub(act.dataset.v);
        await Views.playoffs.render(root);
        lastPlayoffsDraw = Date.now();
      } else if (a === 'cal-move') {
        Views.calendar.move(root, +act.dataset.v);
      } else if (a === 'cal-team') {
        Views.calendar.toggle(root, act.dataset.v);
      } else if (a === 'retry') {
        navigate();
      }
      return;
    }
    // whole cards act as links, but let real links and buttons inside them work normally
    const card = e.target.closest('[data-href]');
    if (card && !e.target.closest('a, button, input, select')) go(card.dataset.href);
  });

  document.addEventListener('keydown', (e) => {
    const card = e.target.closest && e.target.closest('[data-href][tabindex]');
    if (card && (e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); go(card.dataset.href); }
    // arrow keys change months on the calendar
    if (route && route.view === 'calendar' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest('input, select, textarea')) {
      Views.calendar.move(root, e.key === 'ArrowLeft' ? -1 : 1);
    }
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.action === 'roster-q') Views.team.setRoster(root, el.dataset.team, { q: el.value });
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.action === 'roster-pos') Views.team.setRoster(root, el.dataset.team, { pos: el.value });
  });

  // ---------- swipe between tabs (phones) ----------
  let touch = null;
  root.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || e.target.closest('.bracket-scroll, .table-wrap, input, .week')) { touch = null; return; }
    touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  root.addEventListener('touchend', (e) => {
    if (!touch || !route || !route.top) return;
    const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y;
    const quick = Date.now() - touch.t < 600;
    touch = null;
    if (!quick || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    if (route.view === 'calendar') return Views.calendar.move(root, dx < 0 ? 1 : -1); // swipe = change month
    const i = TABS.indexOf(route.tab) + (dx < 0 ? 1 : -1);
    if (i >= 0 && i < TABS.length) go('#' + TABS[i]);
  }, { passive: true });

  // ---------- global player search ----------
  const input = document.getElementById('search');
  const list = document.getElementById('search-results');
  let people = null, active = -1, matches = [];
  async function loadPeople() {
    if (people) return people;
    const all = await Promise.all(Object.values(TEAMS).map((T) => API.roster(T).then((groups) => groups.flatMap((g) => g.athletes.map((a) => Object.assign({ T }, a)))).catch(() => [])));
    const seen = new Set();
    people = all.flat().filter((p) => { const k = p.T.league + p.id; if (seen.has(k)) return false; seen.add(k); return true; });
    return people;
  }
  function closeSearch() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; }
  function paintSearch() {
    list.innerHTML = matches.length ? matches.map((p, i) => `<li role="option" id="sr-${i}" class="${i === active ? 'active' : ''}" aria-selected="${i === active}" data-i="${i}">
      <b>${UI.esc(p.name)}</b> <span class="muted">${UI.esc(p.T.name)} · ${UI.esc(p.pos)}${p.jersey ? ' · #' + UI.esc(p.jersey) : ''}</span></li>`).join('')
      : '<li class="none" role="option" aria-disabled="true">No players found</li>';
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `sr-${active}`); else input.removeAttribute('aria-activedescendant');
  }
  function openMatch(i) {
    const p = matches[i];
    if (!p) return;
    closeSearch();
    input.value = '';
    go(`#player/${p.T.league}/${p.id}`);
  }
  input.addEventListener('focus', () => { loadPeople(); });
  input.addEventListener('input', async () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) return closeSearch();
    const all = await loadPeople();
    matches = all.filter((p) => p.name.toLowerCase().includes(q)).sort((a, b) => a.name.toLowerCase().indexOf(q) - b.name.toLowerCase().indexOf(q)).slice(0, 10);
    active = matches.length ? 0 : -1;
    paintSearch();
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(matches.length - 1, active + 1); paintSearch(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paintSearch(); }
    else if (e.key === 'Enter') { e.preventDefault(); openMatch(active); }
    else if (e.key === 'Escape') { closeSearch(); }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('[data-i]');
    if (li) { e.preventDefault(); openMatch(+li.dataset.i); }
  });
  input.addEventListener('blur', () => setTimeout(closeSearch, 150));

  // ---------- pull to refresh (when launched from the home screen) ----------
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) {
    const ptr = document.getElementById('ptr');
    let pull = null;
    const reset = () => { ptr.style.transform = ''; ptr.style.opacity = ''; ptr.classList.remove('ready'); };
    document.addEventListener('touchstart', (e) => {
      pull = window.scrollY <= 0 && e.touches.length === 1 && !e.target.closest('.bracket-scroll, .table-wrap, .search-results') ? { y: e.touches[0].clientY, dy: 0 } : null;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!pull) return;
      pull.dy = e.touches[0].clientY - pull.y;
      if (pull.dy <= 0) return reset();
      ptr.style.transform = `translateY(${Math.min(pull.dy * 0.5, 90) - 40}px) rotate(${pull.dy * 2}deg)`;
      ptr.style.opacity = Math.min(1, pull.dy / 100);
      ptr.classList.toggle('ready', pull.dy > 140);
    }, { passive: true });
    document.addEventListener('touchend', async () => {
      if (!pull) return;
      const go = pull.dy > 140;
      pull = null;
      if (!go) return reset();
      ptr.classList.add('busy');
      ptr.style.transform = 'translateY(30px)';
      await tick(true);
      ptr.classList.remove('busy');
      reset();
    });
  }

  // ---------- install as an app ----------
  const installBox = document.getElementById('install');
  let installEvent = null;
  const dismissed = () => store.get('install-dismissed', '0') === '1';
  function offerInstall(html) {
    if (standalone || dismissed()) return;
    installBox.innerHTML = `<p>${html}</p><div class="btns">${installEvent ? '<button type="button" class="btn" id="do-install">Install</button>' : ''}<button type="button" class="btn" id="no-install">Not now</button></div>`;
    installBox.hidden = false;
    const yes = document.getElementById('do-install');
    if (yes) yes.onclick = async () => { installEvent.prompt(); await installEvent.userChoice; installBox.hidden = true; };
    document.getElementById('no-install').onclick = () => { store.set('install-dismissed', '1'); installBox.hidden = true; };
  }
  window.addEventListener('beforeinstallprompt', (e) => { // Android / desktop Chrome
    e.preventDefault();
    installEvent = e;
    offerInstall('Install Steel City Sports as an app for full-screen live scores.');
  });
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone) { // iPhone Safari has no prompt: explain it
    offerInstall('Add this to your Home Screen: tap the Share button <span aria-hidden="true">⬆︎</span>, then <b>Add to Home Screen</b>.');
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // ---------- start ----------
  (async function start() {
    paintTheme();
    paintNotifyButton();
    await API.init();
    if (!parse()) history.replaceState(null, '', '#' + store.get('tab', 'home'));
    await navigate(true);
    checkGames().then(schedule).catch(() => {});
  })();
})();
