# readm3

A terminal markdown reader and editor. File browser on the left, the rendered
document on the right, and nothing else in the way. Press `e` to edit the file
you are looking at, `esc` to see it rendered again.

CommonMark and GitHub Flavored Markdown, plus the extras each dialect added on
top: GitHub alerts, footnotes and `:emoji:`, and Reddit spoilers, superscript
and `r/` `u/` links.

Built on [HQTUI](https://github.com/profullstack/hqtui) — truecolor, mouse, and
a terminal that gets restored no matter how the process dies.

```
╭─  readm3  ──────────── 6 ─╮╭─  README.md  ────────────────────────────────────── 24% ─╮
│ ▾ docs                    ││ readm3                                                   │
│     usage.md              ││ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│   README.md               ││                                                          │
│   CHANGELOG.md            ││ A terminal markdown reader. File browser on the left, the │
│                           ││ rendered document on the right.                          │
│                           ││                                                          │
│                           ││ Install                                                  │
│                           ││ ─────────                                                │
│                           ││                                                          │
│                           ││ ┌─ bash ────────────────────────────────────────────────  │
│                           ││ │ bun add -g @profullstack/readm3                        │
│                           ││ └────────────────────────────────────────────────────────  │
╰───────────────────────────╯╰──────────────────────────────────────────────────────────╯
 ↑↓ move  ↵ open  ←→ fold  / find  tab reader  ? keys  q quit              docs  dark
```

## Install

```bash
bun add -g @profullstack/readm3     # Bun is the default runtime
npm  install -g @profullstack/readm3 # Node 22.6+ works too
```

Or run it without installing:

```bash
bunx @profullstack/readm3
npx  @profullstack/readm3
```

## Use

```bash
readm3                  # browse markdown under the current directory
readm3 ./docs           # browse a directory
readm3 CHANGELOG.md     # open a file, browse its directory
readm3 --theme nord     # pick a palette
```

### Printing

`--print` renders straight to stdout and exits, so it works in a pipe and as a
`cat` for markdown:

```bash
readm3 --print CHANGELOG.md          # rendered, colored, to the terminal
readm3 --print README.md | less -R   # into a pager
curl -s https://example.com/x.md | readm3 --print
readm3 --print notes.md | grep TODO  # no escapes when stdout is a pipe
```

Color follows the usual rules: on when stdout is a terminal, off when it is not,
and `NO_COLOR` / `FORCE_COLOR` are honored. `--color always|never|auto` overrides
that either way. With `--print`, `--width` sets the render width rather than the
sidebar.

The browser only shows markdown. Directories with nothing beneath them are
pruned, `node_modules` and friends are never walked, and README sorts first.

## Keys

| | | | |
|---|---|---|---|
| `↑` `↓` `j` `k` | move or scroll | `tab` | switch pane |
| `→` `←` `l` `h` | expand or collapse | `/` | filter files |
| `enter` | open the file | `esc` | clear the filter |
| `space` `b` | page down / up | `r` | rescan and reload |
| `g` `G` | top / bottom | `[` `]` | sidebar width |
| `e` `i` | edit this file | `s` | reveal spoilers |
| `ctrl+s` | save | `?` | help |
| | | `q` `ctrl+c` | quit |

The mouse works too: the wheel scrolls whichever pane it is over, and a click
opens a file.

### Editing

`e` puts the caret in the file. `esc` takes it out, and the preview re-renders
what you just typed — there is no separate preview pane to keep in step,
because both modes read the same buffer.

| | | | |
|---|---|---|---|
| `esc` | back to the preview | `ctrl+s` | save |
| `ctrl+z` `ctrl+y` | undo / redo | `ctrl+g` | keys |
| `ctrl+a` `ctrl+e` | line start / end | `ctrl+k` | kill to end of line |
| `ctrl+←` `ctrl+→` | move by word | `ctrl+u` | kill to start of line |
| `ctrl+home` `ctrl+end` | top / bottom | `tab` | indent two spaces |

`enter` continues the list you are in — the same bullet, the next number, an
unchecked box for a task — and ends it when you press it on an empty item.
Quitting or switching files with unsaved changes asks first. `--read-only`
turns editing off entirely, for use as a pager.

There is no selection, and so no cut and paste: this is a place to fix a typo
and add a paragraph, not a replacement for your editor. `$EDITOR` is still
`$EDITOR`.

## What it renders

Parsing is [marked](https://github.com/markedjs/marked) — CommonMark and GFM,
zero dependencies of its own — so readm3 has two dependencies in total.

Headings, **bold**, *italic*, `inline code`, links, reference links, bare URLs,
fenced and indented code blocks with a language label, ordered and unordered
lists, nested lists, task lists, blockquotes, tables with per-column alignment,
strikethrough, hard line breaks, horizontal rules, images as labelled
placeholders, and YAML front matter — shown rather than hidden, because it is
usually what you opened the file for.

The HTML that real READMEs are full of is folded back into markdown rather than
printed as tags, and code is held out of that, so `Array<string>` survives.

### Flavors

`--flavor` picks which dialect's extras are honored. The default is `github`.

| flavor | adds |
|---|---|
| `commonmark` | nothing beyond CommonMark |
| `github` | GFM, alerts (`> [!WARNING]`), footnotes (`[^1]`), `:emoji:` |
| `reddit` | GFM, spoilers (`>!hidden!<`), superscript (`^(text)`), `r/` and `u/` links |
| `all` | both dialects at once |

It matters which one you pick. `2^32` is a number in a README and a superscript
on Reddit, and `>!spoiler!<` is a blockquote everywhere except Reddit — so the
flavor decides, rather than every document getting every rule.

Alerts get a gutter colored by severity. Footnotes are numbered in order of
first reference and collected under a rule at the foot of the document.
Superscript uses real Unicode glyphs when every character has one (`mc^2`
becomes mc²) and keeps its caret when they do not, because there is no
superscript `q`. Spoilers are blocked out with `█` rather than colored out, so
they stay hidden in a pipe and with `--color never`; `s` reveals them in the
reader, `--spoilers` in `--print`.

## Options

```
-p, --print          render to stdout and exit; reads stdin when given no path
                     or "-"
    --color <when>   always, never, or auto (default)
-t, --theme <name>   dark, dracula, nord, tokyo-night, gruvbox, matrix,
                     monochrome, high-contrast, light
-w, --width <n>      sidebar width in columns, or the render width with --print
                     (default: 28% of the terminal, its full width printing)
-f, --flavor <name>  commonmark, github (default), reddit, or all
    --spoilers       reveal spoiler text instead of blocking it out
-R, --read-only      refuse to edit, for use as a pager
-a, --all            include dot-directories and dotfiles
-M, --no-mouse       disable mouse tracking
-v, --version
-h, --help
```

## As a library

The renderer, the file tree and the edit buffer are pure and need no terminal,
so they can be reused on their own:

```ts
import { renderMarkdown, toText, renderAnsi, scan, files } from "@profullstack/readm3";

const lines = renderMarkdown("# Hello\n\nSome **text**.", 60);
console.log(toText(lines));
// [ 'Hello', '━━━…', '', 'Some text.' ]

// A flavor, and spoilers revealed.
renderMarkdown(post, 60, { flavor: "reddit", spoilers: true });

for (const file of files(scan("./docs"))) console.log(file.path);
```

The edit buffer is a plain object with functions over it, so the editing rules
can be tested without a screen:

```ts
import { createEditor, insert, newline, undo, text } from "@profullstack/readm3";

const ed = createEditor("- first");
ed.col = 7;
newline(ed);          // continues the list
insert(ed, "second");
console.log(text(ed)); // "- first\n- second"
undo(ed);
```

`renderMarkdown` returns lines of spans carrying a semantic `role` — `h1`,
`code`, `link`, `quote` and so on — rather than colors, so the same document can
be re-themed without re-parsing. `renderAnsi(source, width, theme, depth)` is
what `--print` uses to turn those spans into an escaped string.

## Runtimes

Bun is the default. Node 22.6+ runs the same code. Tested on Linux, macOS and
Windows Terminal.

## Develop

```bash
bun install
bun src/cli.ts .     # run it against its own repo
bun test test/       # 68 tests, no TTY needed
npm test             # the same tests on node
bun run typecheck
bun run build
```

## The website

[readm3.com](https://readm3.com) is built from this repository by `site/build.ts`,
which renders every document on the page through `renderMarkdown` and takes every
color from a real HQTUI theme. There is no second implementation to keep in sync:
change the parser and the site changes with it.

```bash
bun run site:build   # writes site/dist
bun run site:start   # serves it on $PORT, default 3000
```

## License

MIT.
