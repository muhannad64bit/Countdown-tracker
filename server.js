/**
 * OPERATION TRACKER — backend
 * ----------------------------------------------------------------
 * Minimal, dependency-light Express server that serves the static
 * frontend and persists progress to a local data.json file.
 * Password-protected with cookie-based sessions.
 *
 * Data model (see buildInitialData()):
 *   {
 *     meta: { totalWeeks, workDaysPerWeek, totalWorkDays, createdAt },
 *     phases: [{ id, name, weekStart, weekEnd }],
 *     weeks: [
 *       {
 *         weekNumber, phaseId,
 *         days: [{ index, label, type: 'work'|'rest', status: 'pending'|'completed' }]
 *       }
 *     ]
 *   }
 * ----------------------------------------------------------------
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const TOTAL_WEEKS = 35; // 8-month challenge
const DAY_LABELS = ['SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI']; // Fri = rest
const REST_DAY_INDEX = 6;

// ---------------------------------------------------------------
// Auth config
// ---------------------------------------------------------------

const PASSWORD = process.env.APP_PASSWORD || '297846';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_LOGIN_ATTEMPTS = 10;

// Active sessions: Map<token, expiresAt>
const sessions = new Map();

// IP rate limiting: Map<ip, { attempts, blockedAt }>
const ipAttempts = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MAX_AGE);
  return token;
}

function isValidSession(token) {
  if (!token || !sessions.has(token)) return false;
  if (Date.now() > sessions.get(token)) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  });
  return cookies;
}

function getClientIp(req) {
  // Support Cloudflare Tunnel / proxies
  return req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || 'unknown';
}

function isIpBlocked(ip) {
  const record = ipAttempts.get(ip);
  return record && record.attempts >= MAX_LOGIN_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const record = ipAttempts.get(ip) || { attempts: 0 };
  record.attempts += 1;
  ipAttempts.set(ip, record);
  return MAX_LOGIN_ATTEMPTS - record.attempts;
}

function clearAttempts(ip) {
  ipAttempts.delete(ip);
}

const PHASE_DEFS = [
  { id: 1, name: 'PHASE 01 — IGNITION', weekStart: 1, weekEnd: 9 },
  { id: 2, name: 'PHASE 02 — MOMENTUM', weekStart: 10, weekEnd: 18 },
  { id: 3, name: 'PHASE 03 — PRESSURE', weekStart: 19, weekEnd: 27 },
  { id: 4, name: 'PHASE 04 — ENDGAME', weekStart: 28, weekEnd: 35 },
];

// ---------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------

function phaseForWeek(weekNumber) {
  const phase = PHASE_DEFS.find(
    (p) => weekNumber >= p.weekStart && weekNumber <= p.weekEnd
  );
  return phase ? phase.id : PHASE_DEFS[PHASE_DEFS.length - 1].id;
}

function buildInitialData() {
  const weeks = [];
  for (let w = 1; w <= TOTAL_WEEKS; w++) {
    const days = DAY_LABELS.map((label, index) => ({
      index,
      label,
      type: index === REST_DAY_INDEX ? 'rest' : 'work',
      status: 'pending',
    }));
    weeks.push({ weekNumber: w, phaseId: phaseForWeek(w), days });
  }

  const workDaysPerWeek = DAY_LABELS.length - 1;

  return {
    meta: {
      totalWeeks: TOTAL_WEEKS,
      workDaysPerWeek,
      totalWorkDays: TOTAL_WEEKS * workDaysPerWeek,
      createdAt: new Date().toISOString(),
    },
    phases: PHASE_DEFS,
    weeks,
  };
}

async function readData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.weeks)) {
      throw new Error('Malformed data.json: missing weeks array');
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') {
      // First run — seed the file.
      const initial = buildInitialData();
      await writeData(initial);
      return initial;
    }
    // Corrupt or unreadable file — do not silently wipe user progress.
    throw new Error(`Failed to read data.json: ${err.message}`);
  }
}

async function writeData(data) {
  const tmpFile = `${DATA_FILE}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  await fs.writeFile(tmpFile, payload, 'utf-8');
  await fs.rename(tmpFile, DATA_FILE);
}

function computeProgress(data) {
  let completedWork = 0;
  let totalWork = 0;
  for (const week of data.weeks) {
    for (const day of week.days) {
      if (day.type === 'work') {
        totalWork += 1;
        if (day.status === 'completed') completedWork += 1;
      }
    }
  }
  const percent = totalWork === 0 ? 0 : (completedWork / totalWork) * 100;
  return {
    completedWork,
    totalWork,
    percent: Math.round(percent * 100) / 100,
  };
}

// ---------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------

// Trust proxy headers (Cloudflare Tunnel)
app.set('trust proxy', true);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Auth middleware — allows /login through, blocks everything else
function authGuard(req, res, next) {
  if (req.path === '/login') return next();

  const cookies = parseCookies(req.headers.cookie);
  if (isValidSession(cookies.session)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  return res.redirect('/login');
}

app.use(authGuard);

// Static files (only served after auth check)
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
}));

// ---------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------

app.get('/login', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (isValidSession(cookies.session)) {
    return res.redirect('/');
  }
  const ip = getClientIp(req);
  if (isIpBlocked(ip)) {
    return res.status(403).send(blockedPage());
  }
  res.send(loginPage());
});

app.post('/login', (req, res) => {
  const ip = getClientIp(req);

  if (isIpBlocked(ip)) {
    return res.status(403).send(blockedPage());
  }

  const { password } = req.body || {};
  if (password === PASSWORD) {
    clearAttempts(ip);
    const token = createSession();
    res.setHeader('Set-Cookie',
      `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE / 1000}; SameSite=Lax`
    );
    return res.redirect('/');
  }

  const remaining = recordFailedAttempt(ip);
  if (remaining <= 0) {
    return res.status(403).send(blockedPage());
  }
  res.send(loginPage(`Wrong code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`));
});

// ---------------------------------------------------------------
// API routes
// ---------------------------------------------------------------

// GET /api/state — full board + derived progress
app.get('/api/state', async (req, res) => {
  try {
    const data = await readData();
    res.json({ ...data, progress: computeProgress(data) });
  } catch (err) {
    console.error('[GET /api/state]', err.message);
    res.status(500).json({ error: 'Could not load operation data.' });
  }
});

// POST /api/toggle  { weekNumber, dayIndex }
app.post('/api/toggle', async (req, res) => {
  try {
    const { weekNumber, dayIndex } = req.body || {};

    if (
      typeof weekNumber !== 'number' ||
      typeof dayIndex !== 'number' ||
      !Number.isInteger(weekNumber) ||
      !Number.isInteger(dayIndex)
    ) {
      return res.status(400).json({ error: 'weekNumber and dayIndex must be integers.' });
    }

    if (weekNumber < 1 || weekNumber > TOTAL_WEEKS) {
      return res.status(400).json({ error: `weekNumber must be between 1 and ${TOTAL_WEEKS}.` });
    }

    if (dayIndex < 0 || dayIndex > 6) {
      return res.status(400).json({ error: 'dayIndex must be between 0 and 6.' });
    }

    const data = await readData();
    const week = data.weeks.find((w) => w.weekNumber === weekNumber);
    if (!week) {
      return res.status(404).json({ error: `Week ${weekNumber} not found.` });
    }

    const day = week.days[dayIndex];
    if (!day) {
      return res.status(404).json({ error: `Day ${dayIndex} not found in week ${weekNumber}.` });
    }

    if (day.type === 'rest') {
      return res.status(400).json({ error: 'Rest days cannot be toggled.' });
    }

    day.status = day.status === 'completed' ? 'pending' : 'completed';

    await writeData(data);
    res.json({ ...data, progress: computeProgress(data) });
  } catch (err) {
    console.error('[POST /api/toggle]', err.message);
    res.status(500).json({ error: 'Could not update progress.' });
  }
});

// POST /api/reset — wipes all progress back to pending (keeps structure)
app.post('/api/reset', async (req, res) => {
  try {
    const data = await readData();
    for (const week of data.weeks) {
      for (const day of week.days) {
        if (day.type === 'work') day.status = 'pending';
      }
    }
    await writeData(data);
    res.json({ ...data, progress: computeProgress(data) });
  } catch (err) {
    console.error('[POST /api/reset]', err.message);
    res.status(500).json({ error: 'Could not reset operation data.' });
  }
});

// ---------------------------------------------------------------
// Fallback + error handling
// ---------------------------------------------------------------

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown API route.' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[Unhandled error]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`OPERATION TRACKER online → http://localhost:${PORT}`);
});

// ---------------------------------------------------------------
// Login page — glass card, single password field, centered
// ---------------------------------------------------------------

function loginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome back — Day by day</title>
  <link rel="icon" href="data:,">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100svh; padding: 24px; display: grid; place-items: center; font-family: 'Inter', sans-serif; background: #f5f6f2; color: #263c32; -webkit-font-smoothing: antialiased; }
    .bg { display: none; }
    .glass { width: min(100%, 380px); padding: 40px 32px; border-radius: 36px; background: #e4edde; text-align: center; }
    .brand-mark { display: inline-grid; place-items: center; width: 48px; height: 48px; border-radius: 50%; background: #426951; color: white; font-size: 28px; }
    h1 { font-size: 28px; font-weight: 500; letter-spacing: -1px; margin: 24px 0 8px; }
    .intro { font-size: 13px; color: #68786e; margin: 0 0 28px; line-height: 1.7; }
    label { display: block; text-align: left; font-size: 12px; margin: 0 0 8px 16px; }
    .input-field { width: 100%; border: 0; border-radius: 100px; padding: 17px; text-align: center; font: inherit; letter-spacing: .3em; background: #fff; color: #263c32; }
    .submit-btn { width: 100%; border: 0; border-radius: 100px; padding: 17px; margin-top: 12px; background: #426951; color: white; font: inherit; font-size: 13px; cursor: pointer; transition: background .2s; }
    .submit-btn:hover { background: #335540; }
    :focus-visible { outline: 3px solid #8aa780; outline-offset: 4px; }
    .error-msg { color: #844d42; font-size: 12px; line-height: 1.5; }
    .error-msg:empty { display: none; }
  </style>
</head>
<body>
  <div class="bg" aria-hidden="true">
    <div class="bg-mesh"></div>
  </div>
  <form class="glass" method="POST" action="/login">
    <span class="brand-mark" aria-hidden="true">↗</span>
    <h1>A little closer, every day.</h1>
    <p class="intro">Your journey is right where you left it.<br>Enter your code to continue.</p>
    <label for="password">Access code</label>
    <input
      class="input-field${error ? ' has-error' : ''}"
      type="password"
      name="password"
      id="password"
      inputmode="numeric"
      pattern="[0-9]*"
      autocomplete="current-password"
      placeholder="• • • • • •"
      autofocus
      required
    >
    <button class="submit-btn" type="submit">Continue your journey</button>
    <p class="error-msg" role="alert">${error}</p>
  </form>
</body>
</html>`;
}

function blockedPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Blocked</title>
  <link rel="icon" href="data:,">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      font-family: 'Inter', -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
      background: #f5f6f2;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .blocked {
      text-align: center;
      padding: 40px;
    }
    .blocked-icon {
      font-size: 48px;
      margin-bottom: 20px;
    }
    .blocked h1 {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 8px;
      color: #844d42;
    }
    .blocked p {
      font-size: 14px;
      color: #68786e;
      max-width: 300px;
    }
  </style>
</head>
<body>
  <div class="blocked">
    <div class="blocked-icon">⛔</div>
    <h1>Access Denied</h1>
    <p>Too many failed attempts. Your access has been blocked.</p>
  </div>
</body>
</html>`;
}
