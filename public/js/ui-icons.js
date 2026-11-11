/* Trusted local SVG vocabulary. User content never becomes SVG markup. */
(() => {
'use strict';
  const paths = {
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10Z"/>',
    vault: '<rect x="4" y="3" width="16" height="18" rx="3"/><circle cx="12" cy="11" r="3"/><path d="M12 8v6m-3-3h6M7 18h10"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
    code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
    backup: '<path d="M4 8V3m0 5h5M4 8a9 9 0 1 1-1 7m9-9v6l4 2"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    list: '<path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    edit: '<path d="m15 4 5 5M4 15 16 3a2 2 0 0 1 5 5L9 20l-6 1Z"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
    refresh: '<path d="M20 8a9 9 0 0 0-15-3L2 8m0-6v6h6m-4 8a9 9 0 0 0 15 3l3-3m0 6v-6h-6"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
    check: '<path d="m5 12 4 4L20 5"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  sidebar: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18m4-12 3 3-3 3"/>',
  back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  pin: '<path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v7"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/>',
    volume: '<path d="M3 9h4l5-4v14l-5-4H3Z"/><path d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    'volume-off': '<path d="M3 9h4l5-4v14l-5-4H3Z"/><path d="m17 9 5 6m0-6-5 6"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'
  };
  Object.assign(paths, {
    ai: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/><path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6Z"/>',
    ads: '<path d="M4 10v5h4l11 4V5L8 10ZM8 15l2 6h3l-2-5M22 9v6"/>',
    tracker: '<path d="M4 3v17h17M8 15v-4m5 4V7m5 8v-5M7 7l5-4 7 3"/>',
    cloud: '<path d="M7 18a5 5 0 1 1 .5-10A7 7 0 0 1 21 11a4 4 0 0 1-1 7Z"/>',
    finance: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18m-5 5h2M7 3h10"/>',
    social: '<path d="M21 11a9 9 0 0 1-9 9 10 10 0 0 1-4-1l-5 2 1-5a9 9 0 1 1 17-5Z"/><path d="M8 11h8m-8 4h5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>'
  });

Object.assign(paths,{
 film:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4m10 0h4M3 16h4m10 0h4m-11-7 4 3-4 3Z"/>',
 portrait:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
 scene:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m3 17 6-6 4 4 4-5 4 5"/>',
 outfit:'<path d="m8 4-5 3 2 5 3-1v10h8V11l3 1 2-5-5-3a4 4 0 0 1-8 0Z"/>',
 director:'<rect x="3" y="9" width="18" height="12" rx="2"/><path d="m3 9-1-5 18-3 1 5-18 3M7 3l3 4m4-5 3 4M10 13l5 3-5 3Z"/>',
 microphone:'<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
 chart:'<path d="M4 3v17h17M8 15v-4M13 15V7M18 15v-6"/>',
 report:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9ZM14 3v6h6M8 13h8M8 17h5"/>',
 music:'<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="19" rx="3" ry="2"/><ellipse cx="17" cy="17" rx="3" ry="2"/>',
 gpu:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8v8H8ZM2 6h3m-3 6h3m-3 6h3m14-12h3m-3 6h3m-3 6h3"/>',
 crop:'<path d="M6 3v15h15M3 6h15v15"/>',
 save:'<path d="M3 3h15l3 3v15H3ZM7 3v6h10V3M7 21v-8h10v8"/>',
 play:'<path d="m8 4 12 8-12 8Z"/>',
 close:'<path d="m6 6 12 12M6 18 18 6"/>',
 grain:'<path d="M5 6h.01M11 4h.01M18 7h.01M8 11h.01M14 10h.01M20 13h.01M4 16h.01M11 17h.01M16 19h.01M8 21h.01"/>',
 palette:'<path d="M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 1-4c-1-1 0-3 2-3h1a3 3 0 0 0 3-3c0-4-4-8-9-8Z"/><path d="M7 10h.01M10 7h.01M14 7h.01M17 10h.01"/>',
 drop:'<path d="M12 3c2.8 4 7 7.7 7 12a7 7 0 1 1-14 0c0-4.3 4.2-8 7-12Z"/>',
 contrast:'<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>',
 gauge:'<path d="M4 18a9 9 0 1 1 16 0H4Z"/><path d="m12 14 4-5M7 14h.01M12 7h.01M17 14h.01"/>',
 zoom:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5m-13-10h6m-3-3v6"/>',
 rotate:'<path d="M3 9V4m0 5h5M3 9a9 9 0 0 1 17 2"/><path d="m12 10 5 5-5 5-5-5Z"/>',
 focus:'<path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4"/><circle cx="12" cy="12" r="4"/>',
 flip:'<path d="M12 3v18M8 6l-5 12h5Zm8 0 5 12h-5Z"/>',
 curve:'<path d="M4 4v16h16M7 17c6 0 5-10 12-10"/>',
 vignette:'<rect x="3" y="3" width="18" height="18" rx="4"/><ellipse cx="12" cy="12" rx="5" ry="6"/>',
 channels:'<circle cx="9" cy="9" r="5"/><circle cx="15" cy="9" r="5"/><circle cx="12" cy="15" r="5"/>',
 texture:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m6 12 6-6m-6 12L18 6m-6 12 6-6"/>',
 waveform:'<path d="M3 12h3l2-5 4 10 3-8 2 3h4"/>',
 fade:'<path d="M4 5v14h16M6 7c3 0 5 2 7 5 2 3 4 4 7 4"/>',
 type:'<path d="M4 7V4h16v3M12 4v16m-4 0h8"/>',
 tag:'<path d="M3 4h8l10 10-7 7L3 10Zm4 3h.01"/>'
});
paths.archive='<rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v13h14V8M10 12h4"/>';
paths.clock='<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>';
paths.book='<path d="M12 5v16M3 4h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v15h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z"/>';
paths.gift='<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v9h14v-9M12 8v13"/><path d="M12 8C4 8 5 1 9 3l3 5c8 0 7-7 3-5Z"/>';
paths.expand='<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>';
paths.target='<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3"/>';
paths.clear=paths.trash;paths.restore=paths.backup;paths.sliders=paths.settings;
paths.moon='<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>';
paths.tasks='<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m7.5 12 3 3 6-6.5"/>';
paths.layers='<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>';
paths.avatar='<circle cx="10" cy="8" r="4"/><path d="M3 21a7 7 0 0 1 14 0M18 7c1.5 1 1.5 4 0 5m2-7c3 2 3 7 0 9"/>';
paths.frame='<rect x="3" y="3" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/><rect x="14" y="3" width="7" height="6" rx="1"/><path d="M10 6h4M17.5 9v6M6.5 9v8.5a1 1 0 0 0 1 1H14"/>';
paths.scissors='<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1 20 20M8.1 15.9 20 4"/>';
paths.spinner='<path d="M12 3a9 9 0 1 0 9 9"/>';
paths.flag='<path d="M5 21V4m0 0h11l-2 4 2 4H5"/>';
paths.repeat='<path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3"/>';
paths.link='<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>';
paths.drag='<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"/>';Object.freeze(paths);
function icon(name){const markup=Object.hasOwn(paths,name)?paths[name]:paths.vault;return '<svg class="ui-icon studio-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+markup+'</svg>';}
window.UIIcons=Object.freeze({icon,names:Object.freeze(Object.keys(paths))});
})();
