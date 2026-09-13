# readm3

Markdown editing and sharing for people and teams, with a terminal reader and editor. File browser on the left, the rendered
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

Parsing is [marked](https://github.com/markedjs/marked) — CommonMark and GFM.
The terminal UI uses HQTUI; the cloud tools use the official MCP SDK.

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
bun test ./test       # 68 tests, no TTY needed
npm test             # the same tests on node
bun run typecheck
bun run build
```

## Shared documents, organizations, and teams

Read and edit online at https://readm3.com/viewer, and manage your account at
https://readm3.com/admin. Create private Markdown files, share view or edit links,
add named collaborators, and grant access to an organization or team. Every link
opens in read mode. File owners manage permissions and deletion; editors save new
versions; the super administrator can manage every user's documents.

Every online save creates an immutable version with a short ID and SHA-256 checksum.
Stale saves are rejected so concurrent edits cannot silently overwrite each other.
Owners can restore prior versions, pin links to a version, and revoke links.

```sh
readm3 login --token-stdin             # token from /admin → API tokens
readm3 orgs list
readm3 share README.md --org ORG_ID    # view link by default
readm3 docs update DOC_ID notes.md --base VERSION_ID
readm3 docs history DOC_ID
readm3 mcp                            # stdio MCP, same account permissions
```

The REST API is at `/api/v1`, with all operations also available through
`POST /api/v1/actions` and `readm3 cloud OPERATION --args JSON`.
Full permissions, recovery, CLI, API, and MCP documentation: https://readm3.com/sharing.

## Web reader

Open https://readm3.com/viewer for the same two-pane Markdown reader in your browser.
Open local files or a folder, drop Markdown files into the window, open a raw URL or
GitHub file link, or start a new note. The explorer filters files, prunes hidden and
build directories, and sorts README first. All nine themes and Markdown flavors use
the same renderer as the terminal.

Press `/` to filter, `e` to edit, `Escape` to return to reading, and `?` for shortcuts.
`Ctrl+S` / `⌘S` downloads the current Markdown. Files and edits are saved in IndexedDB
on this device; originals on disk are never overwritten. Reopening a file adds a copy
so an existing draft is preserved. Clearing browser site data removes the workspace.

Install through your browser’s app menu, or Share → Add to Home Screen on iOS.
After the first visit, the application and saved workspace work offline. Remote URLs
need a connection and a host that permits browser access (CORS); files are fetched
directly with no credentials or server proxy. Local files are uploaded only when you explicitly choose Share → Save online.

Imports are limited to 4 MB per file, 20 MB per workspace, and 1,000 files.

## The website

[readm3.com](https://readm3.com) is built from this repository by `site/build.ts`,
which renders every document on the page through `renderMarkdown` and takes every
color from a real HQTUI theme. There is no second implementation to keep in sync:
change the parser and the site changes with it.

```bash
bun run site:build   # writes site/dist
bun run site:start   # serves it on $PORT, default 3000
bun x playwright install chromium  # once, for browser checks
bun run test:site    # imports, editing, persistence, offline PWA, and mobile layout
```

The site build bundles `site/viewer.ts` for browsers, generates content-addressed
assets, and precaches the viewer shell through a service worker scoped to `/viewer`.
Updates wait until the reader chooses **Update available**; drafts are saved before
reloading. The web viewer does not load the marketing site’s third-party scripts.

## Hosting shared documents

The web server uses Bun and SQLite. Set `READM3_DB` to a database file on persistent
storage, and `READM3_URL` to the public HTTPS origin. The Docker image uses
`/data/readm3.sqlite`; mount a volume at `/data`. On Railway set `RAILWAY_RUN_UID=0`
for access to the mounted volume. Configure volume backups in the hosting platform.

For separate frontend and storage services, set `READM3_API_UPSTREAM` on the
frontend to the storage service's HTTPS origin, and set the same random
`READM3_PROXY_SECRET` on both services. The frontend forwards `/api/v1/*` without
opening a local database. Keep `READM3_URL` on the storage service set to the public
frontend origin so cookies and sharing links use the right host. The storage
service needs a persistent `/data` volume and a single replica.

Set `READM3_ADMIN_BOOTSTRAP_SECRET` to a random secret, then open
`/admin#claim=YOUR_SECRET` and sign in as the intended super administrator. This is a
one-time claim stored in the database. Never publish this URL; remove the environment
secret after claiming. Registration never grants administrator access by itself.

Passwords use Argon2id, sessions are HttpOnly cookies, and API tokens and share
capabilities are stored as SHA-256 hashes. Shared documents are not cached in the
PWA or saved in the browser's local workspace, so revocation applies to future access.

```sh
bun run test:server  # auth, roles, version history, persistence, CLI and MCP
bun run test:site    # local/offline reader plus browser sharing and admin workflows
```

## License

MIT.
