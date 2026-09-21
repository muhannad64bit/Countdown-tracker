# Operation Logbook — 8-Month Countdown Tracker

A gamified, terminal/black-ops themed tracker for an 8-month (35-week)
personal challenge. Each week has 6 duty (work) days and 1 safehouse
(rest) day — Friday. Progress is saved to a local `data.json` file, so
it survives restarts without a database.

## Folder structure

```
gamified-countdown-tracker/
├── package.json
├── server.js            Express server + API + data persistence
├── data.json             Created automatically on first run
├── public/
│   ├── index.html         Page shell
│   ├── style.css          Terminal/phosphor theme
│   └── app.js             Rendering + interactivity
└── README.md
```

## Requirements

- Node.js 16 or newer (check with `node -v`)
- npm (comes with Node)

## Install

From inside the `gamified-countdown-tracker` folder:

```bash
npm install
```

This installs the single dependency (Express).

## Run

```bash
npm start
```

You should see:

```
OPERATION TRACKER online → http://localhost:3000
```

Open **http://localhost:3000** in your browser.

To use a different port:

```bash
PORT=4000 npm start
```

## How it works

- **Clicking a duty-day cell** toggles it between pending and cleared,
  with an amber flash animation and an updated progress bar.
- **Friday cells** are marked as a safehouse (⌂) and are not clickable —
  they're a visual checkpoint, not a task.
- The 35 weeks are split into 4 progressive phases (Ignition, Momentum,
  Pressure, Endgame), each with its own mini progress bar.
- The top progress bar and percentage are calculated from completed
  duty days ÷ total duty days (210 total: 35 weeks × 6 duty days).
- **Reset all progress** (bottom of the header) clears every duty day
  back to pending after a confirmation prompt — the week/phase
  structure itself is never regenerated or lost.

## Data persistence

Progress lives in `data.json` next to `server.js`, written atomically
(via a temp file + rename) so a crash mid-save can't corrupt it. Delete
`data.json` and restart the server if you ever want a completely fresh
board.

## API reference

| Method | Route          | Description                                   |
|--------|----------------|------------------------------------------------|
| GET    | `/api/state`   | Returns the full board plus computed progress  |
| POST   | `/api/toggle`  | Body: `{ "weekNumber": 1, "dayIndex": 0 }` — toggles a duty day |
| POST   | `/api/reset`   | Resets every duty day to pending                |

All routes return JSON and respond with a 4xx/5xx status and an
`{ "error": "..." }` body on invalid input or failure.
