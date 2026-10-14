# Wireframe X-Ray

Chrome-extensie die iedere website met één klik omzet in een wireframe. Kleuren, afbeeldingen, schaduwen en decoratie verdwijnen; je houdt de structuur, de hiërarchie en de layout over. De structuur kun je daarna naar Figma exporteren.

## Installeren (Chrome / Edge / Arc / Brave)

1. Ga naar `chrome://extensions`
2. Zet **Ontwikkelaarsmodus** aan (rechtsboven)
3. Klik op **Uitgepakte extensie laden** en kies deze map (`wireframe-xray`)
4. Zet het icoon vast in de werkbalk

## Gebruik

- **Klik op het icoon** of druk **Alt+Shift+W**: wireframe aan of uit
- Onderaan de pagina verschijnt een toolbar:
  - **Outlines**: stippellijnen rond elk blok-element
  - **Labels**: badges voor Header, Navigation, Main, Section, Footer, Form, H1–H6
  - **Vlakken**: donkere en lichte secties houden een grijswaarde; uit = alles wit
  - **Inspect**: meet spacing en layout (zie hieronder)
  - **Export**: naar Figma of Claude, voor de hele pagina of één sectie (zie hieronder)
  - **–** klapt de toolbar in, **✕** zet de wireframe uit
- Instellingen worden onthouden.

Wat er gebeurt:
| Origineel | Wireframe |
|---|---|
| Achtergrondkleur | Wit / lichtgrijs / grijs, afhankelijk van hoe donker het was |
| Achtergrondafbeelding | Gearceerd vlak |
| `img`, `video`, grote `svg` | Grijs vlak met een kruis |
| Kleine iconen (≤ 40px) | Grijs blokje |
| `iframe`, `canvas`, embeds | Egaal grijs vlak |
| Tekst, randen | Donkergrijs, één neutrale lijnkleur |
| Schaduwen, filters, gradients | Weg |

Nieuwe content (lazy loading, SPA's) wordt automatisch meegenomen. Open shadow DOM wordt ook omgezet.

## Inspect: marges, padding, grid en afstanden

Zet **Inspect** aan in de toolbar en hover over de pagina:

- **Box model**: margin (oranje), padding (groen) en content (blauw) met de pixelwaarde per zijde
- **Info-kaartje**: maat, layout (block / flex / grid), kolommen, gap, uitlijning, padding, margin, border, radius, max-width en font
- **Grid**: kolommen en rijen worden getekend met hun breedte; gaps zijn rood gearceerd
- **Ruimte tussen elementen**: de afstand tussen de kinderen van een container (bijv. tussen twee secties) wordt rood gearceerd met de waarde. Ook de afstand tot het element erboven en eronder wordt gemeten
- **Meten zoals in Figma**: klik een element om het vast te zetten en hover over een ander element om de afstand tussen die twee te zien. Klik nogmaals of druk **Esc** om los te laten
- **Selectie verfijnen**: met **↑** selecteer je het ouder-element (bijv. van een kop naar de hele sectie), met **↓** het eerste kind

Tijdens Inspect doen klikken op de pagina niets (links worden niet gevolgd).

## Eén sectie exporteren

Standaard exporteer je de hele pagina. Wil je alleen één sectie:

1. Open **Export** en klik op **Kies sectie** (dit zet Inspect aan)
2. Klik op de sectie; gebruik **↑** tot de hele sectie blauw omlijnd is
3. Open **Export** opnieuw: bij *Bereik* staat nu de sectie. Alle exports (Figma én Claude) gaan dan alleen over die sectie
4. **Hele pagina** in het menu (of Esc) zet het bereik terug

## Exporteren naar Claude

- **Kopieer & open Claude**: kopieert de structuur en opent een nieuwe chat op claude.ai. Plak met ⌘V / Ctrl+V en stel je vraag (bijv. "bouw deze sectie na in HTML/Tailwind" of "beoordeel de spacing")
- **Kopieer voor Claude**: alleen kopiëren, handig voor Claude Code of een bestaande chat

De export is een leesbare outline met per element de afmeting, layout (flex/grid, kolommen, gap, uitlijning), padding, margin, max-width, vlak, radius, de tekst met fontgrootte/gewicht en de verticale ruimte tot het vorige element (`↑48`). Voorbeeld:

```
- Main [1280×441.9]
  - div.grid [1280×441.9] · grid 3 kol (384 384 384) gap 24 · pad 40
    - div.card [384×361.9] · wit vlak · radius 16
      - Image · Schoen [384×180]
      - div [384×181.9] · pad 16
        - H3 [352×21] · margin 19 0 · "Sneaker Pro" 18.7px/700
        - ↑18.7 Paragraph [352×36] · margin 16 0 · "Lichtgewicht loopschoen…" 16px/400
```

Zeer grote pagina's worden na ±60.000 tekens ingekort; exporteer dan per sectie.

## Exporteren naar Figma

**Snelste route: Kopieer voor Figma**
Kies *Export naar Figma → Kopieer voor Figma* en plak in Figma met ⌘V / Ctrl+V. Je krijgt vectorlagen met namen als `Header`, `Navigation`, `H1 · Titel`, `Button · Shop nu`, `Image · alt-tekst`.

**Download SVG**: hetzelfde, maar als bestand dat je in Figma sleept.

**Download JSON + plugin: echte frames**
Wil je bewerkbare frames met tekstlagen in plaats van SVG-groepen, gebruik dan de meegeleverde Figma-plugin:

1. Figma desktop → *Plugins → Development → Import plugin from manifest…*
2. Kies `figma-plugin/manifest.json`
3. In de extensie: *Export naar Figma → Download JSON voor de plugin*
4. Start *Wireframe X-Ray Import* in Figma en kies of sleep het JSON-bestand

De plugin bouwt geneste frames (met vlakken, randen, radius en clipping), tekstlagen in Inter met het juiste gewicht en afbeeldingen als placeholder met kruis.

## Beperkingen

- Werkt niet op `chrome://`-pagina's en de Chrome Web Store (badge toont dan `!`).
- Inhoud van iframes wordt niet omgezet, alleen als grijs vlak getoond.
- In de export wordt de tekst in Inter gezet; omdat Inter anders loopt dan het originele font kan tekst iets breder of smaller uitvallen.
- Zeer grote pagina's worden na 8000 lagen ingekort.
- Emoji's blijven in kleur (het zijn tekens in een kleurenfont).

## Bestanden

```
manifest.json      MV3-manifest
background.js      Klik / sneltoets → wireframe aan/uit, badge
content.js         Wireframe-modus, toolbar, labels, structuur-export (SVG/JSON)
icons/             Extensie-iconen
figma-plugin/      Figma-plugin die de JSON-export omzet naar frames
```
