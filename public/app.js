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
 *   - Smooth auto dark mode (6 PM–6 AM)
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
    progressTicks: $('progressTicks'),
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
    { min: 100, text: '🎉 CAMPAIGN COMPLETE', css: 'milestone-done' },
    { min: 75,  text: '🔥 FINAL STRETCH · 75%+', css: 'milestone-three-quarter' },
    { min: 50,  text: '⚡ HALFWAY THERE', css: 'milestone-half' },
    { min: 25,  text: '🚀 MOMENTUM BUILDING · 25%+', css: 'milestone-quarter' },
    { min: 0,   text: 'CLASSIFIED · PERSONAL OPS', css: '' },
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
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
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
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
    return body;
  }

  async function loadState() {
    try {
      state = await apiCall('/api/state');
      render();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function toggleDay(weekNumber, dayIndex, cellEl) {
    if (isBusy) return;
    isBusy = true;

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

      if (!wasDone) {
        cellEl.classList.add('just-cleared');
        cellEl.addEventListener('animationend', () => cellEl.classList.remove('just-cleared'), { once: true });
      }
    } catch (err) {
      cellEl.classList.toggle('is-done', wasDone);
      updateGlyph(cellEl, wasDone);
      showToast(err.message, true);
    } finally {
      isBusy = false;
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

    if (!els.progressTicks.childElementCount) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < meta.totalWeeks; i++) {
        frag.appendChild(document.createElement('span'));
      }
      els.progressTicks.appendChild(frag);
    }

    // Update milestone tag
    const milestone = getMilestone(progress.percent);
    els.milestone.textContent = milestone.text;
    els.milestone.className = `tag${milestone.css ? ' ' + milestone.css : ''}`;

    // Update subhead with current week context
    const currentWeek = findCurrentWeek();
    if (progress.percent >= 100) {
      els.subhead.textContent = 'All 35 weeks cleared. Mission accomplished.';
    } else if (currentWeek) {
      els.subhead.textContent = `Week ${currentWeek} of 35 · ${remaining} duty days remaining`;
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
    section.querySelector('.phase-name').textContent = phase.name;
    section.querySelector('.phase-range').textContent =
      `WEEK ${String(phase.weekStart).padStart(2, '0')}–${String(phase.weekEnd).padStart(2, '0')}`;

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
    card.querySelector('.week-num').textContent = `WK ${String(week.weekNumber).padStart(2, '0')}`;
    card.querySelector('.week-status').textContent = isComplete
      ? 'CLEARED'
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
      glyph.textContent = '⌂';
      cell.setAttribute('aria-label', `${day.label}: rest day`);
      cell.addEventListener('click', (e) => e.preventDefault());
    } else {
      const isDone = day.status === 'completed';
      cell.classList.toggle('is-done', isDone);
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
      ? 'CLEARED'
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
    if (prev) prev.classList.remove('is-current');

    const currentWeekNum = findCurrentWeek();
    if (currentWeekNum === null) return;

    const card = document.querySelector(`.week-card[data-week="${currentWeekNum}"]`);
    if (card) card.classList.add('is-current');
  }

  // ---------------------------------------------------------------
  // Misc UI
  // ---------------------------------------------------------------

  function tickClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    els.clock.textContent = `${hh}:${mm}:${ss}`;
  }

  function updateDarkMode() {
    const hour = new Date().getHours();
    document.body.classList.toggle('dark', hour >= 18 || hour < 6);
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------

  updateDarkMode();
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(updateDarkMode, 60_000);
  loadState();
})();
