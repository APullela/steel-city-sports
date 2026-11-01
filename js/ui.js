/*
 * Shared UI helpers: escaping, date/time formatting, little components
 * (badges, logos, countdowns, skeletons, charts, comparison bars),
 * sortable tables, favorites and the "flash when it changes" effect.
 * Views build HTML strings with these and main.js wires up events.
 */
const UI = (() => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- dates and times (always the viewer's own time zone) ----------
  const tzName = (() => {
    try { return new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value; } catch (e) { return ''; }
  })();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  function dayLabel(d) {
    const now = new Date();
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (sameDay(d, now)) return 'Today';
    if (sameDay(d, tomorrow)) return 'Tomorrow';
    if (sameDay(d, yesterday)) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  }
  const shortDate = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const time = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // "Tue, Nov 3, 7:00 PM EST": the zone name is worked out for that date, so
  // a February game says EST even when it's read in October (EDT).
  const when = (d, timeKnown = true) => (timeKnown
    ? `${dayLabel(d)}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`
    : `${dayLabel(d)} (time TBA)`);
  const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  // ---------- countdowns: any [data-countdown] element ticks once a second ----------
  function countdown(date, label = '') {
    return `<span class="countdown" data-countdown="${+date}" aria-label="${esc(label || 'Countdown')}">${countdownText(+date)}</span>`;
  }
  function countdownText(ts) {
    let s = Math.floor((ts - Date.now()) / 1000);
    if (s <= 0) return 'Starting now';
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const pad = (n) => String(n).padStart(2, '0');
    return d ? `${d}d ${pad(h)}h ${pad(m)}m` : `${h}h ${pad(m)}m ${pad(s)}s`;
  }
  setInterval(() => {
    document.querySelectorAll('[data-countdown]').forEach((el) => { el.textContent = countdownText(+el.dataset.countdown); });
  }, 1000);

  // ---------- small components ----------
  const logo = (src, alt, cls = 'logo') =>
    src ? `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)} logo" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="${cls} logo-missing" aria-hidden="true"></span>`;

  // W / L / T badges carry the letter and a word for screen readers, not just a color.
  function badge(result, detail = '') {
    if (!result) return '';
    const cls = { W: 'win', L: 'loss', T: 'tie' }[result];
    const word = { W: 'Win', L: 'Loss', T: 'Tie' }[result];
    const extra = /OT|SO/.test(detail) ? ` <small>${/SO/.test(detail) ? 'SO' : 'OT'}</small>` : '';
    return `<span class="badge ${cls}" title="${word}"><span aria-hidden="true">${result}</span><span class="sr-only">${word}</span>${extra}</span>`;
  }
  const live = () => '<span class="live-pill"><i aria-hidden="true"></i>LIVE</span>';
  const flagPill = (flag) => (flag ? `<span class="flag-pill">${esc(flag)}</span>` : '');

  function skeleton(kind = 'cards', n = 3) {
    if (kind === 'cards') return `<div class="grid3">${'<div class="card skel"><div class="sk sk-title"></div><div class="sk sk-big"></div><div class="sk"></div><div class="sk sk-short"></div></div>'.repeat(n)}</div>`;
    if (kind === 'rows') return `<div class="card skel">${'<div class="sk"></div>'.repeat(n)}</div>`;
    return '<div class="sk"></div>';
  }

  const empty = (msg) => `<p class="empty">${esc(msg)}</p>`;

  // ---------- comparison bars (team stats) ----------
  function compareBar(label, a, b, aText, bText, aName, bName) {
    const total = (+a || 0) + (+b || 0);
    const pa = total ? Math.round(((+a || 0) / total) * 100) : 50;
    return `<div class="cmp" role="group" aria-label="${esc(label)}: ${esc(aName)} ${esc(aText)}, ${esc(bName)} ${esc(bText)}">
      <div class="cmp-head"><b data-flash="cmp-${esc(label)}-a">${esc(aText)}</b><span>${esc(label)}</span><b data-flash="cmp-${esc(label)}-b">${esc(bText)}</b></div>
      <div class="cmp-bar" aria-hidden="true"><span class="cmp-a" style="width:${pa}%"></span><span class="cmp-b" style="width:${100 - pa}%"></span></div>
    </div>`;
  }

  // ---------- small line chart (last 5 games) ----------
  function lineChart(points, { label = '', fmt = (v) => v } = {}) {
    if (!points.length) return empty('No recent games.');
    const W = 320, H = 130, P = 28;
    const vals = points.map((p) => p.v);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (lo === hi) { lo -= 1; hi += 1; }
    const x = (i) => P + (points.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (points.length - 1));
    const y = (v) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const dots = points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.v)}" r="4"><title>${esc(p.label)}: ${esc(fmt(p.v))}</title></circle>
      <text x="${x(i)}" y="${y(p.v) - 9}" class="chart-val">${esc(fmt(p.v))}</text>
      <text x="${x(i)}" y="${H - 6}" class="chart-lbl">${esc(p.short)}</text>`).join('');
    const summary = points.map((p) => `${p.label} ${fmt(p.v)}`).join(', ');
    return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} over the last ${points.length} games: ${esc(summary)}">
      <path d="${path}" class="chart-line"/>${dots}</svg><figcaption>${esc(label)}, oldest to newest</figcaption></figure>`;
  }

  // ---------- sortable tables ----------
  // Any <table class="sortable"> sorts when a header button is clicked (wired in main.js).
  function table(columns, rows, { caption = '', cls = '', key = '' } = {}) {
    const head = columns.map((c, i) =>
      `<th scope="col" class="${c.num ? 'num' : ''}"><button type="button" data-sort="${i}" aria-label="Sort by ${esc(c.title || c.label)}">${esc(c.label)}</button></th>`).join('');
    const body = rows.map((r) => `<tr>${r.map((cell, i) => {
      const c = typeof cell === 'object' && cell !== null ? cell : { html: esc(cell), v: cell };
      return `<td class="${columns[i] && columns[i].num ? 'num' : ''}" data-v="${esc(c.v)}">${c.html}</td>`;
    }).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table class="sortable ${cls}"${key ? ` data-key="${esc(key)}"` : ''}>${caption ? `<caption>${esc(caption)}</caption>` : ''}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  function sortTable(btn) {
    const th = btn.closest('th');
    const tableEl = btn.closest('table');
    const idx = +btn.dataset.sort;
    const dir = th.getAttribute('aria-sort') === 'descending' ? 'ascending' : 'descending';
    tableEl.querySelectorAll('th').forEach((x) => x.removeAttribute('aria-sort'));
    th.setAttribute('aria-sort', dir);
    const num = (s) => {
      if (s == null || s === '' || s === '-' || s === '--') return NaN;
      const t = String(s).replace(/[,%+]/g, '');
      if (/^\d+:\d{2}$/.test(t)) { const [m, sec] = t.split(':'); return +m * 60 + +sec; }  // 18:32 time on ice
      if (/^\d+-\d+$/.test(t)) return +t.split('-')[0];                                 // 2-4 hits-at-bats
      return parseFloat(t);
    };
    const tbody = tableEl.tBodies[0];
    const rows = [...tbody.rows];
    rows.sort((a, b) => {
      const va = a.cells[idx].dataset.v, vb = b.cells[idx].dataset.v;
      const na = num(va), nb = num(vb);
      let r;
      if (!isNaN(na) || !isNaN(nb)) r = (isNaN(na) ? -Infinity : na) - (isNaN(nb) ? -Infinity : nb);
      else r = String(va).localeCompare(String(vb));
      return dir === 'ascending' ? r : -r;
    });
    rows.forEach((r) => tbody.appendChild(r));
  }

  // ---------- favorites (starred players) ----------
  const FAV_KEY = 'scs:favorites';
  const favorites = {
    all() { try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch (e) { return []; } },
    has(league, id) { return favorites.all().some((f) => f.league === league && f.id === String(id)); },
    toggle(p) {
      const list = favorites.all();
      const i = list.findIndex((f) => f.league === p.league && f.id === String(p.id));
      if (i >= 0) list.splice(i, 1); else list.push({ league: p.league, id: String(p.id), name: p.name });
      try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
      return i < 0;
    },
  };
  const star = (league, id, name) => {
    const on = favorites.has(league, id);
    return `<button type="button" class="star${on ? ' on' : ''}" data-action="fav" data-league="${league}" data-id="${esc(id)}" data-name="${esc(name)}"
      aria-pressed="${on}" aria-label="${on ? 'Unpin' : 'Pin'} ${esc(name)} ${on ? 'from' : 'to'} Home">${on ? '★' : '☆'}</button>`;
  };

  // ---------- flash changed values ----------
  // Before a re-render we remember the text of every [data-flash] element; after it,
  // any element whose text changed gets a brief highlight.
  let lastValues = new Map();
  function snapshot(root) {
    lastValues = new Map([...root.querySelectorAll('[data-flash]')].map((el) => [el.dataset.flash, el.textContent]));
  }
  function flashChanges(root) {
    root.querySelectorAll('[data-flash]').forEach((el) => {
      const before = lastValues.get(el.dataset.flash);
      if (before != null && before !== el.textContent) {
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
      }
    });
  }

  // ---------- toast ----------
  let toastTimer = 0;
  function toast(msg) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  return {
    esc, dayLabel, shortDate, time, when, clock, tzName, sameDay, countdown, logo, badge, live, flagPill, skeleton, empty,
    compareBar, lineChart, table, sortTable, favorites, star, snapshot, flashChanges, toast,
  };
})();
