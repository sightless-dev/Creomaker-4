/* CreoMaker desktop shell: window chrome, workspace switching, status bar.
   Pure presentation: it only reads state that creo.js already renders into the DOM. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const root = document.documentElement;
  const desktop = window.creoDesktop;
  const platform = desktop?.platform || (/mac/i.test(navigator.platform || navigator.userAgent) ? 'darwin' : 'win32');

  root.classList.add(desktop?.isDesktop ? 'is-desktop' : 'is-browser', 'platform-' + platform);
  // Only the 1.2+ desktop shell draws a frameless window (it exposes `platform`). Code updated in-app inside an
  // older shell keeps the native title bar, so it must not get drag regions or traffic-light padding.
  if (desktop?.isDesktop && desktop.platform) root.classList.add('has-custom-frame');

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
    const visibleButton = (...ids) => ids.map($).find(b => b && !b.hidden && !b.disabled);
    const modalOpen = () => !!document.querySelector('dialog[open]');
    // One set of commands for keyboard, menu (desktop/main.cjs) and buttons.
    const commands = {
      showView,
      addFiles() { if (modalOpen()) return; showView('edit'); $('cm-add-inputs')?.click(); },
      run() { if (modalOpen()) return; showView('edit'); visibleButton('cm-run', 'cm-queue')?.click(); },
      playMix() { if (modalOpen()) return; showView('edit'); $('cm-play-mix')?.click(); }
    };
    window.CreoShell = Object.freeze(commands);
    // On macOS the desktop menu owns ⌘ shortcuts (Electron always registers them there); handling them here
    // as well would run every command twice. Elsewhere (Windows, browser build) the page handles them.
    const menuOwnsShortcuts = desktop?.isDesktop && platform === 'darwin';
    document.addEventListener('keydown', e => {
      const mod = platform === 'darwin' ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey || e.repeat || menuOwnsShortcuts) return;
      if (modalOpen()) return;
      const idx = ['1', '2', '3'].indexOf(e.key);
      if (idx >= 0) { e.preventDefault(); showView(views[idx]); return; }
      const key = e.key.toLowerCase();
      if (key === 'o' || key === 'щ') { e.preventDefault(); commands.addFiles(); }          // add files
      else if (e.key === 'Enter' && app.dataset.view === 'edit') { e.preventDefault(); commands.run(); } // export
    });

    /* ---------- Drag & drop anywhere ----------
       Only the media bin used to accept drops; a file dropped on the viewer made the window navigate to the
       file itself. Now every drop is handled: on the Edit view it goes to the media bin, on a Library card it
       goes to that list, anywhere else it is simply ignored. */
    const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
    const bin = $('cm-drop');
    let dragDepth = 0;
    const pickerFor = target => {
      if (target.closest('#cm-drop')) return null;                     // the bin handles its own drop
      if (app.dataset.view === 'edit') return 'inputs';
      if (app.dataset.view === 'library') {
        const card = target.closest('.cm-layers-grid > details');
        const list = card?.querySelector('[id$="-list"]')?.id || '';
        return { 'cm-tails-list': 'tails', 'cm-music-list': 'music', 'cm-tailMusic-list': 'tailMusic' }[list] || false;
      }
      return false;
    };
    document.addEventListener('dragenter', e => {
      if (!hasFiles(e)) return;
      dragDepth++;
      if (app.dataset.view === 'edit') bin?.classList.add('drag-over');
    });
    document.addEventListener('dragleave', e => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) bin?.classList.remove('drag-over');
    });
    document.addEventListener('dragover', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!e.target.closest('#cm-drop')) e.dataTransfer.dropEffect = pickerFor(e.target) ? 'copy' : 'none';
    });
    document.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      dragDepth = 0;
      bin?.classList.remove('drag-over');
      const kind = pickerFor(e.target);
      if (kind === null) return;
      e.preventDefault();
      const input = kind && $('cm-pick-' + kind);
      if (!input || !e.dataTransfer.files.length) return;
      input.files = e.dataTransfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    /* ---------- Player: Space plays/pauses right away ---------- */
    const player = $('cm-player'), playerDialog = $('cm-player-dialog');
    if (player && playerDialog) {
      new MutationObserver(() => {
        if (playerDialog.open && !player.hidden) requestAnimationFrame(() => player.focus({ preventScroll: true }));
      }).observe(playerDialog, { attributes: true, attributeFilter: ['open'] });
    }

    /* ---------- Title bar ---------- */
    const menuBtn = $('app-menu-btn');
    if (desktop?.showMenu && platform !== 'darwin' && menuBtn) {
      menuBtn.hidden = false;
      menuBtn.addEventListener('click', () => {
        const r = menuBtn.getBoundingClientRect();
        desktop.showMenu({ x: r.left, y: r.bottom + 2 });
      });
    }
    /* ---------- Native tooltips for icon-only controls ---------- */
    const tooltip = el => {
      if (!el.title && el.dataset.tooltip) el.title = el.dataset.tooltip;
      else if (!el.title && el.matches('button') && !el.textContent.trim() && el.getAttribute('aria-label')) el.title = el.getAttribute('aria-label');
    };
    document.querySelectorAll('[data-tooltip], button[aria-label]').forEach(tooltip);
    new MutationObserver(records => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches('[data-tooltip], button[aria-label]')) tooltip(n);
        n.querySelectorAll?.('[data-tooltip], button[aria-label]').forEach(tooltip);
      }
    }).observe(document.body, { childList: true, subtree: true });

    /* Shortcut hints in tooltips, with the right modifier per platform */
    const mod = platform === 'darwin' ? '⌘' : 'Ctrl+';
    const hint = (id, text) => { const el = $(id); if (el) el.title = text; };
    hint('cm-run', 'Запустить обработку · ' + mod + 'Enter');
    hint('cm-queue', 'Добавить в очередь · ' + mod + 'Enter');
    hint('cm-add-inputs', 'Добавить видео и фото · ' + mod + 'O');
    document.querySelectorAll('.rail-btn[data-app-view]').forEach((b, i) => { b.title = b.title.replace(/ · Ctrl\+\d$/, '') + ' · ' + mod + (i + 1); });

    /* ---------- Viewer empty state: guide to the bin when files are already loaded ---------- */
    const emptyTitle = $('cm-empty-title');
    const syncEmpty = () => {
      if (!bin || !emptyTitle) return;
      emptyTitle.textContent = bin.classList.contains('is-empty')
        ? 'Добавьте файл для предпросмотра'
        : 'Выберите файл в панели «Медиа»';
    };
    if (bin) new MutationObserver(syncEmpty).observe(bin, { attributes: true, attributeFilter: ['class'] });
    syncEmpty();

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
