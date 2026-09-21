# Your docs. Your space.

The same quiet Markdown reader you know from the terminal,
now in a browser. Pick a file on the left. Make yourself at home.

## Start with something of your own

- **Open folder** to browse a directory of Markdown.
- **Open files** to read a few documents, or drag them into this window.
- **Open URL** for a raw Markdown URL or a GitHub file link. A link does the same: `/viewer?url=https://host/doc.md`.
- **New note** to start with a blank page.
- **Share** while signed out to get a private link for a file. No account needed.

Only Markdown files appear in the explorer. Build output, dependencies,
and hidden directories stay out of the way. README files sort first.

## A little less reaching for the mouse

| Key | Action |
| :--- | :--- |
| / | Find a file |
| ↑ ↓ or j k | Move through files or scroll |
| Enter | Open a file |
| e | Edit this document |
| Escape | Return to reading |
| Ctrl / ⌘ S | Download your Markdown |
| ? | See all shortcuts |

## Read. Edit. Keep going.

Switch to **Edit**, change a line, then press **Escape**. The preview
reads the same buffer, just like the terminal app.

> [!TIP]
> Your workspace and edits are saved on this device. Install readm3
> from your browser to keep a dedicated reading window, even offline.

Use **Download** to keep a copy outside the browser. Your original files
on disk are never overwritten. Clearing browser site data removes
saved documents and edits.

## One parse, nine palettes

Choose a theme above. Every color comes from the terminal app;
every document goes through the same renderer. Try **nord** for a
quieter palette, or **light** for a brighter page.

```typescript
import { renderMarkdown } from "@profullstack/readm3";

const lines = renderMarkdown("# Hello, browser.", 80);
```

---

No account. No uploads. Just you and your Markdown.
