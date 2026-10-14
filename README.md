# Wireframe X-Ray

Chrome extension that turns any website into a wireframe with one click. Colors, images, shadows and decoration disappear; you're left with the structure, hierarchy and layout. You can then export that structure to Figma.

## Installation (Chrome / Edge / Arc / Brave)

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder (`wireframe-xray`)
4. Pin the icon to the toolbar

## Usage

- **Click the icon** or press **Alt+Shift+W**: toggle the wireframe on or off
- A toolbar appears at the bottom of the page:
  - **Outlines**: dotted lines around every block element
  - **Labels**: badges for Header, Navigation, Main, Section, Footer, Form, H1–H6
  - **Fills**: dark and light sections keep a gray tone; off = everything white
  - **Inspect**: measure spacing and layout (see below)
  - **Export**: to Figma or Claude, for the whole page or a single section (see below)
  - **–** collapses the toolbar, **✕** turns the wireframe off
- Settings are remembered.

What happens:
| Original | Wireframe |
|---|---|
| Background color | White / light gray / gray, depending on how dark it was |
| Background image | Hatched area |
| `img`, `video`, large `svg` | Gray area with a cross |
| Small icons (≤ 40px) | Gray block |
| `iframe`, `canvas`, embeds | Solid gray area |
| Text, borders | Dark gray, one neutral line color |
| Shadows, filters, gradients | Removed |

New content (lazy loading, SPAs) is picked up automatically. Open shadow DOM is converted too.

## Inspect: margins, padding, grid and spacing

Turn on **Inspect** in the toolbar and hover over the page:

- **Box model**: margin (orange), padding (green) and content (blue) with the pixel value per side
- **Info card**: size, layout (block / flex / grid), columns, gap, alignment, padding, margin, border, radius, max-width and font
- **Grid**: columns and rows are drawn with their width; gaps are hatched in red
- **Space between elements**: the distance between a container's children (e.g. between two sections) is hatched in red with its value. The distance to the element above and below is measured as well
- **Measure like in Figma**: click an element to lock it, then hover over another element to see the distance between the two. Click again or press **Esc** to release
- **Refine the selection**: **↑** selects the parent element (e.g. from a heading to the whole section), **↓** selects the first child

While Inspect is on, clicking the page does nothing (links are not followed).

## Exporting a single section

By default you export the whole page. To export just one section:

1. Open **Export** and click **Choose section** (this turns on Inspect)
2. Click the section; press **↑** until the whole section has a blue outline
3. Open **Export** again: *Scope* now shows the section. All exports (Figma and Claude) then cover only that section
4. **Whole page** in the menu (or Esc) resets the scope

## Exporting to Claude

- **Copy & open Claude**: copies the structure and opens a new chat on claude.ai. Paste with ⌘V / Ctrl+V and ask your question (e.g. "rebuild this section in HTML/Tailwind" or "review the spacing")
- **Copy for Claude**: copy only, handy for Claude Code or an existing chat

The export is a readable outline listing, per element, its size, layout (flex/grid, columns, gap, alignment), padding, margin, max-width, fill, radius, the text with font size/weight and the vertical space to the previous element (`↑48`). Example:

```
- Main [1280×441.9]
  - div.grid [1280×441.9] · grid 3 col (384 384 384) gap 24 · pad 40
    - div.card [384×361.9] · white fill · radius 16
      - Image · Shoe [384×180]
      - div [384×181.9] · pad 16
        - H3 [352×21] · margin 19 0 · "Sneaker Pro" 18.7px/700
        - ↑18.7 Paragraph [352×36] · margin 16 0 · "Lightweight running shoe…" 16px/400
```

Very large pages are truncated after ±60,000 characters; in that case, export per section.

## Exporting to Figma

**Fastest route: Copy for Figma**
Choose *Export to Figma → Copy for Figma* and paste into Figma with ⌘V / Ctrl+V. You get vector layers with names like `Header`, `Navigation`, `H1 · Title`, `Button · Shop now`, `Image · alt text`.

**Download SVG**: the same, but as a file you drag into Figma.

**Download JSON + plugin: real frames**
If you want editable frames with text layers instead of SVG groups, use the included Figma plugin:

1. Figma desktop → *Plugins → Development → Import plugin from manifest…*
2. Select `figma-plugin/manifest.json`
3. In the extension: *Export to Figma → Download JSON for the plugin*
4. Run *Wireframe X-Ray Import* in Figma and choose or drag in the JSON file

The plugin builds nested frames (with fills, borders, radius and clipping), text layers in Inter with the correct weight, and images as placeholders with a cross.

## Limitations

- Doesn't work on `chrome://` pages or the Chrome Web Store (the badge then shows `!`).
- iframe content is not converted, only shown as a gray area.
- Text in the export is set in Inter; because Inter runs differently from the original font, text may come out slightly wider or narrower.
- Very large pages are truncated after 8,000 layers.
- Emoji stay in color (they are characters in a color font).

## Files

```
manifest.json      MV3 manifest
background.js      Click / shortcut → toggle wireframe, badge
content.js         Wireframe mode, toolbar, labels, structure export (SVG/JSON)
icons/             Extension icons
figma-plugin/      Figma plugin that converts the JSON export into frames
```
