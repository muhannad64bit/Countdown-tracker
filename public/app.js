/**
 * OPERATION LOGBOOK — frontend (optimized)
 * ----------------------------------------------------------------
 * Renders the 35-week board from server state and handles toggling
 * work days. No frameworks; DOM built from <template> elements.
 *
 * Features:
 *   - Diffed rendering (no full DOM rebuild on toggle)
 *   - Current week auto-highlight
 *   - Milestone feedback in header
 *   - Toast notifications for errors
 *   - Accessible day states and current-week navigation
 * ----------------------------------------------------------------
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    phases:        $('phases'),
    statPercent:   $('statPercent'),
    statDaysDone:  $('statDaysDone'),
    statDaysLeft:  $('statDaysLeft'),
    statWeek:      $('statWeek'),
    progressFill:  $('progressFill'),
    progressBar:   $('progressBar'),
    clock:         $('clock'),
    milestone:     $('milestone'),
    subhead:       $('subhead'),
    toastContainer: $('toastContainer'),
    phaseTemplate: $('phaseTemplate'),
    weekTemplate:  $('weekTemplate'),
  };

  let state = null;
  let isBusy = false;
  let boardRendered = false;

  // ---------------------------------------------------------------
  // Milestone messages
  // ---------------------------------------------------------------

  const MILESTONES = [
    { min: 100, text: 'Look how far you’ve come', css: 'milestone-done' },
    { min: 75,  text: 'The finish line is getting closer', css: 'milestone-three-quarter' },
    { min: 50,  text: 'Halfway there. Keep growing.', css: 'milestone-half' },
    { min: 25,  text: 'Finding your rhythm', css: 'milestone-quarter' },
    { min: 0,   text: 'Your journey is unfolding', css: '' },
  ];

  function getMilestone(percent) {
    return MILESTONES.find(m => percent >= m.min) || MILESTONES[MILESTONES.length - 1];
  }

  // ---------------------------------------------------------------
  // Toast notifications
  // ---------------------------------------------------------------

  function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' is-error' : ''}`;
    toast.textContent = message;
    els.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ---------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------

  async function apiCall(url, options) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (_) {
      throw new Error('Connection lost. Check your network.');
    }
    if (res.status === 401) {
      window.location.assign('/login');
      throw new Error('Please sign in again to continue.');
    }
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
    return body;
  }

  async function loadState() {
    $('retryLoad').hidden = true;
    $('boardMessageText').textContent = 'Getting your journey ready…';
    els.phases.setAttribute('aria-busy', 'true');
    try {
      state = await apiCall('/api/state');
      render();
      $('boardMessage').hidden = true;
      $('jumpToWeek').disabled = false;
    } catch (err) {
      $('boardMessageText').textContent = `We couldn’t load your journey. ${err.message}`;
      $('retryLoad').hidden = false;
    } finally {
      els.phases.setAttribute('aria-busy', 'false');
    }
  }

  async function toggleDay(weekNumber, dayIndex, cellEl) {
    if (isBusy) return;
    isBusy = true;
    els.phases.setAttribute('aria-busy', 'true');
    document.querySelectorAll('.day:not(.is-rest)').forEach(day => day.setAttribute('aria-disabled', 'true'));
    cellEl.classList.add('is-saving');

    const wasDone = cellEl.classList.contains('is-done');
    cellEl.classList.toggle('is-done', !wasDone);
    updateGlyph(cellEl, !wasDone);

    try {
      state = await apiCall('/api/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekNumber, dayIndex }),
      });

      // Update stats + progress without rebuilding the whole board
      renderStats();
      updateWeekCard(weekNumber);
      updatePhaseBar(state.weeks.find(w => w.weekNumber === weekNumber)?.phaseId);
      updateCurrentWeek();

    } catch (err) {
      cellEl.classList.toggle('is-done', wasDone);
      updateGlyph(cellEl, wasDone);
      showToast(err.message, true);
    } finally {
      isBusy = false;
      els.phases.setAttribute('aria-busy', 'false');
      document.querySelectorAll('.day:not(.is-rest)').forEach(day => day.removeAttribute('aria-disabled'));
      cellEl.classList.remove('is-saving');
    }
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  function render() {
    if (!state) return;
    renderStats();
    if (!boardRendered) {
      renderBoard();
      boardRendered = true;
    }
    updateCurrentWeek();
  }

  function renderStats() {
    const { progress, meta } = state;
    const remaining = progress.totalWork - progress.completedWork;

    els.statPercent.textContent = `${progress.percent.toFixed(1)}%`;
    els.statDaysDone.textContent = `${progress.completedWork} / ${progress.totalWork}`;
    els.statDaysLeft.textContent = remaining;

    const weeksCleared = state.weeks.filter((w) =>
      w.days.filter((d) => d.type === 'work').every((d) => d.status === 'completed')
    ).length;
    els.statWeek.textContent = `${weeksCleared} / ${meta.totalWeeks}`;

    els.progressFill.style.width = `${progress.percent}%`;
    els.progressBar.setAttribute('aria-valuenow', String(Math.round(progress.percent)));

    // Update milestone tag
    const milestone = getMilestone(progress.percent);
    els.milestone.textContent = milestone.text;
    els.milestone.className = `tag${milestone.css ? ' ' + milestone.css : ''}`;

    // Update subhead with current week context
    const currentWeek = findCurrentWeek();
    $('jumpToWeek').firstChild.textContent = currentWeek ? 'Continue your journey ' : 'Look back at your journey ';
    if (progress.percent >= 100) {
      els.subhead.textContent = `All ${meta.totalWeeks} weeks complete. Take a moment to celebrate.`;
    } else if (currentWeek) {
      els.subhead.textContent = `Week ${currentWeek} of ${meta.totalWeeks} · ${remaining} days to go`;
    }
  }

  function renderBoard() {
    const frag = document.createDocumentFragment();
    for (const phase of state.phases) {
      const phaseWeeks = state.weeks.filter((w) => w.phaseId === phase.id);
      frag.appendChild(buildPhaseSection(phase, phaseWeeks));
    }
    els.phases.appendChild(frag);
  }

  function buildPhaseSection(phase, weeks) {
    const node = els.phaseTemplate.content.cloneNode(true);
    const section = node.querySelector('.phase');
    section.dataset.phaseId = phase.id;
    section.querySelector('.phase-name').textContent = phase.name.replace(/^PHASE (\d+) — (.*)$/, (_, number, name) => `${number} · ${name.charAt(0)}${name.slice(1).toLowerCase()}`);
    section.querySelector('.phase-range').textContent =
      `Weeks ${String(phase.weekStart).padStart(2, '0')}–${String(phase.weekEnd).padStart(2, '0')}`;

    let phaseWorkTotal = 0;
    let phaseWorkDone = 0;

    const grid = section.querySelector('.weeks-grid');
    for (const week of weeks) {
      const workDays = week.days.filter((d) => d.type === 'work');
      phaseWorkTotal += workDays.length;
      phaseWorkDone += workDays.filter((d) => d.status === 'completed').length;
      grid.appendChild(buildWeekCard(week));
    }

    const phasePercent = phaseWorkTotal === 0 ? 0 : (phaseWorkDone / phaseWorkTotal) * 100;
    section.querySelector('.phase-bar-fill').style.width = `${phasePercent}%`;

    return node;
  }

  function buildWeekCard(week) {
    const node = els.weekTemplate.content.cloneNode(true);
    const card = node.querySelector('.week-card');
    card.dataset.week = week.weekNumber;
    const workDays = week.days.filter((d) => d.type === 'work');
    const doneCount = workDays.filter((d) => d.status === 'completed').length;
    const isComplete = doneCount === workDays.length;

    card.classList.toggle('is-complete', isComplete);
    card.querySelector('.week-num').textContent = `Week ${String(week.weekNumber).padStart(2, '0')}`;
    card.querySelector('.week-status').textContent = isComplete
      ? 'Complete'
      : `${doneCount}/${workDays.length}`;

    const row = card.querySelector('.days-row');
    for (const day of week.days) {
      row.appendChild(buildDayCell(week.weekNumber, day));
    }

    return node;
  }

  function buildDayCell(weekNumber, day) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'day';
    cell.dataset.week = String(weekNumber);
    cell.dataset.day = String(day.index);

    const glyph = document.createElement('span');
    glyph.className = 'glyph';

    if (day.type === 'rest') {
      cell.classList.add('is-rest');
      glyph.textContent = '☾';
      cell.disabled = true;
      cell.setAttribute('aria-label', `${day.label}: rest day`);
      cell.addEventListener('click', (e) => e.preventDefault());
    } else {
      const isDone = day.status === 'completed';
      cell.classList.toggle('is-done', isDone);
      cell.setAttribute('aria-pressed', String(isDone));
      glyph.textContent = isDone ? '✓' : '·';
      cell.setAttribute(
        'aria-label',
        `${day.label}, week ${weekNumber}: ${isDone ? 'completed' : 'pending'}`
      );
      cell.addEventListener('click', () => toggleDay(weekNumber, day.index, cell));
    }

    const label = document.createElement('span');
    label.textContent = day.label;

    cell.appendChild(glyph);
    cell.appendChild(label);
    return cell;
  }

  // ---------------------------------------------------------------
  // Diffed updates (avoid full DOM rebuild on toggle)
  // ---------------------------------------------------------------

  function updateGlyph(cell, isDone) {
    cell.setAttribute('aria-pressed', String(isDone));
    cell.setAttribute('aria-label', `${cell.lastElementChild.textContent}, week ${cell.dataset.week}: ${isDone ? 'completed' : 'pending'}`);
    const glyph = cell.querySelector('.glyph');
    if (glyph) glyph.textContent = isDone ? '✓' : '·';
  }

  function updateWeekCard(weekNumber) {
    const week = state.weeks.find(w => w.weekNumber === weekNumber);
    if (!week) return;
    const card = document.querySelector(`.week-card[data-week="${weekNumber}"]`);
    if (!card) return;

    const workDays = week.days.filter(d => d.type === 'work');
    const doneCount = workDays.filter(d => d.status === 'completed').length;
    const isComplete = doneCount === workDays.length;

    card.classList.toggle('is-complete', isComplete);
    card.querySelector('.week-status').textContent = isComplete
      ? 'Complete'
      : `${doneCount}/${workDays.length}`;
  }

  function updatePhaseBar(phaseId) {
    if (!phaseId) return;
    const section = document.querySelector(`.phase[data-phase-id="${phaseId}"]`);
    if (!section) return;

    const phaseWeeks = state.weeks.filter(w => w.phaseId === phaseId);
    let total = 0, done = 0;
    for (const week of phaseWeeks) {
      for (const day of week.days) {
        if (day.type === 'work') {
          total++;
          if (day.status === 'completed') done++;
        }
      }
    }
    const pct = total === 0 ? 0 : (done / total) * 100;
    section.querySelector('.phase-bar-fill').style.width = `${pct}%`;
  }

  // ---------------------------------------------------------------
  // Current week detection
  // ---------------------------------------------------------------

  function findCurrentWeek() {
    if (!state) return null;
    // Current week = first week with incomplete work days
    const week = state.weeks.find(w =>
      w.days.some(d => d.type === 'work' && d.status !== 'completed')
    );
    return week ? week.weekNumber : null;
  }

  function updateCurrentWeek() {
    // Remove previous highlight
    const prev = document.querySelector('.week-card.is-current');
    if (prev) {
      prev.classList.remove('is-current');
      prev.removeAttribute('aria-current');
    }

    const currentWeekNum = findCurrentWeek();
    if (currentWeekNum === null) return;

    const card = document.querySelector(`.week-card[data-week="${currentWeekNum}"]`);
    if (card) {
      card.classList.add('is-current');
      card.setAttribute('aria-current', 'step');
    }
  }

  // ---------------------------------------------------------------
  // Misc UI
  // ---------------------------------------------------------------

  function tickClock() {
    els.clock.textContent = new Intl.DateTimeFormat('en', {
      weekday: 'short', month: 'short', day: 'numeric'
    }).format(new Date());
  }

  $('jumpToWeek').addEventListener('click', () => {
    const target = document.querySelector('.week-card.is-current') || document.querySelector('.phase:last-child .week-card:last-child');
    if (!target) return;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
  });
  $('retryLoad').addEventListener('click', loadState);
  tickClock();
  setInterval(tickClock, 60_000);
  loadState();
})();
