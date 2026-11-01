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
- **NHL extras:** the NHL API blocks browsers, so during Penguins games the
  app shows ESPN's yes/no power-play flag without which team or time left,
  and the NHL bracket falls back to seeding from the standings.

Over HTTPS (any normal web host), the app also works offline. A service worker
(`sw.js`) caches the app's own files and images, and the last data loaded is kept.

If you open `index.html` straight from the file system, some browsers block
the data entirely. Use the server, or a web host, instead.

## What's where

| File | What it does |
|---|---|
| `index.html` | Page shell: header, search, tabs |
| `styles.css` | Black and gold theme (Night and Newsprint), layout, components |
| `fonts/` | Big Shoulders Display and Barlow (self-hosted, cached offline) |
| `js/api.js` | Fetching, trimming and saving data, live game checks, data saver and the data meter |
| `js/ui.js` | Shared helpers: dates and times in your time zone, countdowns, badges, sortable tables, the chart, favorites |
| `js/views-team.js` | Home dashboard and the three team pages |
| `js/views-game.js` | Game detail and player detail pages |
| `js/playoffs.js` | Playoffs tab: projected or real brackets, plus standings |
| `js/odds.js` | Playoff odds, worked out by simulating the rest of the season |
| `js/calendar.js` | Calendar tab: a month view, 3 months either way |
| `js/main.js` | Routing, tabs and swiping, the refresh loop, notifications, search, settings |
| `server.py` | Static file server and caching API proxy |
| `manifest.webmanifest`, `icons/` | App name and icons for installing on a phone |
| `sw.js` | Service worker: serves the app and images from the cache, offline too (needs HTTPS or localhost) |

## Data sources

All of these are public and need no API key.

- **ESPN site API** (`site.api.espn.com`): team info, schedules, rosters,
  scoreboards (NFL playoffs and weekly results), game summaries (box scores, plays, leaders,
  injuries, head-to-head), standings.
- **ESPN web and core APIs** (`site.web.api.espn.com`, `sports.core.api.espn.com`):
  player bios, season and career stats, game logs, team leaders, and the small
  per-game live endpoints (status, score, situation).
- **NHL API** (`api-web.nhle.com`): power-play status during Penguins games,
  which ESPN doesn't provide, and playoff brackets.
- **MLB Stats API** (`statsapi.mlb.com`): postseason series for the MLB bracket.

These endpoints aren't officially documented and can change without notice.
If a section stops loading, the endpoint behind it has probably moved.

## Data use

The app is built to run on a small mobile data plan (it was designed around
100 MB a month). A typical month of checking all three teams daily and
following a few games live uses roughly 5 to 10 MB.

- **Nothing is downloaded twice.** API responses are trimmed to the fields the
  app shows (a 1.3 MB schedule becomes about 70 KB) and saved on the device
  with the time they were fetched. Reopening the app usually downloads nothing.
- **Each kind of data has its own shelf life** (`LIFE` in `js/api.js`). A
  schedule stays fresh until one of its games should be over; standings go
  stale once a Pittsburgh game has finished; a finished season or box score is
  kept for a month.
- **Live games use ESPN's tiny per-game endpoints** (status, score,
  situation): about 1.4 KB per check, against 10 to 20 KB for a league
  scoreboard. Only a game that is on, about to start or just ended is checked.
  When nothing is on, the app sleeps until 20 minutes before the next game.
- **Images are resized** by ESPN's image service (a logo is about 3 KB instead
  of 66 KB, a player photo about 10 KB instead of 200 KB) and kept by the
  service worker.
- **The app itself** (code and fonts, about 120 KB compressed) is cached by the
  service worker and only downloaded again when `VERSION` in `sw.js` changes.

**Data saver** is in Settings (the sliders icon). Automatic, the default,
keeps it on unless the browser reports Wi-Fi; iPhones never report it, so
there it stays on. Settings also shows the data used this month and lets you
clear what's saved on the device.

| | Data saver on | Off |
|---|---|---|
| Live score checks | every 30 s | every 10 s |
| Live box score page | when the score changes, or every 5 min | every 20 s |
| Standings | 12 h, or after a Pittsburgh game | 1 h |
| Nothing on | wakes 20 min before the next game (at most every 30 min) | every 5 min |
| Player photos | 1x | 1.5x |

Following a live game costs about 0.3 MB an hour with data saver on (about
1 MB an hour on its box score page). With data saver on, the app also stops
checking while it is in the background.

The intervals are set in `REFRESH` at the top of `js/main.js`, and the shelf
lives in `LIFE` at the top of `js/api.js`. The proxy keeps its own short cache
(`cache_seconds()` in `server.py`).

## Look

Black and gold, with a color per team: powder blue for the Penguins (their
original 1967 color), furnace orange for the Pirates and gold for the
Steelers. Headlines and scores are set in
[Big Shoulders Display](https://fonts.google.com/specimen/Big+Shoulders+Display),
body text in [Barlow](https://fonts.google.com/specimen/Barlow). Both are under
the SIL Open Font License and are served from `fonts/`. There are two looks,
Night and Newsprint, under Settings.

## How some features work

- **Live detection:** from the saved schedules the app knows when each game
  starts, and checks only those games' live status. If a Pittsburgh game is in progress, the refresh rate drops to 30 seconds
  (10 with data saver off), a "Live
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
