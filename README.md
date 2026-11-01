# Steel City Sports

A single-page web app that tracks the Pittsburgh Penguins (NHL), Pirates (MLB)
and Steelers (NFL) with live data: scores, box scores, rosters, standings,
injuries and playoff brackets. Plain HTML, CSS and JavaScript with no build step.

## Running it

You need Python 3, which macOS already has.

```bash
cd NFL_Mobile_App
python3 server.py
```

Then open **http://localhost:8000**. To use a different port, run `PORT=9000 python3 server.py`.

`server.py` serves the app's files and proxies the sports APIs through `/api`,
because some of the APIs refuse requests made directly from a browser. It uses
only Python's standard library, so there is nothing to install.

### On your phone

When the server starts it prints a second address, such as
`http://192.168.86.219:8000`. Open that on a phone that's on the same Wi-Fi.
To install it like an app:

- **iPhone:** in Safari, tap **Share**, then **Add to Home Screen**.
- **Android:** in Chrome's menu, tap **Install app** or **Add to Home screen**.

It then opens full screen with a bottom tab bar, and you can pull down to
refresh.

To keep the server private to this computer, start it with
`HOST=127.0.0.1 python3 server.py`.

### Without the server (for example on a web host)

The app also works as plain static files, for example on GitHub Pages. With
no server it calls the APIs directly, and two things change:

- **Team records, standings positions and next-season dates:** ESPN's team
  endpoint blocks direct browser requests, so these are built from standings
  and schedules instead.
- **NHL extras:** the NHL API blocks browsers, so power-play status during
  Penguins games is hidden, and the NHL bracket falls back to seeding from the
  standings.

Over HTTPS (any normal web host), the app also works offline. A service worker
(`sw.js`) caches the app's own files, and the last scores loaded are kept.

If you open `index.html` straight from the file system, some browsers block
the data entirely. Use the server, or a web host, instead.

## What's where

| File | What it does |
|---|---|
| `index.html` | Page shell: header, search, tabs |
| `styles.css` | Black and gold theme (light and dark), layout, components |
| `js/api.js` | Fetching, caching, the stale-data fallback, and converting API data into simple objects |
| `js/ui.js` | Shared helpers: dates and times in your time zone, countdowns, badges, sortable tables, the chart, favorites |
| `js/views-team.js` | Home dashboard and the three team pages |
| `js/views-game.js` | Game detail and player detail pages |
| `js/playoffs.js` | Playoffs tab: projected or real brackets, plus standings |
| `js/odds.js` | Playoff odds, worked out by simulating the rest of the season |
| `js/calendar.js` | Calendar tab: a month view, 3 months either way |
| `js/main.js` | Routing, tabs and swiping, the refresh loop, notifications, search, theme |
| `server.py` | Static file server and caching API proxy |
| `manifest.webmanifest`, `icons/` | App name and icons for installing on a phone |
| `sw.js` | Service worker: opens the app offline once it's installed (needs HTTPS or localhost) |

## Data sources

All of these are public and need no API key.

- **ESPN site API** (`site.api.espn.com`): team info, schedules, rosters,
  scoreboards (for live games), game summaries (box scores, plays, leaders,
  injuries, head-to-head), standings.
- **ESPN web and core APIs** (`site.web.api.espn.com`, `sports.core.api.espn.com`):
  player bios, season and career stats, game logs, team leaders.
- **NHL API** (`api-web.nhle.com`): power-play status during Penguins games,
  which ESPN doesn't provide, and playoff brackets.
- **MLB Stats API** (`statsapi.mlb.com`): postseason series for the MLB bracket.

These endpoints aren't officially documented and can change without notice.
If a section stops loading, the endpoint behind it has probably moved.

## Refresh intervals

These are set at the top of `js/main.js`:

```js
const REFRESH_LIVE_MS = 10 * 1000;      // while any Pittsburgh game is live
const REFRESH_IDLE_MS = 5 * 60 * 1000;  // otherwise
const PLAYOFFS_MIN_MS = 60 * 1000;      // the playoffs page redraws at most once a minute
```

A game page that's live refreshes every 10 seconds whoever is playing. Phones
pause pages in the background, so the app also refreshes the moment it comes
back on screen, and again when the connection returns.

There are two caches, so several open tabs don't flood the APIs:

- **In the browser:** each request in `js/api.js` takes a time-to-live in seconds, for example `API.get(url, 60)`.
- **In the proxy:** the `cache_seconds()` function in `server.py` sets it. Live scoreboards are kept for 8 seconds, standings for 5 minutes, and everything else for 1 minute.

## How some features work

- **Live detection:** every refresh checks the three leagues' scoreboards. If a
  Pittsburgh game is in progress, the refresh rate drops to 10 seconds, a "Live
  now" banner appears on Home, and the Current Game card shows the live
  situation: possession and down (NFL), outs, runners and count (MLB), or power
  play (NHL).
- **Changed values flash:** before each refresh the app remembers every score
  and stat on screen, then briefly highlights anything that changed.
- **Off-season:** when a team has no games left on its schedule, its page shows
  a season summary and the date the next season starts. Its playoff tab shows
  the final bracket and the champion.
- **Projected brackets** follow each league's format.
  - **NHL:** the top three in each division plus two wild cards per conference.
  - **MLB:** three division winners plus three wild cards per league, with
    seeds 1 and 2 getting a bye.
  - **NFL:** seven seeds per conference, with seed 1 getting a bye.

  The NFL and MLB use ESPN's own seeding when it's available. ESPN's NFL
  standings don't include "last 10" records, so the app works them out from
  each week's results.
- **Playoff odds** (`js/odds.js`) come from playing out the rest of the
  season 4,000 times. Each team plays its remaining games at the strength of
  its record so far. Early in the season that record is pulled toward .500,
  because a hot start says less than it seems. Each league's playoff format is
  applied every time, and a team's odds are the share of runs in which it made
  it. The simulation uses fixed random numbers, so the odds only change when a
  real result does. It's an estimate: it doesn't know who plays whom in the
  remaining games, and it uses simple tiebreakers.
- **Schedule** (on each team page): results are listed newest first, and
  upcoming games are listed separately with the next game first.
- **Calendar tab** (`js/calendar.js`): one month at a time with every
  Pittsburgh game, from 3 months back to 3 months ahead. It includes preseason
  games and next season's opening games. Change months with the arrows, the
  arrow keys, or a sideways swipe on a phone. On phones the grid becomes a
  list.
- **Status badges** come from these rules:
  - **Clinched:** the league marks the team as clinched.
  - **In:** the team currently holds a playoff spot.
  - **Bubble:** the team is close to the last spot: within 4 points (NHL),
    1 game (NFL) or 3 games (MLB).
  - **Out:** anything else.

  The badges are text, not only colours.
- **If the APIs fail:** the last good copy is shown with a "Data may be out of
  date" notice. Small responses are also saved in `localStorage`, so a reload
  while offline still shows something.
- **Notifications:** turn them on with the bell icon. They fire when a
  Pittsburgh game starts, when Pittsburgh scores, and when a game ends. They
  only work while the page is open in a tab.
- **Favorites:** star any player on a roster or player page to pin them to
  the top of Home with their current season stats.

## Accessibility

- Every control is a real button or link, and you can reach it with the keyboard.
- Focus is clearly visible.
- Logos have alt text, and a skip link jumps to the content.
- Win/loss and playoff status are written out, not only shown in colour.
- The stat comparison bars use a striped pattern for one side.
- Sortable tables announce their sort order.
- Animations stop if your system asks for reduced motion.
