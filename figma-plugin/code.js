// Wireframe X-Ray Import — turns a JSON export from the extension into nested Figma frames.

figma.showUI(__html__, { width: 340, height: 330, themeColors: true });

const INK = '#262626';
const LINE = '#BDBDBD';
const MEDIA_LINE = '#B4B4B4';

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
const paint = (hex) => [{ type: 'SOLID', color: rgb(hex) }];

function fontFor(weight, italic) {
  const style = weight >= 700 ? 'Bold' : weight >= 600 ? 'Semi Bold' : weight >= 500 ? 'Medium' : 'Regular';
  if (!italic) return { family: 'Inter', style };
  return { family: 'Inter', style: style === 'Regular' ? 'Italic' : `${style} Italic` };
}

const fontKey = (f) => `${f.family}|${f.style}`;
const loadedFonts = new Map();

async function loadFonts(root) {
  const wanted = new Map();
  (function walk(n) {
    if (n.t === 'text') {
      const f = fontFor(n.fw, n.it);
      wanted.set(fontKey(f), f);
    }
    (n.c || []).forEach(walk);
  })(root);

  const regular = { family: 'Inter', style: 'Regular' };
  await figma.loadFontAsync(regular);
  await Promise.all([...wanted].map(async ([key, f]) => {
    try {
      await figma.loadFontAsync(f);
      loadedFonts.set(key, f);
    } catch (e) {
      loadedFonts.set(key, regular);
    }
  }));
}

const ALIGN = { center: 'CENTER', right: 'RIGHT', end: 'RIGHT', justify: 'JUSTIFIED' };
let created = 0;

function box(d, parent, ox, oy) {
  const f = figma.createFrame();
  f.resize(Math.max(d.w, 0.01), Math.max(d.h, 0.01));
  f.x = d.x - ox;
  f.y = d.y - oy;
  f.clipsContent = false;
  f.fills = [];
  parent.appendChild(f);
  return f;
}

function build(d, parent, ox, oy) {
  created++;

  if (d.t === 'text') {
    const t = figma.createText();
    t.fontName = loadedFonts.get(fontKey(fontFor(d.fw, d.it)));
    t.characters = d.text;
    t.fontSize = Math.max(1, d.fs);
    t.lineHeight = { unit: 'PIXELS', value: Math.max(1, d.lh) };
    t.fills = paint(d.ph ? '#9A9A9A' : INK);
    if (d.u) t.textDecoration = 'UNDERLINE';
    t.textAlignHorizontal = ALIGN[d.ta] || 'LEFT';
    t.name = d.n;
    parent.appendChild(t);
    if ((d.lines || []).length > 1) {
      // Fixed width: Figma wraps the lines itself, just like the browser.
      t.resize(Math.max(1, d.w + 2), Math.max(1, d.h));
      t.textAutoResize = 'HEIGHT';
    } else {
      t.textAutoResize = 'WIDTH_AND_HEIGHT';
    }
    t.x = d.x - ox;
    t.y = d.y - oy;
    return;
  }

  const f = box(d, parent, ox, oy);
  f.name = d.n;
  if (d.r) f.cornerRadius = d.r;

  if (d.t === 'img' || d.t === 'embed' || d.t === 'icon') {
    f.fills = paint(d.t === 'icon' ? '#CDCDCD' : d.t === 'embed' ? '#E6E6E6' : '#ECECEC');
    if (d.t === 'icon') {
      f.cornerRadius = Math.min(3, d.w / 2, d.h / 2);
      return;
    }
    f.strokes = paint(MEDIA_LINE);
    f.strokeWeight = 1;
    f.strokeAlign = 'INSIDE';
    if (d.t === 'img') {
      const v = figma.createVector();
      v.name = 'Cross';
      v.vectorPaths = [{ windingRule: 'NONE', data: `M 0 0 L ${d.w} ${d.h} M ${d.w} 0 L 0 ${d.h}` }];
      v.strokes = paint(MEDIA_LINE);
      v.strokeWeight = 1;
      v.fills = [];
      f.appendChild(v);
      v.x = 0;
      v.y = 0;
      f.clipsContent = true;
    }
    return;
  }

  if (d.fill) f.fills = paint(d.fill);
  if (d.stroke) {
    f.strokes = paint(d.sc || LINE);
    f.strokeWeight = d.stroke;
    f.strokeAlign = 'INSIDE';
  }
  f.clipsContent = !!d.clip;
  for (const c of d.c || []) build(c, f, d.x, d.y);
}

figma.ui.onmessage = async (msg) => {
  if (msg.type !== 'import') return;
  try {
    const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
    if (!data || data.format !== 'wireframe-xray' || !data.root) {
      throw new Error('This is not a Wireframe X-Ray export.');
    }
    await loadFonts(data.root);
    created = 0;

    const root = figma.createFrame();
    root.name = `Wireframe · ${data.title}`;
    root.resize(Math.max(1, data.width), Math.max(1, data.height));
    root.fills = paint('#FFFFFF');
    root.clipsContent = true;
    figma.currentPage.appendChild(root);
    const c = figma.viewport.center;
    root.x = Math.round(c.x - data.width / 2);
    root.y = Math.round(c.y - Math.min(data.height, 900) / 2);

    for (const child of data.root.c || []) build(child, root, 0, 0);

    if (data.url) root.setPluginData('source', data.url);
    figma.currentPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);
    figma.ui.postMessage({ type: 'done', count: created });
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: e.message || String(e) });
  }
};
