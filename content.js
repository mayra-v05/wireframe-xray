// Wireframe X-Ray — content script
// Re-injected on every click; the guard makes sure everything exists only once.
(() => {
  if (window.__wfx) return;

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  // Three id selectors that never match, inside a :not(), give our rules
  // specificity (3,1,0), so they beat almost every page rule.
  const S = ':not(#_wfx#_wfy#_wfz)';
  const UI_TAG = 'wfx-xray-ui';
  const LBL_TAG = 'wfx-xray-labels';
  const INS_TAG = 'wfx-xray-inspect';
  const ATTRS = ['data-wfx', 'data-wfx-box', 'data-wfx-lm', 'data-wfx-media'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE',
    'BASE', 'BR', 'WBR', 'SOURCE', 'TRACK', 'PARAM', 'AREA', 'MAP']);

  const INK = '#262626';
  const LINE = '#bdbdbd';
  const MEDIA_LINE = '#b4b4b4';
  const ACCENT = '#3b6cff';
  const FILL_HEX = { 1: '#FFFFFF', 2: '#F2F2F2', 3: '#E3E3E3', h: '#ECECEC' };

  const LANDMARK = {
    header: 'Header', nav: 'Navigation', main: 'Main', footer: 'Footer', aside: 'Aside',
    section: 'Section', article: 'Article', form: 'Form', dialog: 'Dialog',
  };
  const ROLE = {
    banner: 'Header', navigation: 'Navigation', main: 'Main', contentinfo: 'Footer',
    complementary: 'Aside', search: 'Search', dialog: 'Dialog', region: 'Section', form: 'Form',
  };

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  let active = false;
  let settings = { outlines: true, labels: false, fills: true, inspect: false };
  const roots = new Set();          // shadow roots that have our stylesheet
  const sheet = new CSSStyleSheet(); // CSSOM: also works on pages with a strict CSP
  let observer = null;
  let uiHost = null, ui = null;
  let labelHost = null, labelRoot = null, labelsQueued = false;

  const ready = chrome.storage.sync.get('wfxSettings').then((r) => {
    if (r?.wfxSettings) settings = { ...settings, ...r.wfxSettings };
  }).catch(() => {});

  /* ------------------------------------------------------------------ *
   * Color → gray level
   * ------------------------------------------------------------------ */

  const colorCtx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();

  function rgba(str) {
    if (!str || str === 'transparent') return [0, 0, 0, 0];
    let c = colorCache.get(str);
    if (c) return c;
    const m = str.match(/^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\)$/);
    if (m) {
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      c = [+m[1], +m[2], +m[3], a];
    } else {
      // oklch(), color(), lab() … let the canvas convert it.
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = '#000';
      colorCtx.fillStyle = str;
      colorCtx.fillRect(0, 0, 1, 1);
      const d = colorCtx.getImageData(0, 0, 1, 1).data;
      c = [d[0], d[1], d[2], d[3] / 255];
    }
    colorCache.set(str, c);
    return c;
  }

  // Light areas stay white, midtones light gray, dark areas gray.
  // This keeps the contrast between sections visible without color.
  function fillLevel([r, g, b, a]) {
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const l = lum * a + (1 - a);
    return l >= 0.96 ? '1' : l >= 0.6 ? '2' : '3';
  }

  /* ------------------------------------------------------------------ *
   * Marking elements
   * ------------------------------------------------------------------ */

  function landmarkOf(el) {
    const role = el.getAttribute('role');
    if (role && ROLE[role]) return ROLE[role];
    if (/^h[1-6]$/.test(el.localName)) return el.localName.toUpperCase();
    return LANDMARK[el.localName] || null;
  }

  function isOurs(el) {
    return el.localName === UI_TAG || el.localName === LBL_TAG || el.localName === INS_TAG;
  }

  // Phase 1: read only (getComputedStyle), so the browser computes styles once.
  function inspect(el) {
    if (el.hasAttribute('data-wfx') || SKIP.has(el.tagName) || isOurs(el) || el.ownerSVGElement) return null;
    const ln = el.localName;
    const cs = getComputedStyle(el);

    let fill = 't';
    const bi = cs.backgroundImage;
    if (bi && bi !== 'none' && bi.includes('url(')) fill = 'h';
    else {
      const c = rgba(cs.backgroundColor);
      if (c[3] > 0.08) fill = fillLevel(c);
      else if (bi && bi !== 'none') fill = '2'; // gradient
    }

    let media = null;
    if (ln === 'img' || ln === 'video' || ln === 'svg' || (ln === 'input' && el.type === 'image')) media = 'img';
    else if (ln === 'canvas' || ln === 'iframe' || ln === 'embed' || ln === 'object') media = 'embed';
    if (media === 'img' || fill === 'h') {
      const r = el.getBoundingClientRect();
      if (r.width && r.width <= 40 && r.height <= 40) media = 'icon';
    }

    return {
      el,
      fill,
      box: cs.display !== 'inline' && cs.display !== 'contents' && cs.display !== 'none',
      lm: landmarkOf(el),
      media,
    };
  }

  // Phase 2: write only.
  function apply(info) {
    const { el } = info;
    el.setAttribute('data-wfx', info.fill);
    if (info.box) el.setAttribute('data-wfx-box', '');
    if (info.lm) el.setAttribute('data-wfx-lm', info.lm);
    if (info.media) el.setAttribute('data-wfx-media', info.media);
  }

  function markAll(elements) {
    const infos = [];
    for (const el of elements) {
      const info = inspect(el);
      if (info) infos.push(info);
    }
    infos.forEach(apply);
  }

  function collect(root, out, shadowRoots) {
    for (const el of root.querySelectorAll('*')) {
      if (isOurs(el)) continue;
      out.push(el);
      if (el.shadowRoot) {
        shadowRoots.push(el.shadowRoot);
        collect(el.shadowRoot, out, shadowRoots);
      }
    }
  }

  function markSubtree(node) {
    const els = [node];
    const shadowRoots = node.shadowRoot ? [node.shadowRoot] : [];
    collect(node, els, shadowRoots);
    if (node.shadowRoot) collect(node.shadowRoot, els, shadowRoots);
    shadowRoots.forEach(adoptShadow);
    markAll(els);
  }

  function adoptShadow(root) {
    if (roots.has(root)) return;
    roots.add(root);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    observer?.observe(root, { childList: true, subtree: true });
  }

  function unmarkRoot(root) {
    for (const el of root.querySelectorAll('[data-wfx]')) ATTRS.forEach((a) => el.removeAttribute(a));
  }

  /* ------------------------------------------------------------------ *
   * Stylesheet
   * ------------------------------------------------------------------ */

  function buildCSS() {
    const A = `[data-wfx]${S}`;
    const cross = (dir) =>
      `linear-gradient(to ${dir}, transparent calc(50% - .6px), ${MEDIA_LINE} calc(50% - .6px), ${MEDIA_LINE} calc(50% + .6px), transparent calc(50% + .6px))`;

    let css = `
html${S}, body${S} { background: #fff !important; color-scheme: light !important; }

${A}, ${A}::before, ${A}::after {
  color: ${INK} !important;
  -webkit-text-fill-color: currentColor !important;
  background-image: none !important;
  background-color: transparent !important;
  border-color: ${LINE} !important;
  outline-color: ${LINE} !important;
  box-shadow: none !important;
  text-shadow: none !important;
  filter: none !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  mix-blend-mode: normal !important;
  text-decoration-color: currentColor !important;
  caret-color: ${INK} !important;
  accent-color: #8a8a8a !important;
}
${A}::placeholder { color: #9a9a9a !important; -webkit-text-fill-color: #9a9a9a !important; }
${A}::selection { background: #d5ddff !important; }
`;

    if (settings.fills) {
      css += `
[data-wfx="1"]${S} { background-color: #fff !important; }
[data-wfx="2"]${S} { background-color: #f2f2f2 !important; }
[data-wfx="3"]${S} { background-color: #e3e3e3 !important; }
[data-wfx="h"]${S} {
  background-color: #f5f5f5 !important;
  background-image: repeating-linear-gradient(-45deg, #e4e4e4 0 1px, transparent 1px 9px) !important;
}`;
    } else {
      css += `
[data-wfx]${S}:not([data-wfx="t"]) { background-color: #fff !important; }`;
    }

    css += `
:is(input:not([type=checkbox], [type=radio], [type=range], [type=image], [type=hidden]), textarea, select)[data-wfx]${S} {
  background-color: #fff !important;
  box-shadow: inset 0 0 0 1px #9e9e9e !important;
}

[data-wfx-media]${S} > * { visibility: hidden !important; }
[data-wfx-media="img"]${S} {
  object-position: -99999px -99999px !important;
  background: ${cross('top right')}, ${cross('bottom right')}, #ececec !important;
  box-shadow: inset 0 0 0 1px ${MEDIA_LINE} !important;
}
[data-wfx-media="icon"]${S} {
  object-position: -99999px -99999px !important;
  background: #cdcdcd !important;
  border-radius: 3px !important;
}
[data-wfx-media="embed"]${S} {
  filter: grayscale(1) contrast(0) brightness(1.8) !important;
  outline: 1px solid ${MEDIA_LINE} !important;
  outline-offset: -1px !important;
}`;

    if (settings.outlines) {
      css += `
[data-wfx-box]${S}:not(html, body, [data-wfx-media]) {
  outline: 1px dashed rgba(0, 0, 0, .16) !important;
  outline-offset: -1px !important;
}`;
    }

    if (settings.labels) {
      css += `
[data-wfx-lm]${S} {
  outline: 1.5px solid rgba(59, 108, 255, .6) !important;
  outline-offset: -1.5px !important;
}`;
    }

    if (settings.inspect) {
      css += `
[data-wfx]${S} { cursor: crosshair !important; }`;
    }

    return css;
  }

  function refreshSheet() {
    sheet.replaceSync(buildCSS());
  }

  /* ------------------------------------------------------------------ *
   * On / off
   * ------------------------------------------------------------------ */

  function activate() {
    if (active) return;
    active = true;
    refreshSheet();

    // Mark first (read the original styles), only then enable the stylesheet.
    markSubtree(document.documentElement);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) if (n.nodeType === 1 && !isOurs(n)) markSubtree(n);
      }
      queueLabels();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    roots.forEach((r) => observer.observe(r, { childList: true, subtree: true }));

    buildUI();
    renderLabels();
    if (settings.inspect) enableInspect();
    addEventListener('resize', queueLabels, { passive: true });
    addEventListener('scroll', queueLabels, { passive: true, capture: true });
  }

  function deactivate() {
    if (!active) return;
    active = false;
    observer?.disconnect();
    observer = null;

    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    unmarkRoot(document);
    roots.forEach((r) => {
      r.adoptedStyleSheets = r.adoptedStyleSheets.filter((s) => s !== sheet);
      unmarkRoot(r);
    });
    roots.clear();

    removeEventListener('resize', queueLabels);
    removeEventListener('scroll', queueLabels, { capture: true });
    disableInspect();
    uiHost?.remove();
    labelHost?.remove();
    uiHost = ui = labelHost = labelRoot = null;
  }

  function setSetting(key, value) {
    settings[key] = value;
    chrome.storage.sync.set({ wfxSettings: settings }).catch(() => {});
    refreshSheet();
    renderLabels();
    if (key === 'inspect') {
      if (value) {
        enableInspect();
        ui?.toast('Hover for margins, padding and grid · click to lock and measure distances · Esc');
      } else disableInspect();
    }
    ui?.sync();
  }

  /* ------------------------------------------------------------------ *
   * Labels (Header, Navigation, H1 …)
   * ------------------------------------------------------------------ */

  function queueLabels() {
    if (labelsQueued || !settings.labels) return;
    labelsQueued = true;
    requestAnimationFrame(() => {
      labelsQueued = false;
      renderLabels();
    });
  }

  function renderLabels() {
    if (!active || !settings.labels) {
      labelHost?.remove();
      labelHost = labelRoot = null;
      return;
    }
    if (!labelHost) {
      labelHost = document.createElement(LBL_TAG);
      labelHost.style.cssText =
        'all:initial;position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
      labelRoot = labelHost.attachShadow({ mode: 'closed' });
      const s = new CSSStyleSheet();
      s.replaceSync(`
        .b { position: absolute; font: 600 10px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
             letter-spacing: .04em; color: #fff; background: ${ACCENT}; padding: 3px 5px 3px 4px;
             border-radius: 0 0 4px 0; white-space: nowrap; }
        .b.h { background: #1b1c1f; }`);
      labelRoot.adoptedStyleSheets = [s];
    }
    if (!labelHost.isConnected) document.documentElement.appendChild(labelHost);

    labelRoot.replaceChildren();
    const placed = [];
    const sx = scrollX, sy = scrollY;
    for (const el of document.querySelectorAll('[data-wfx-lm]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const lm = el.getAttribute('data-wfx-lm');
      const b = document.createElement('div');
      b.className = /^H\d$/.test(lm) ? 'b h' : 'b';
      b.textContent = lm.toUpperCase();
      let x = r.left + sx, y = r.top + sy;
      b.style.left = `${x}px`;
      b.style.top = `${y}px`;
      labelRoot.appendChild(b);
      const w = b.offsetWidth, h = b.offsetHeight;
      // Headings: label to the left of the text, so it doesn't cover the heading.
      if (b.className === 'b h' && r.left - w - 4 >= 0) {
        x -= w + 4;
        b.style.borderRadius = '3px';
      }
      // Place overlapping labels (header and nav in the same spot) side by side.
      let moved = true;
      while (moved) {
        moved = false;
        for (const p of placed) {
          if (x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y) {
            x = p.x + p.w + 2;
            moved = true;
          }
        }
      }
      b.style.left = `${x}px`;
      placed.push({ x, y, w, h });
    }
  }

  /* ------------------------------------------------------------------ *
   * Inspect: box model, grid/flex, gaps and distances
   * ------------------------------------------------------------------ */

  const MEASURE = '#ff3b6b';
  let insHost = null, insRoot = null, insQueued = false;
  let hovered = null, selected = null;

  const INS_CSS = `
    :host { all: initial; }
    .l { position: fixed; left: 0; top: 0; pointer-events: none; box-sizing: border-box; }
    .m { background: rgba(246, 178, 107, .38); }
    .p { background: rgba(147, 196, 125, .42); }
    .c { background: rgba(59, 108, 255, .13); }
    .sel { outline: 2px solid ${ACCENT}; }
    .hov { outline: 1px dashed ${ACCENT}; }
    .gap { background: repeating-linear-gradient(-45deg, rgba(255,59,107,.38) 0 1px, rgba(255,59,107,.1) 1px 6px); }
    .col { background: rgba(59,108,255,.09); box-shadow: inset 1px 0 0 rgba(59,108,255,.6), inset -1px 0 0 rgba(59,108,255,.6); }
    .row { box-shadow: inset 0 1px 0 rgba(59,108,255,.6), inset 0 -1px 0 rgba(59,108,255,.6); }
    .ln { background: ${MEASURE}; }
    .tag { z-index: 2; transform: translate(-50%, -50%); padding: 2px 4px; border-radius: 3px; color: #fff; white-space: nowrap;
           font: 600 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .t-m { background: #b8701f; } .t-p { background: #4f8040; } .t-d { background: ${MEASURE}; } .t-k { background: ${ACCENT}; }
    .card { z-index: 3; width: max-content; min-width: 210px; max-width: 320px; padding: 10px 12px; border-radius: 10px;
            background: #141518; color: #e8eaee; box-shadow: 0 10px 30px rgba(0,0,0,.3);
            font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
    .hd { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; margin-bottom: 6px; }
    .hd b { color: #fff; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
    .hd span, dd { font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .hd span { color: #9da2ad; }
    dl { display: grid; grid-template-columns: auto 1fr; gap: 1px 12px; margin: 0; }
    dt { color: #8d929d; white-space: nowrap; }
    dd { margin: 0; color: #fff; word-break: break-word; }
    .dot { display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 6px; vertical-align: 1px; }
    .hint { margin-top: 8px; padding-top: 7px; border-top: 1px solid rgba(255,255,255,.08); color: #8d929d; font-size: 11px; }
  `;

  const num = (v) => parseFloat(v) || 0;
  const fmt = (v) => String(Math.round(v * 10) / 10);
  const quad = (cs, prop, suffix = '') =>
    ['Top', 'Right', 'Bottom', 'Left'].map((sd) => num(cs[`${prop}${sd}${suffix}`]));
  function shorthand([t, r, b, l]) {
    if (t === r && r === b && b === l) return fmt(t);
    if (t === b && l === r) return `${fmt(t)} ${fmt(r)}`;
    return `${fmt(t)} ${fmt(r)} ${fmt(b)} ${fmt(l)}`;
  }

  function layer(cls, x, y, w, hgt) {
    const d = document.createElement('div');
    d.className = `l ${cls}`;
    d.style.cssText = `left:${x}px;top:${y}px;width:${Math.max(0, w)}px;height:${Math.max(0, hgt)}px`;
    insRoot.appendChild(d);
    return d;
  }

  function tag(cls, x, y, text) {
    const d = document.createElement('div');
    d.className = `l tag ${cls}`;
    d.style.left = `${x}px`;
    d.style.top = `${y}px`;
    d.textContent = text;
    insRoot.appendChild(d);
  }

  // Space between an outer and inner rectangle, with values per side.
  function ring(cls, tcls, o, i, [t, r, b, l]) {
    layer(cls, o.l, o.t, o.r - o.l, i.t - o.t);
    layer(cls, o.l, i.b, o.r - o.l, o.b - i.b);
    layer(cls, o.l, i.t, i.l - o.l, i.b - i.t);
    layer(cls, i.r, i.t, o.r - i.r, i.b - i.t);
    const cx = (i.l + i.r) / 2, cy = (i.t + i.b) / 2;
    if (Math.abs(t) >= 1) tag(tcls, cx, (o.t + i.t) / 2, fmt(t));
    if (Math.abs(b) >= 1) tag(tcls, cx, (i.b + o.b) / 2, fmt(b));
    if (Math.abs(l) >= 1) tag(tcls, (o.l + i.l) / 2, cy, fmt(l));
    if (Math.abs(r) >= 1) tag(tcls, (i.r + o.r) / 2, cy, fmt(r));
  }

  function boxModel(cs, rect) {
    const m = quad(cs, 'margin');
    const bw = quad(cs, 'border', 'Width');
    const p = quad(cs, 'padding');
    const border = { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom };
    const outer = {
      l: border.l - Math.max(0, m[3]), t: border.t - Math.max(0, m[0]),
      r: border.r + Math.max(0, m[1]), b: border.b + Math.max(0, m[2]),
    };
    const pad = { l: border.l + bw[3], t: border.t + bw[0], r: border.r - bw[1], b: border.b - bw[2] };
    const content = { l: pad.l + p[3], t: pad.t + p[0], r: pad.r - p[1], b: pad.b - p[2] };
    ring('m', 't-m', outer, border, m);
    ring('p', 't-p', pad, content, p);
    layer('c', content.l, content.t, content.r - content.l, content.b - content.t);
    return { m, p, content };
  }

  function tracks(value) {
    return (value || '').replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/).map(parseFloat).filter((n) => !Number.isNaN(n));
  }

  function gridOverlay(cs, c) {
    const cols = tracks(cs.gridTemplateColumns);
    const rows = tracks(cs.gridTemplateRows);
    const cg = num(cs.columnGap), rg = num(cs.rowGap);
    let x = c.l;
    cols.forEach((w, i) => {
      layer('col', x, c.t, w, c.b - c.t);
      tag('t-k', x + w / 2, c.t + 9, fmt(w));
      x += w;
      if (i < cols.length - 1 && cg > 0) {
        layer('gap', x, c.t, cg, c.b - c.t);
        if (i === 0) tag('t-d', x + cg / 2, c.t + (c.b - c.t) / 2, fmt(cg));
        x += cg;
      }
    });
    let y = c.t;
    rows.forEach((hgt, i) => {
      layer('row', c.l, y, c.r - c.l, hgt);
      y += hgt;
      if (i < rows.length - 1 && rg > 0) {
        layer('gap', c.l, y, c.r - c.l, rg);
        if (i === 0) tag('t-d', c.l + 18, y + rg / 2, fmt(rg));
        y += rg;
      }
    });
    return { cols, rows, cg, rg };
  }

  function inFlowKids(el) {
    return [...el.children].filter((k) => {
      if (isOurs(k)) return false;
      const kcs = getComputedStyle(k);
      return kcs.display !== 'none' && kcs.position !== 'absolute' && kcs.position !== 'fixed';
    });
  }

  // Space between consecutive children: shows the distance between sections.
  function childGaps(el) {
    const rects = inFlowKids(el).slice(0, 80).map((k) => k.getBoundingClientRect()).filter((r) => r.width || r.height);
    for (let i = 1; i < rects.length; i++) {
      const a = rects[i - 1], b = rects[i];
      const ov = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      if (b.top - a.bottom >= 1 && ov > 0) {
        const l = Math.max(a.left, b.left);
        layer('gap', l, a.bottom, ov, b.top - a.bottom);
        tag('t-d', l + ov / 2, (a.bottom + b.top) / 2, fmt(b.top - a.bottom));
      } else if (b.left - a.right >= 1) {
        const t = Math.max(a.top, b.top), hgt = Math.min(a.bottom, b.bottom) - t;
        if (hgt <= 0) continue;
        layer('gap', a.right, t, b.left - a.right, hgt);
        tag('t-d', (a.right + b.left) / 2, t + hgt / 2, fmt(b.left - a.right));
      }
    }
  }

  function vline(x, y1, y2) {
    const d = y2 - y1;
    if (d < 1) return;
    layer('ln', x - 0.5, y1, 1, d);
    layer('ln', x - 3, y1, 7, 1);
    layer('ln', x - 3, y2 - 1, 7, 1);
    tag('t-d', x, (y1 + y2) / 2, fmt(d));
  }

  function hline(y, x1, x2) {
    const d = x2 - x1;
    if (d < 1) return;
    layer('ln', x1, y - 0.5, d, 1);
    layer('ln', x1, y - 3, 1, 7);
    layer('ln', x2 - 1, y - 3, 1, 7);
    tag('t-d', (x1 + x2) / 2, y, fmt(d));
  }

  // Figma-style distance between two rectangles.
  function measure(a, b) {
    const inside = (o, i) => i.left >= o.left - 0.5 && i.right <= o.right + 0.5 && i.top >= o.top - 0.5 && i.bottom <= o.bottom + 0.5;
    if (inside(a, b) || inside(b, a)) {
      const [o, i] = inside(a, b) ? [a, b] : [b, a];
      const cx = (i.left + i.right) / 2, cy = (i.top + i.bottom) / 2;
      vline(cx, o.top, i.top);
      vline(cx, i.bottom, o.bottom);
      hline(cy, o.left, i.left);
      hline(cy, i.right, o.right);
      return;
    }
    const ox1 = Math.max(a.left, b.left), ox2 = Math.min(a.right, b.right);
    const oy1 = Math.max(a.top, b.top), oy2 = Math.min(a.bottom, b.bottom);
    const x = ox2 > ox1 ? (ox1 + ox2) / 2 : (b.left + b.right) / 2;
    const y = oy2 > oy1 ? (oy1 + oy2) / 2 : (b.top + b.bottom) / 2;
    if (b.top >= a.bottom) vline(x, a.bottom, b.top);
    else if (a.top >= b.bottom) vline(x, b.bottom, a.top);
    if (b.left >= a.right) hline(y, a.right, b.left);
    else if (a.left >= b.right) hline(y, b.right, a.left);
  }

  function visibleSibling(el, dir) {
    let s = el[dir];
    while (s) {
      const scs = getComputedStyle(s);
      if (!isOurs(s) && scs.display !== 'none' && scs.position !== 'absolute' && scs.position !== 'fixed') return s;
      s = s[dir];
    }
    return null;
  }

  function hasOwnText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  }

  function infoCard(el, cs, r, { grid, compact }) {
    const rows = [];
    const add = (k, v, dot) => rows.push([k, v, dot]);
    const d = cs.display;

    if (!compact) {
      if (grid) {
        add('layout', `grid · ${grid.cols.length} col × ${grid.rows.length} row`);
        if (grid.cols.length) {
          const shown = grid.cols.slice(0, 6).map(fmt).join(' ');
          add('columns', grid.cols.length > 6 ? `${shown} …` : shown);
        }
      } else if (d.includes('flex')) {
        add('layout', `flex · ${cs.flexDirection}${cs.flexWrap === 'wrap' ? ' · wrap' : ''}`);
      } else {
        add('layout', d);
      }
      if (grid || d.includes('flex')) {
        const rg = num(cs.rowGap), cg = num(cs.columnGap);
        if (rg || cg) add('gap', rg === cg ? fmt(rg) : `${fmt(rg)} / ${fmt(cg)}`);
        add('alignment', `${cs.justifyContent} · ${cs.alignItems}`);
      }
      add('padding', shorthand(quad(cs, 'padding')), '#93c47d');
      add('margin', shorthand(quad(cs, 'margin')), '#f6b26b');
      const bw = quad(cs, 'border', 'Width');
      if (bw.some(Boolean)) add('border', shorthand(bw));
      const radius = num(cs.borderTopLeftRadius);
      if (radius) add('radius', fmt(radius));
      if (cs.maxWidth !== 'none') add('max-width', cs.maxWidth);
      if (hasOwnText(el)) {
        const lh = cs.lineHeight === 'normal' ? 'normal' : fmt(num(cs.lineHeight));
        add('font', `${fmt(num(cs.fontSize))}/${lh} · ${cs.fontWeight}`);
        add('family', cs.fontFamily.split(',')[0].replace(/["']/g, ''));
      }
    }

    const dl = h('dl');
    for (const [k, v, dot] of rows) {
      const dt = h('dt');
      if (dot) {
        const sp = h('span', { class: 'dot' });
        sp.style.background = dot;
        dt.append(sp);
      }
      dt.append(k);
      dl.append(dt, h('dd', {}, v));
    }
    const hint = selected
      ? 'Export uses this selection · ↑ parent · ↓ child · hover another element to measure · Esc releases'
      : 'Click to lock and measure distances';
    const card = h('div', { class: 'l card' },
      h('div', { class: 'hd' }, h('b', {}, nameOf(el)), h('span', {}, `${fmt(r.width)} × ${fmt(r.height)}`)),
      rows.length ? dl : null,
      h('div', { class: 'hint' }, hint));
    insRoot.appendChild(card);

    // Below the element, otherwise above it, otherwise inside the viewport.
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const x = Math.min(Math.max(8, r.left), innerWidth - cw - 8);
    let y = r.bottom + 10;
    if (y + ch > innerHeight - 70) y = r.top - ch - 10;
    if (y < 8) y = Math.min(Math.max(8, r.top + 8), innerHeight - ch - 70);
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }

  function renderInspect() {
    insQueued = false;
    if (!insRoot) return;
    insRoot.replaceChildren();
    const hov = hovered?.isConnected ? hovered : null;
    const sel = selected?.isConnected ? selected : null;
    if (!sel) selected = null;

    if (sel) {
      const sr = sel.getBoundingClientRect();
      layer('sel', sr.left, sr.top, sr.width, sr.height);
    }
    if (!hov) return;

    const cs = getComputedStyle(hov);
    const r = hov.getBoundingClientRect();

    if (sel && hov !== sel) {
      layer('hov', r.left, r.top, r.width, r.height);
      measure(sel.getBoundingClientRect(), r);
      infoCard(hov, cs, r, { compact: true });
      return;
    }

    const { content } = boxModel(cs, r);
    const grid = cs.display.includes('grid') ? gridOverlay(cs, content) : null;
    if (!grid) childGaps(hov);
    if (!sel) {
      for (const dir of ['previousElementSibling', 'nextElementSibling']) {
        const sib = visibleSibling(hov, dir);
        if (sib) measure(r, sib.getBoundingClientRect());
      }
    }
    infoCard(hov, cs, r, { grid });
  }

  function queueInspect() {
    if (insQueued || !insRoot) return;
    insQueued = true;
    requestAnimationFrame(renderInspect);
  }

  function inspectTarget(e) {
    const path = e.composedPath();
    if (uiHost && path.includes(uiHost)) return null;
    let t = path[0];
    if (t?.nodeType !== 1) t = t?.parentElement;
    while (t?.ownerSVGElement) t = t.ownerSVGElement;
    if (!t || t === document.documentElement || isOurs(t)) return null;
    return t;
  }

  function onInspectMove(e) {
    const t = inspectTarget(e);
    if (t === hovered) return;
    hovered = t;
    queueInspect();
  }

  function onInspectClick(e) {
    const t = inspectTarget(e);
    if (!t) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    selected = selected === t ? null : t;
    queueInspect();
  }

  function onInspectKey(e) {
    if (!selected) return;
    let next;
    if (e.key === 'Escape') next = null;
    else if (e.key === 'ArrowUp') next = selected.parentElement && selected.parentElement !== document.documentElement ? selected.parentElement : selected;
    else if (e.key === 'ArrowDown') next = inFlowKids(selected)[0] || selected;
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
    selected = next;
    hovered = next;
    queueInspect();
  }

  function onInspectLeave(e) {
    if (!e.relatedTarget) {
      hovered = null;
      queueInspect();
    }
  }

  const INSPECT_EVENTS = [
    ['pointermove', onInspectMove], ['click', onInspectClick], ['mousedown', onInspectClick],
    ['mouseup', onInspectClick], ['keydown', onInspectKey], ['mouseout', onInspectLeave],
    ['scroll', queueInspect], ['resize', queueInspect],
  ];

  function enableInspect() {
    if (insHost) return;
    insHost = document.createElement(INS_TAG);
    insHost.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
    insRoot = insHost.attachShadow({ mode: 'closed' });
    const s = new CSSStyleSheet();
    s.replaceSync(INS_CSS);
    insRoot.adoptedStyleSheets = [s];
    document.documentElement.appendChild(insHost);
    for (const [type, fn] of INSPECT_EVENTS) addEventListener(type, fn, { capture: true, passive: type === 'scroll' });
  }

  function disableInspect() {
    if (!insHost) return;
    for (const [type, fn] of INSPECT_EVENTS) removeEventListener(type, fn, { capture: true });
    insHost.remove();
    insHost = insRoot = hovered = selected = null;
  }

  /* ------------------------------------------------------------------ *
   * Reading the structure for Figma
   * ------------------------------------------------------------------ */

  const MAX_NODES = 8000;
  let nodeCount = 0;

  const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const excerpt = (s, n = 32) => {
    s = squash(s);
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  };

  function nameOf(el) {
    const ln = el.localName;
    const lm = el.getAttribute('data-wfx-lm') || landmarkOf(el);
    const label = squash(el.getAttribute('aria-label'));
    const text = () => excerpt(el.textContent || label);
    if (lm) {
      if (/^H\d$/.test(lm)) return `${lm} · ${text()}`;
      return label ? `${lm} · ${excerpt(label)}` : lm;
    }
    if (ln === 'button' || el.getAttribute('role') === 'button') return `Button · ${text()}`;
    if (ln === 'a') return `Link · ${text()}`;
    if (ln === 'input') return `Input · ${el.type || 'text'}`;
    const named = {
      ul: 'List', ol: 'List', li: 'List item', p: 'Paragraph', table: 'Table', tr: 'Row',
      td: 'Cell', th: 'Header cell', textarea: 'Textarea', select: 'Select', label: 'Label',
      figure: 'Figure', blockquote: 'Quote', fieldset: 'Fieldset',
    }[ln];
    if (named) return named;
    if (el.id) return `${ln}#${el.id}`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    return cls ? `${ln}.${cls}` : ln;
  }

  function mediaName(el, kind) {
    if (kind === 'icon') return 'Icon';
    if (kind === 'embed') return el.localName === 'iframe' ? 'Embed · iframe' : `Embed · ${el.localName}`;
    const alt = excerpt(el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title'), 28);
    if (el.localName === 'video') return 'Video';
    return alt ? `Image · ${alt}` : 'Image';
  }

  function transformText(s, tt) {
    if (tt === 'uppercase') return s.toUpperCase();
    if (tt === 'lowercase') return s.toLowerCase();
    if (tt === 'capitalize') return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    return s;
  }

  function radiusOf(cs, w, h) {
    const r = parseFloat(cs.borderTopLeftRadius) || 0;
    return Math.min(r, w / 2, h / 2);
  }

  function strokeOf(cs) {
    let w = 0;
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (cs[`border${side}Style`] !== 'none') w = Math.max(w, parseFloat(cs[`border${side}Width`]) || 0);
    }
    return Math.min(w, 2);
  }

  function textNode(n, pel) {
    const raw = n.nodeValue;
    if (!raw || !raw.trim() || !pel) return null;
    const cs = getComputedStyle(pel);
    if (cs.visibility === 'hidden') return null;

    const range = document.createRange();
    range.selectNodeContents(n);
    const br = range.getBoundingClientRect();
    if (br.width < 1 || br.height < 1) return null;

    const sx = scrollX, sy = scrollY;
    const fs = parseFloat(cs.fontSize) || 16;
    const lh = cs.lineHeight === 'normal' ? fs * 1.2 : parseFloat(cs.lineHeight) || fs * 1.2;
    const tt = cs.textTransform;

    // Group words per line, so line breaks match in Figma.
    const lines = [];
    const re = /\S+/g;
    let m, words = 0;
    while ((m = re.exec(raw)) && words++ < 2000) {
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      const wr = range.getBoundingClientRect();
      if (!wr.width && !wr.height) continue;
      const line = lines[lines.length - 1];
      if (line && Math.abs(wr.top - line.top) < fs * 0.5) {
        line.text += ` ${m[0]}`;
        line.right = Math.max(line.right, wr.right);
        line.bottom = Math.max(line.bottom, wr.bottom);
      } else {
        lines.push({ top: wr.top, left: wr.left, right: wr.right, bottom: wr.bottom, text: m[0] });
      }
    }
    if (!lines.length) return null;

    const text = transformText(lines.map((l) => l.text).join(' '), tt);
    nodeCount++;
    return {
      t: 'text',
      n: excerpt(text, 40),
      x: br.left + sx, y: br.top + sy, w: br.width, h: br.height,
      text,
      fs,
      fw: parseInt(cs.fontWeight, 10) || 400,
      lh,
      it: cs.fontStyle === 'italic',
      u: cs.textDecorationLine.includes('underline'),
      ta: cs.textAlign,
      lines: lines.map((l) => ({
        x: l.left + sx, y: l.top + sy, w: l.right - l.left, h: l.bottom - l.top,
        s: transformText(l.text, tt),
      })),
    };
  }

  function walkChildren(el, parent) {
    const kids = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
    for (const k of kids) walkNode(k, parent, el);
  }

  function walkNode(n, parent, parentEl) {
    if (nodeCount > MAX_NODES) return;
    if (n.nodeType === 3) {
      const t = textNode(n, n.parentElement || parentEl);
      if (t) parent.c.push(t);
      return;
    }
    if (n.nodeType !== 1) return;

    const el = n;
    const ln = el.localName;
    if (ln === 'slot') {
      for (const a of el.assignedNodes({ flatten: true })) walkNode(a, parent, a.parentElement || el);
      return;
    }
    if (SKIP.has(el.tagName) || isOurs(el) || el.ownerSVGElement) return;

    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return;
    if (cs.display === 'contents') return walkChildren(el, parent);

    const r = el.getBoundingClientRect();
    const box = { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };

    const media = el.getAttribute('data-wfx-media');
    if (media) {
      if (r.width < 1 || r.height < 1) return;
      nodeCount++;
      parent.c.push({ t: media, n: mediaName(el, media), ...box, r: radiusOf(cs, r.width, r.height) });
      return;
    }

    // Inline elements (span, strong, a …) are flattened: their text belongs to the parent.
    if (cs.display === 'inline') return walkChildren(el, parent);
    if (r.width < 1 || r.height < 1) {
      if (cs.overflow === 'visible') walkChildren(el, parent);
      return;
    }

    const v = el.getAttribute('data-wfx');
    let fill = settings.fills ? FILL_HEX[v] || null : v && v !== 't' ? '#FFFFFF' : null;
    let stroke = strokeOf(cs);
    let sc = null;
    const isField = ln === 'textarea' || ln === 'select' ||
      (ln === 'input' && !['checkbox', 'radio', 'range', 'hidden', 'image'].includes(el.type));
    if (isField) {
      fill = '#FFFFFF';
      stroke = 1;
      sc = '#9E9E9E';
    }

    const node = {
      t: 'frame',
      n: nameOf(el),
      ...box,
      fill,
      stroke,
      sc,
      r: radiusOf(cs, r.width, r.height),
      clip: cs.overflowX !== 'visible' || cs.overflowY !== 'visible',
      bg: v && v !== 't' ? v : null,
      lay: layoutOf(cs),
      pad: quad(cs, 'padding'),
      mar: quad(cs, 'margin'),
      mw: cs.maxWidth !== 'none' ? cs.maxWidth : null,
      c: [],
    };
    nodeCount++;
    walkChildren(el, node);

    // Fields have no text nodes; add the value or placeholder as text.
    if (isField && !node.c.length) {
      const value = ln === 'select' ? el.selectedOptions?.[0]?.textContent : el.value || el.placeholder;
      if (squash(value)) {
        const fs = parseFloat(cs.fontSize) || 14;
        const pl = parseFloat(cs.paddingLeft) || 8;
        node.c.push({
          t: 'text', n: excerpt(value, 40), text: squash(value),
          x: box.x + pl, y: box.y + (box.h - fs * 1.3) / 2, w: box.w - pl * 2, h: fs * 1.3,
          fs, fw: 400, lh: fs * 1.3, ta: 'left', ph: !el.value,
          lines: [{ x: box.x + pl, y: box.y + (box.h - fs * 1.3) / 2, w: box.w - pl * 2, h: fs * 1.3, s: squash(value) }],
        });
      }
    }

    // Drop empty wrappers and collapse wrappers with a single child of the same size.
    if (!fill && !stroke && !el.hasAttribute('data-wfx-lm')) {
      if (!node.c.length) return;
      const only = node.c[0];
      if (node.c.length === 1 && Math.abs(only.x - node.x) < 1 && Math.abs(only.y - node.y) < 1 &&
          Math.abs(only.w - node.w) < 1 && Math.abs(only.h - node.h) < 1) {
        parent.c.push(only);
        return;
      }
    }
    parent.c.push(node);
  }

  function shiftTree(nodes, dx, dy) {
    for (const n of nodes) {
      n.x -= dx;
      n.y -= dy;
      for (const l of n.lines || []) {
        l.x -= dx;
        l.y -= dy;
      }
      if (n.c) shiftTree(n.c, dx, dy);
    }
  }

  // With an element: only that section, with (0,0) at the section's top left.
  function buildTree(scope) {
    nodeCount = 0;
    if (scope?.isConnected) {
      const r = scope.getBoundingClientRect();
      const cs = getComputedStyle(scope);
      const v = scope.getAttribute('data-wfx');
      const root = {
        t: 'frame', n: nameOf(scope), x: 0, y: 0, w: r.width, h: r.height,
        fill: (settings.fills && FILL_HEX[v]) || '#FFFFFF', bg: v && v !== 't' ? v : null,
        lay: layoutOf(cs), pad: quad(cs, 'padding'), r: radiusOf(cs, r.width, r.height), c: [],
      };
      walkChildren(scope, root);
      shiftTree(root.c, r.left + scrollX, r.top + scrollY);
      return {
        format: 'wireframe-xray',
        version: 1,
        title: `${document.title || location.hostname} — ${nameOf(scope)}`,
        url: location.href,
        scope: nameOf(scope),
        width: r.width,
        height: r.height,
        truncated: nodeCount > MAX_NODES,
        root,
      };
    }
    const de = document.documentElement;
    const width = de.clientWidth || innerWidth;
    const height = Math.max(de.scrollHeight, document.body?.scrollHeight || 0, innerHeight);
    const root = { t: 'frame', n: 'Page', x: 0, y: 0, w: width, h: height, fill: '#FFFFFF', c: [] };
    if (document.body) walkChildren(document.body, root);
    return {
      format: 'wireframe-xray',
      version: 1,
      title: document.title || location.hostname,
      url: location.href,
      width,
      height,
      truncated: nodeCount > MAX_NODES,
      root,
    };
  }

  /* ------------------------------------------------------------------ *
   * SVG — pasteable into Figma; <g id> becomes the layer name
   * ------------------------------------------------------------------ */

  function layoutOf(cs) {
    const d = cs.display;
    const gap = [num(cs.rowGap), num(cs.columnGap)];
    if (d.includes('grid')) {
      return { t: 'grid', cols: tracks(cs.gridTemplateColumns), rows: tracks(cs.gridTemplateRows).length, gap,
        jc: cs.justifyContent, ai: cs.alignItems };
    }
    if (d.includes('flex')) {
      return { t: 'flex', dir: cs.flexDirection, wrap: cs.flexWrap === 'wrap', gap, jc: cs.justifyContent, ai: cs.alignItems };
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Claude — readable outline with layout and spacing
   * ------------------------------------------------------------------ */

  const MAX_CLAUDE_CHARS = 60000;
  const BG_LABEL = { 1: 'white fill', 2: 'light gray fill', 3: 'dark fill', h: 'background image' };

  function toClaude(data) {
    const r = (n) => fmt(n);
    const sides = (q) => (q && q.some((v) => Math.abs(v) >= 1) ? shorthand(q.map((v) => Math.round(v))) : null);
    const quote = (t) => `"${t.length > 140 ? `${t.slice(0, 139)}…` : t}"`;
    const font = (n) => `${r(n.fs)}px/${n.fw}`;
    const baseName = (n) => n.n.split(' · ')[0];
    const lines = [];
    let size = 0, cut = false;

    function push(depth, text) {
      if (cut) return;
      const line = `${'  '.repeat(depth)}- ${text}`;
      size += line.length + 1;
      if (size > MAX_CLAUDE_CHARS) {
        cut = true;
        lines.push('- … (truncated: page is too large)');
        return;
      }
      lines.push(line);
    }

    function layoutText(l) {
      if (!l) return null;
      const [rg, cg] = l.gap;
      const gap = rg || cg ? ` gap ${rg === cg ? r(rg) : `${r(rg)}/${r(cg)}`}` : '';
      const align = [l.jc, l.ai].filter((v) => v && v !== 'normal' && v !== 'flex-start' && v !== 'start' && v !== 'stretch');
      const al = align.length ? ` · ${align.join(' / ')}` : '';
      if (l.t === 'grid') {
        const cols = l.cols.length ? ` ${l.cols.length} col (${l.cols.slice(0, 8).map(r).join(' ')}${l.cols.length > 8 ? ' …' : ''})` : '';
        return `grid${cols}${l.rows > 1 ? ` × ${l.rows} row` : ''}${gap}${al}`;
      }
      return `flex ${l.dir}${l.wrap ? ' wrap' : ''}${gap}${al}`;
    }

    function node(n, depth, spaceAbove) {
      const above = spaceAbove >= 1 ? `↑${r(spaceAbove)} ` : '';
      if (n.t === 'text') {
        push(depth, `${above}${quote(n.text)} · ${font(n)}${n.u ? ' · underlined' : ''}`);
        return;
      }
      if (n.t === 'img' || n.t === 'icon' || n.t === 'embed') {
        push(depth, `${above}${n.n} [${r(n.w)}×${r(n.h)}]${n.r ? ` · radius ${r(n.r)}` : ''}`);
        return;
      }

      const only = n.c.length === 1 && n.c[0].t === 'text' ? n.c[0] : null;
      const parts = [`${above}${only ? baseName(n) : n.n} [${r(n.w)}×${r(n.h)}]`];
      const lay = layoutText(n.lay);
      if (lay) parts.push(lay);
      const pad = sides(n.pad);
      if (pad) parts.push(`pad ${pad}`);
      const mar = sides(n.mar);
      if (mar) parts.push(`margin ${mar}`);
      if (n.mw) parts.push(`max-width ${n.mw}`);
      if (n.bg) parts.push(BG_LABEL[n.bg]);
      if (n.stroke) parts.push(`border ${r(n.stroke)}`);
      if (n.r) parts.push(`radius ${r(n.r)}`);
      if (only) parts.push(`${quote(only.text)} ${font(only)}`);
      push(depth, parts.join(' · '));
      if (!only) children(n, depth + 1);
    }

    function children(n, depth) {
      let prev = null;
      for (const c of n.c) {
        // Vertical space to the previous element in the same column.
        let space = 0;
        if (prev && c.y >= prev.y + prev.h && Math.min(c.x + c.w, prev.x + prev.w) > Math.max(c.x, prev.x)) {
          space = c.y - (prev.y + prev.h);
        }
        node(c, depth, space);
        prev = c;
      }
    }

    if (data.scope) node(data.root, 0, 0);
    else children(data.root, 0);

    return [
      `# Wireframe structure: ${data.title}`,
      '',
      `Source: ${data.url}`,
      data.scope
        ? `Only this section: ${data.scope} · ${r(data.width)}×${r(data.height)}px · viewport ${r(document.documentElement.clientWidth)}px wide`
        : `Viewport ${r(data.width)}px wide · page ${r(data.height)}px tall`,
      '',
      'This outline was made with Wireframe X-Ray. It describes the layout, hierarchy and spacing of the page; colors and images are left out.',
      'Notation: [w×h] = size in px · ↑n = vertical space to the previous element · pad/margin = top right bottom left (CSS shorthand) · gap = row/column · text as "…" · 16px/400 = font size/weight.',
      '',
      '## Structure',
      '',
      ...lines,
      '',
      '---',
      '',
    ].join('\n');
  }

  function toSVG(data) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const f = (n) => Math.round(n * 10) / 10;
    const defs = [];
    let clipId = 0;

    const rect = (n, fill, stroke, sc, rx = n.r) =>
      `<rect x="${f(n.x)}" y="${f(n.y)}" width="${f(n.w)}" height="${f(n.h)}"${rx ? ` rx="${f(rx)}"` : ''} fill="${fill || 'none'}"${
        stroke ? ` stroke="${sc || '#BDBDBD'}" stroke-width="${stroke}"` : ''}/>`;

    function node(n) {
      if (n.t === 'text') {
        const attrs = `font-family="Inter, Helvetica, Arial, sans-serif" font-size="${f(n.fs)}" font-weight="${n.fw}"${
          n.it ? ' font-style="italic"' : ''}${n.u ? ' text-decoration="underline"' : ''} fill="${n.ph ? '#9A9A9A' : '#262626'}"`;
        const parts = n.lines.map((l) =>
          `<text x="${f(l.x)}" y="${f(l.y + l.h / 2 + n.fs * 0.35)}" ${attrs}>${esc(l.s)}</text>`);
        return parts.length > 1
          ? `<g id="${esc(n.n)}">${parts.join('')}</g>`
          : parts[0].replace('<text ', `<text id="${esc(n.n)}" `);
      }
      if (n.t === 'img') {
        const { x, y, w, h } = n;
        return `<g id="${esc(n.n)}">${rect(n, '#ECECEC', 1, '#B4B4B4')}<path d="M${f(x)} ${f(y)}L${f(x + w)} ${f(y + h)}M${f(x + w)} ${f(y)}L${f(x)} ${f(y + h)}" stroke="#B4B4B4" stroke-width="1" fill="none"/></g>`;
      }
      if (n.t === 'icon') return rect(n, '#CDCDCD', 0, null, 3).replace('<rect ', `<rect id="${esc(n.n)}" `);
      if (n.t === 'embed') return rect(n, '#E6E6E6', 1, '#B4B4B4').replace('<rect ', `<rect id="${esc(n.n)}" `);

      let inner = n.c.map(node).join('');
      if (n.clip && inner) {
        const id = `clip${++clipId}`;
        defs.push(`<clipPath id="${id}">${rect(n, '#000', 0)}</clipPath>`);
        inner = `<g clip-path="url(#${id})">${inner}</g>`;
      }
      const bg = n.fill || n.stroke ? rect(n, n.fill, n.stroke, n.sc) : '';
      return `<g id="${esc(n.n)}">${bg}${inner}</g>`;
    }

    const body = node({ ...data.root, n: `Wireframe · ${data.title}` });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${f(data.width)}" height="${f(data.height)}" viewBox="0 0 ${f(data.width)} ${f(data.height)}">${
      defs.length ? `<defs>${defs.join('')}</defs>` : ''}${body}</svg>`;
  }

  /* ------------------------------------------------------------------ *
   * Export actions
   * ------------------------------------------------------------------ */

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  function download(text, type, ext) {
    const slug = (location.hostname.replace(/^www\./, '') || 'page').replace(/[^a-z0-9.-]+/gi, '-');
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wireframe-${slug}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function runExport(kind) {
    ui.toast('Collecting structure…', true);
    await new Promise((r) => setTimeout(r, 30)); // let the toast paint first
    let data;
    try {
      data = buildTree(selected);
    } catch (err) {
      ui.toast(`Export failed: ${err.message}`);
      return;
    }
    const note = (data.truncated ? ' (truncated: very large page)' : '') + (data.scope ? ` · only ${data.scope}` : '');

    if (kind === 'copy-svg') {
      const ok = await copyText(toSVG(data));
      ui.toast(ok ? `Copied — paste into Figma with ⌘V / Ctrl+V${note}` : 'Copying is blocked on this page. Use Download SVG.');
    } else if (kind === 'svg') {
      download(toSVG(data), 'image/svg+xml', 'svg');
      ui.toast(`SVG downloaded — drag the file into Figma${note}`);
    } else if (kind === 'json') {
      download(JSON.stringify(data), 'application/json', 'json');
      ui.toast(`JSON downloaded — import it with the X-Ray Figma plugin${note}`);
    } else if (kind === 'claude' || kind === 'claude-open') {
      const ok = await copyText(toClaude(data));
      if (!ok) {
        ui.toast('Copying is blocked on this page.');
        return;
      }
      if (kind === 'claude-open') {
        const tab = window.open('https://claude.ai/new', '_blank', 'noopener');
        ui.toast(tab === null
          ? 'Copied — open claude.ai and paste with ⌘V / Ctrl+V (pop-up was blocked)'
          : `Copied — paste into Claude with ⌘V / Ctrl+V and ask your question${note}`);
      } else {
        ui.toast(`Copied — paste into Claude with ⌘V / Ctrl+V and ask your question${note}`);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Toolbar
   * ------------------------------------------------------------------ */

  // Build elements without innerHTML (Trusted Types / CSP safe).
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    el.append(...children.filter(Boolean));
    return el;
  }

  function svgIcon(paths, size = 16) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.4');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
    }
    return svg;
  }

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .bar {
      position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 2px; padding: 5px;
      background: #141518; color: #e8eaee; border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.07) inset;
      font: 500 13px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      pointer-events: auto; user-select: none; -webkit-font-smoothing: antialiased;
      max-width: calc(100vw - 32px);
    }
    button {
      all: unset; box-sizing: border-box; cursor: pointer; height: 32px; padding: 0 10px;
      border-radius: 8px; display: inline-flex; align-items: center; gap: 7px;
      color: #c4c8d0; white-space: nowrap; transition: background .15s, color .15s;
    }
    button:hover { background: rgba(255,255,255,.08); color: #fff; }
    button:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 1px; }
    .brand { color: #fff; font-weight: 650; letter-spacing: .01em; padding: 0 10px 0 8px; }
    .brand .mark { width: 18px; height: 18px; border-radius: 5px; background: ${ACCENT}; display: grid; place-items: center; color: #fff; }
    .sep { width: 1px; height: 20px; background: rgba(255,255,255,.12); margin: 0 4px; flex: none; }
    .sw { width: 22px; height: 13px; border-radius: 7px; background: #3a3d45; position: relative; flex: none; transition: background .15s; }
    .sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 9px; height: 9px; border-radius: 50%; background: #9da2ad; transition: transform .15s, background .15s; }
    .tg[aria-pressed="true"] { color: #fff; }
    .tg[aria-pressed="true"] .sw { background: ${ACCENT}; }
    .tg[aria-pressed="true"] .sw::after { transform: translateX(9px); background: #fff; }
    .primary { background: ${ACCENT}; color: #fff; padding: 0 12px; }
    .primary:hover { background: #5580ff; }
    .icon { width: 32px; padding: 0; justify-content: center; }
    .wrap { position: relative; }
    .menu {
      position: absolute; right: 0; bottom: calc(100% + 10px); width: 290px; padding: 6px;
      background: #141518; border-radius: 12px;
      box-shadow: 0 14px 40px rgba(0,0,0,.32), 0 0 0 1px rgba(255,255,255,.07) inset;
    }
    .menu[hidden] { display: none; }
    .menu button { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; width: 100%; height: auto; padding: 10px; color: #fff; }
    .menu small { font: 400 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: #8d929d; white-space: normal; }
    .scope { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 6px 6px 10px; }
    .scope div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .scope span { font: 600 11px/1 system-ui, -apple-system, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: #6f7480; }
    .scope b { color: #fff; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .menu .link { width: auto; height: 28px; padding: 0 10px; flex: none; color: #9fb6ff; background: rgba(59,108,255,.14); }
    .menu .link:hover { background: rgba(59,108,255,.24); color: #fff; }
    .group { padding: 8px 10px 2px; font: 600 11px/1 system-ui, -apple-system, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: #6f7480; }
    .menu hr { border: 0; height: 1px; background: rgba(255,255,255,.08); margin: 4px 6px; }
    .min .full { display: none; }
    .toast {
      position: fixed; left: 50%; bottom: 64px; transform: translate(-50%, 6px); opacity: 0;
      background: #141518; color: #fff; padding: 10px 14px; border-radius: 9px; max-width: calc(100vw - 32px);
      font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; text-align: center;
      box-shadow: 0 10px 30px rgba(0,0,0,.25); transition: opacity .2s, transform .2s; pointer-events: none;
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
    @media (max-width: 720px) { .tg .lbl-long { display: none; } }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  `;

  function buildUI() {
    uiHost = document.createElement(UI_TAG);
    uiHost.style.cssText =
      'all:initial;position:fixed;left:0;right:0;bottom:0;height:0;z-index:2147483647;pointer-events:none;';
    const shadow = uiHost.attachShadow({ mode: 'closed' });
    const s = new CSSStyleSheet();
    s.replaceSync(UI_CSS);
    shadow.adoptedStyleSheets = [s];

    const toggle = (key, label) =>
      h('button', { class: 'tg full', 'data-k': key, 'aria-pressed': 'false', onclick: () => setSetting(key, !settings[key]) },
        h('span', { class: 'sw' }), label);

    const scopeRow = h('div', { class: 'scope' });
    const menu = h('div', { class: 'menu', hidden: '', role: 'menu' },
      scopeRow,
      h('hr'),
      h('div', { class: 'group' }, 'Figma'),
      h('button', { role: 'menuitem', onclick: () => pick('copy-svg') },
        'Copy for Figma', h('small', {}, 'Paste with ⌘V / Ctrl+V. Layers are named Header, Navigation, H1 …')),
      h('button', { role: 'menuitem', onclick: () => pick('svg') },
        'Download SVG', h('small', {}, 'Drag the file into Figma.')),
      h('button', { role: 'menuitem', onclick: () => pick('json') },
        'Download JSON for the plugin', h('small', {}, 'Real frames and text layers via the X-Ray Figma plugin.')),
      h('hr'),
      h('div', { class: 'group' }, 'Claude'),
      h('button', { role: 'menuitem', onclick: () => pick('claude-open') },
        'Copy & open Claude', h('small', {}, 'Structure with layout and spacing as text; paste into a new chat.')),
      h('button', { role: 'menuitem', onclick: () => pick('claude') },
        'Copy for Claude', h('small', {}, 'Copy only, e.g. for Claude Code or an existing chat.')),
    );
    const menuBtn = h('button', { class: 'primary full', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => setMenu(menu.hidden) },
      svgIcon(['M8 2.5v7', 'M5 6.5l3 3 3-3', 'M3 11.5v1.5h10v-1.5']), 'Export');

    const minBtn = h('button', { class: 'icon full', title: 'Collapse', 'aria-label': 'Collapse toolbar', onclick: () => bar.classList.add('min') },
      svgIcon(['M4 8h8']));
    const closeBtn = h('button', { class: 'icon', title: 'Turn off wireframe (Alt+Shift+W)', 'aria-label': 'Turn off wireframe', onclick: () => {
      deactivate();
      chrome.runtime.sendMessage({ type: 'wfx-state', active: false }).catch(() => {});
    } }, svgIcon(['M4.5 4.5l7 7', 'M11.5 4.5l-7 7']));

    const brand = h('button', { class: 'brand', title: 'Wireframe X-Ray', onclick: () => bar.classList.remove('min') },
      h('span', { class: 'mark' }, svgIcon(['M3 3h10v10H3z', 'M3 6.5h10', 'M6.5 6.5V13'], 12)), 'X-Ray');

    const bar = h('div', { class: 'bar', role: 'toolbar', 'aria-label': 'Wireframe X-Ray' },
      brand,
      h('div', { class: 'sep full' }),
      toggle('outlines', 'Outlines'),
      toggle('labels', 'Labels'),
      toggle('fills', h('span', {}, 'Fills')),
      toggle('inspect', 'Inspect'),
      h('div', { class: 'sep full' }),
      h('div', { class: 'wrap full' }, menuBtn, menu),
      minBtn,
      closeBtn,
    );
    const toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    shadow.append(bar, toastEl);

    function renderScope() {
      const sel = selected?.isConnected ? selected : null;
      const action = (label, fn) => h('button', { class: 'link', onclick: fn }, label);
      scopeRow.replaceChildren(
        h('div', {}, h('span', {}, 'Scope'), h('b', {}, sel ? nameOf(sel) : 'Whole page')),
        sel
          ? action('Whole page', () => { selected = null; queueInspect(); renderScope(); })
          : action('Choose section', () => {
            setMenu(false);
            if (!settings.inspect) setSetting('inspect', true);
            ui.toast('Click the section you want to export · ↑ selects the parent element');
          }),
      );
    }
    function setMenu(open) {
      if (open) {
        renderScope();
        toastEl.classList.remove('show');
      }
      menu.hidden = !open;
      menuBtn.setAttribute('aria-expanded', String(open));
    }
    function pick(kind) {
      setMenu(false);
      runExport(kind);
    }
    const host = uiHost;
    const outside = (e) => {
      if (!host.isConnected) return removeEventListener('pointerdown', outside, true);
      if (!menu.hidden && !e.composedPath().includes(host)) setMenu(false);
    };
    addEventListener('pointerdown', outside, true);
    shadow.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setMenu(false);
    });

    let toastTimer;
    ui = {
      sync() {
        for (const b of bar.querySelectorAll('.tg')) b.setAttribute('aria-pressed', String(!!settings[b.dataset.k]));
      },
      toast(msg, sticky = false) {
        toastEl.textContent = msg;
        toastEl.classList.add('show');
        clearTimeout(toastTimer);
        if (!sticky) toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3800);
      },
    };
    ui.sync();
    document.documentElement.appendChild(uiHost);
  }

  /* ------------------------------------------------------------------ *
   * Public API for background.js
   * ------------------------------------------------------------------ */

  window.__wfx = {
    async toggle(force) {
      await ready;
      const next = force ?? !active;
      if (next) activate();
      else deactivate();
      return active;
    },
    // Export data without downloading, handy for debugging from the console.
    structure(scope = selected) {
      const data = buildTree(scope);
      return { data, svg: toSVG(data), claude: toClaude(data) };
    },
  };
})();
