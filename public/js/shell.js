/* CreoMaker desktop shell: window chrome, workspace switching, status bar.
   Pure presentation: it only reads state that creo.js already renders into the DOM. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const root = document.documentElement;
  const desktop = window.creoDesktop;
  const platform = desktop?.platform || (/mac/i.test(navigator.platform || navigator.userAgent) ? 'darwin' : 'win32');

  root.classList.add(desktop?.isDesktop ? 'is-desktop' : 'is-browser', 'platform-' + platform);

  document.addEventListener('DOMContentLoaded', () => {
    const app = $('app');
    if (!app) return;

    /* ---------- Workspace views (rail) ---------- */
    const views = ['edit', 'library', 'results'];
    let libraryPrepared = false;
    function showView(view) {
      if (!views.includes(view)) return;
      app.dataset.view = view;
      for (const btn of document.querySelectorAll('[data-app-view]')) {
        const active = btn.dataset.appView === view;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
      }
      if (view === 'library') {
        const lib = $('cm-library');
        if (lib) {
          lib.open = true;
          if (!libraryPrepared) {
            libraryPrepared = true;
            for (const d of lib.querySelectorAll('.cm-layers-grid > details')) d.open = true;
          }
        }
      }
      if (view === 'results') $('rail-jobs-badge')?.classList.remove('is-done');
    }
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-app-view], [data-goto-view]');
      if (btn) showView(btn.dataset.appView || btn.dataset.gotoView);
    });
    $('rail-output')?.addEventListener('click', () => {
      if (window.openOutputDir) window.openOutputDir();
      else $('cm-open-root-btn')?.click();
    });
    $('sb-job')?.addEventListener('click', () => showView('results'));

    // Legacy "go to library" hooks scroll to the library; route them to the view instead.
    const lib = $('cm-library');
    if (lib) {
      const scroll = lib.scrollIntoView.bind(lib);
      lib.scrollIntoView = (...args) => { showView('library'); scroll(...args); };
    }

    /* ---------- Keyboard shortcuts ---------- */
    document.addEventListener('keydown', e => {
      const mod = platform === 'darwin' ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      const idx = ['1', '2', '3'].indexOf(e.key);
      if (idx >= 0) { e.preventDefault(); showView(views[idx]); }
    });

    /* ---------- Title bar ---------- */
    const menuBtn = $('app-menu-btn');
    if (desktop?.showMenu && platform !== 'darwin' && menuBtn) {
      menuBtn.hidden = false;
      menuBtn.addEventListener('click', () => {
        const r = menuBtn.getBoundingClientRect();
        desktop.showMenu({ x: r.left, y: r.bottom + 2 });
      });
    }
    $('titlebar')?.addEventListener('dblclick', e => {
      if (e.target.closest('button, input, select, a')) return;
      if (platform === 'darwin') desktop?.toggleMaximize?.();
    });

    /* ---------- Status bar: running job + queue badge ---------- */
    const badge = $('rail-jobs-badge');
    const sbJob = $('sb-job'), sbLabel = $('sb-job-label'), sbMeter = $('sb-job-meter');
    const progress = $('cm-active-progress'), progressLabel = $('cm-active-label'), progressWrap = $('cm-launch-progress');
    let lastActive = 0;
    function syncJobs() {
      const jobs = $('cm-jobs');
      const active = jobs ? jobs.querySelectorAll('.cm-state.is-running, .cm-state.is-queued').length : 0;
      if (badge) {
        if (active) {
          badge.hidden = false;
          badge.textContent = String(active);
          badge.classList.remove('is-done');
        } else if (lastActive && app.dataset.view !== 'results') {
          badge.hidden = false;
          badge.textContent = '';
          badge.classList.add('is-done');
        } else if (!badge.classList.contains('is-done')) {
          badge.hidden = true;
        }
      }
      lastActive = active;
      const running = progressWrap && !progressWrap.hidden;
      if (sbJob) sbJob.hidden = !running;
      if (running) {
        const pct = Math.max(0, Math.min(100, Number(progress?.value) || 0));
        if (sbMeter) sbMeter.style.width = pct + '%';
        if (sbLabel) sbLabel.textContent = (progressLabel?.textContent || '').trim() || 'Обработка · ' + Math.round(pct) + '%';
      }
    }
    const observer = new MutationObserver(() => requestAnimationFrame(syncJobs));
    for (const el of [$('cm-jobs'), progressWrap, progressLabel, progress].filter(Boolean)) {
      observer.observe(el, { childList: true, subtree: true, attributes: true, characterData: true });
    }
    setInterval(syncJobs, 1000);
    syncJobs();
  });
})();
