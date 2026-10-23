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

One line. It installs under `~/.local` and never asks for sudo; with no Node 22+
on the machine it fetches a private official Node first:

```sh
curl -fsSL https://readm3.com/install.sh | sh
```

Update with `readm3 update` and remove with `readm3 uninstall`; both work the way readm3
was installed (this installer, npm, bun, pnpm or yarn), through
[@profullstack/cli](https://github.com/profullstack/cli).
Add `--desktop` to install the desktop editor as well (Linux x64; macOS and Windows
download it, see
[Desktop app](#desktop-app)):

```sh
curl -fsSL https://readm3.com/install.sh | sh -s -- --desktop
```

Or with a package manager:

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
readm3 login                           # approve in the browser; over SSH, paste the code it shows
readm3 login --token-stdin             # or a token from /admin → API tokens
readm3 whoami                          # the account, and its linked CoinPay account
readm3 orgs list
readm3 share README.md --org ORG_ID    # view link by default; without --org, your personal workspace
readm3 docs update DOC_ID notes.md --base VERSION_ID
readm3 docs history DOC_ID
readm3 mcp                            # stdio MCP, same account permissions
```

The REST API is at `/api/v1`, with all operations also available through
`POST /api/v1/actions` and `readm3 cloud OPERATION --args JSON`.
Full permissions, accounts, CLI, API, and MCP documentation: https://readm3.com/sharing.

### Private links without an account

```sh
readm3 paste notes.md                  # prints https://readm3.com/p/<token>
readm3 paste config.json               # any file: JSON, code, YAML, SQL, a diff…
cat notes.md | readm3 paste --expires 1d --title "Standup"
kubectl get pods -o yaml | readm3 paste    # no name needed, the content is sniffed
readm3 paste get URL --raw
readm3 paste delete URL
curl https://readm3.com/p/<token>/raw  # the text itself
```

A paste is a file behind a secret link. No sign-in, no account: anyone with the link
can read it, nobody can list or search for it, and only the hash of the secret is
stored, so the link cannot be shown again. The front door is https://readm3.com/paste:
paste text or drop a file, pick an expiry, get the link, and open any paste by its
link; the page also carries the CLI, curl, API and MCP examples. In the web reader the
**Paste link** button does the same for the open file, signed in or not. Pastes expire after seven days by default (1h, 1d, 7d or
30d), are limited to 256 KB, and can be deleted by anyone holding the link.

A paste can be any text, not only Markdown. Markdown renders as a document. Anything
else (JSON, JavaScript, TypeScript, Python, shell, YAML, HTML, CSS, SQL, Go, Rust,
Java, C, Dockerfiles, diffs and some thirty languages in all) is shown with syntax
colors in the reader's theme, line numbers, and folding: click the arrow beside a
line, or Fold all, to collapse a block to `{ ⋯ 12 lines }`. Minified JSON is shown
pretty-printed. Every paste page has Copy, Raw and Download; Raw is
`/p/<token>/raw`, always served as plain text, and `?download=1` sends the file with
its own type. The language comes from the file name's extension when there is one and
from the content otherwise, so a piped `kubectl` dump is YAML and a piped `{...}` is
JSON without saying so; `--language` (or `language` in the API) forces one. The API is
`POST /api/v1/pastes`, `GET /api/v1/pastes/<token>`, `GET /api/v1/pastes/<token>/raw`
and `DELETE /api/v1/pastes/<token>`, and the `paste_create`, `paste_get` and
`paste_delete` MCP tools; each answer carries `language` and `mime`.

### Is it safe to share?

Every way of making a link checks the file first: the paste page, the editor's Paste
link and Share dialogs, `readm3 paste`, `readm3 share` and the API. A **secret** (a
private key, an OpenAI, Anthropic, GitHub, AWS, Stripe, Slack or npm token, a JWT, a
password in a URL or in a `PASSWORD=` style setting) gets a red "Not safe to share"
notice, and the button waits until you tick "I know, share it anyway"; the CLI stops
and needs `--force`. **Personal details** (an email address, a public IP, a home
directory that names your account) get a caution and nothing stops. Matches are
reported with their line, and secrets are masked (`sk-p…N4`), so the warning never
repeats the secret.

`POST /api/v1/pastes` and `shares_create` answer with a `sensitive` report of the
same scan (`level` is `"secret"`, `"personal"` or `null`, plus `findings`); the API
reports and never refuses, so a script decides for itself. A clean scan is not a
guarantee: the check knows common shapes, not every secret.

## Editor

Open https://readm3.com/viewer for a plain, fast text editor in your browser, with the
same two-pane Markdown reader as the terminal. It is deliberately small: the editing
basics of Sublime Text and nothing that needs a plugin.

- **Editing**: line numbers, syntax colors for about a hundred languages (each grammar
  loads the first time it is needed), multiple cursors (`Ctrl+click`, `Ctrl+D` for the
  next match, `Alt+drag` for a column), find and replace (`Ctrl+F`), folding, bracket
  matching, auto-closing brackets, `Ctrl+/` to comment, `Tab` to indent.
- **Quick open**: `Ctrl+P` and a few letters of any path (`exdm` finds `examples/demo.md`).
- **Command palette**: `Ctrl+Shift+P` or `F1` (or `>` in quick open) runs anything:
  open, save, Save As, word wrap, the sidebar, any theme.
- **Tabs** for the files you opened, kept across reloads.
- **Real files**: in Chrome, Edge, the installed app and the desktop app, Open folder
  and Open files work on the files themselves. `Ctrl+S` writes the change back to disk,
  `Ctrl+Shift+S` is Save As, and a `●` marks a file whose disk copy is behind. Other
  browsers open a copy and `Ctrl+S` downloads it.

Code opens straight into the editor; Markdown opens rendered, and `e` edits it.
Open local files or a folder, drop files into the window, open a raw URL or GitHub
file link, or start a new note. The explorer filters files, prunes hidden and build
directories, and sorts README first. All nine themes and Markdown flavors use the
same renderer as the terminal.

Any file a browser can show opens, not only Markdown. Markdown renders as a document.
Every other text file (JSON, JavaScript, Python, YAML, SQL, config, logs, some thirty
languages) opens in the editor, and `Escape` shows it as highlighted, numbered,
foldable code. The language comes from the extension when there is a known one and
is sniffed from the content otherwise. PDFs and images open in the browser's own
viewer. Archives, executables, media and office files are skipped on import, and so
is anything that turns out to be binary. Copy puts the current file on the clipboard;
Download saves it with its own type.

Press `/` to filter, `e` to edit, `Escape` to return to reading, and `?` for shortcuts.
Edits are also kept in IndexedDB on this device as you type, so nothing is lost
offline; a file reaches the disk only when you save it. Reopening a file adds a copy
so an existing draft is preserved. Clearing browser site data removes the workspace.

A link can open a document too: `https://readm3.com/viewer?url=https://host/doc.md`
fetches that raw Markdown URL into the workspace, so a site that publishes plain
Markdown can put a "render this" link on every page. The host must allow
cross-origin reads (`Access-Control-Allow-Origin: *`); when the fetch fails, the
Open URL dialog opens with the address and the reason filled in.

Install through your browser’s app menu, or Share → Add to Home Screen on iOS.
Installed from Chrome or Edge, readm3 appears in the system's "Open with" for text
files. After the first visit, the application, every grammar and the saved workspace
work offline. Remote URLs
need a connection and a host that permits browser access (CORS); files are fetched
directly with no credentials or server proxy. Local files are uploaded only when you explicitly choose Share → Save online.

#### File limits and storage

| | Without an account | Free account | Pay as you go |
| --- | --- | --- | --- |
| Largest file | 4 MB | 5 GB | 5 GB |
| Number of files | 1,000 (20 MB in all) | 1,000,000 (250,000 synced) | 1,000,000 (250,000 synced) |
| Synced storage | none | 5 GB | $0.05 per GB a month over 5 GB |

The meter beside Sync in the editor's header shows storage and files against these
limits; click it for the plan, the price and the balance, and to add funds.

Signed in, a file over 4 MB is a *stored file*: it opens read-only (a PDF or image is
shown whole, text as its first megabyte) and Download gives it back exactly. On the
device it is kept in browser storage as it is; on the account it is end-to-end
encrypted with its own key in 8 MB chunks, and the key travels only inside your
sealed workspace, so readm3.com holds data it cannot read or name. Small files that
do not fit the synced copy are stored the same way and turn back into ordinary,
editable files when opened.

Storage over the free 5 GB is charged hourly from the prepaid balance (CoinPay
top-ups, as for AI summaries). When the balance is empty, new uploads past the free
allowance are refused; nothing already stored is deleted. `GET /api/v1/blobs` reports
what an account stores, the allowance and the price. Self-hosted servers set
`READM3_FREE_STORAGE_BYTES`, `READM3_STORAGE_MICROS_PER_GB_MONTH` and
`READM3_BLOB_DIR` (default: `blobs/` beside the database).

### File history and AI summaries

Every file on the device keeps a rolling history (History in the toolbar, or
`File: History` in the palette): a version each time it is opened, saved, restored,
or **changes on disk underneath the editor**. A file opened from disk is checked
every few seconds and on window focus, so a generated file (a build's `output.json`,
a log, a lockfile) that is rewritten by something else shows up as a new version; with
no local edits it is reloaded, with local edits the disk version waits in History. The
newest 50 versions are kept, up to 8 MB per file. Each version shows when and why it
was recorded, `+added −removed` against the one before, and the changed lines, and can
be restored. All of that is free and never leaves the device.

**AI summaries** are the paid part: one click writes a short abstract of a version's
change plus the specific edits. They are pay as you go from a prepaid balance (top up
$5, $10 or $25 through CoinPay, in USDC, USDT, BTC, ETH, SOL or POL; the balance never
expires). Only the changed lines are sent, never the whole file. Each summary is charged
at a multiple of what the model call cost; the multiple is a two-arm price experiment
(2x or 4x), assigned once per account. A refused or failed call is not charged.

**Summarize** (toolbar, or `File: Summarize with AI` in the palette) does the same for
the whole open document: a short abstract and its key points. Signed in, the first
**10 documents a week are free** (Monday 00:00 UTC to the next); after that each one is
charged from the balance like a change summary. Free summaries carry no price arm, so
the experiment counts only paid ones. Up to 400 KB of text; the first 60,000
characters are sent. Every summary is **kept for the account**, keyed by exactly what
the model was given: the same document (or the same change) asked for again, on any
device or after a reload, is answered from that copy with no model call, no charge and
no free summary used.

**Listen** (optional) reads a summary aloud with ElevenLabs. The first listen is
charged from the balance at the account's price multiple of the voice's cost; the audio
is kept with the summary, so every replay is free. The whole server reads at most
`READM3_TTS_DAILY_CHARS` characters a day (default 5,000) so a shared ElevenLabs plan
cannot run dry; past that, Listen pauses until midnight UTC and the summary stays
readable.

It works on every kind of file, not just text:

- **PDFs** (up to 20 MB) go to the model as they are, so it reads the text and the
  pages' figures, tables and scans.
- **Images**: PNG, JPEG, GIF and WebP are sent as they are. SVG, AVIF, BMP, icons and
  anything over 2,000 px or 3.75 MB are redrawn as PNG (or JPEG) in the browser first.
  The summary describes the picture and any text, chart or diagram in it.
- **Word, Excel, PowerPoint** (`.docx`, `.xlsx`, `.pptx`), **OpenDocument** (`.odt`,
  `.ods`, `.odp`) and **EPUB** files can now be opened in the workspace. The browser
  cannot show them, so they appear as a card with Summarize and Download. The server
  reads the text out of them (paragraphs, slides with speaker notes, sheets row by row,
  chapters in reading order) and summarizes that. Older `.doc`, `.xls` and `.ppt`
  files work on a best-effort basis from the readable text they contain.

| Endpoint | |
| --- | --- |
| `GET /api/v1/billing` | balance, price arm and multiplier, recent ledger |
| `POST /api/v1/billing/topups` `{ amountUsd, chain? }` | starts a CoinPay payment, returns `payUrl` |
| `GET /api/v1/billing/topups/<id>` | `pending` or `paid` |
| `POST /api/v1/summaries` `{ path, before, after }` | the abstract, `chargedMicros`, new balance |
| `POST /api/v1/summaries/document` `{ path, text }` or `{ path, data, mime? }` | a summary of a whole document, from its text or from the file as base64 `data` (PDF, PNG/JPEG/GIF/WebP, Office, OpenDocument, EPUB; the type comes from `mime` or the name); `free`, `chargedMicros`, `freeSummaries { perWeek, left, resetsAt }`, new balance |
| `POST /api/v1/summaries/<summaryId>/speech` | a kept summary read aloud as `audio/mpeg`; `x-charged-micros` (0 on a replay) and `x-balance-micros` headers |
| `GET /api/v1/billing/experiment` | admins: per arm accounts, payers, top-ups, summaries, revenue, model cost |
| `POST /api/v1/billing/coinpay/webhook` | CoinPay's signed webhook (`t=…,v1=` HMAC-SHA256) |

Server configuration: `ANTHROPIC_API_KEY` turns summaries on (`READM3_SUMMARY_MODEL`,
default `claude-opus-5-5`, run at low effort) and `OPENAI_API_KEY` is the fallback when
the Claude call fails (`READM3_OPENAI_MODEL`, default `gpt-5.2`); either one alone works.
`READM3_FREE_SUMMARIES_PER_WEEK` changes the free allowance (default 10).
`ELEVENLABS_API_KEY` turns Listen on (`READM3_TTS_VOICE`, default Matilda
`XrExE9yKIg1WjnnlVkGX`; `READM3_TTS_MODEL`, default `eleven_flash_v2_5`;
`READM3_TTS_MICROS_PER_CHAR`, our cost per character, default 100;
`READM3_TTS_DAILY_CHARS`, default 5,000). `COINPAY_API_KEY`, `COINPAY_BUSINESS_ID`
and `COINPAY_WEBHOOK_SECRET` open top-ups (`COINPAY_API_URL` defaults to
coinpayportal.com). Without them the history still works and the paid parts say so.

### Desktop app

The same editor in its own window, from the
[latest release](https://github.com/profullstack/readm3/releases/latest), checksums in
`SHA256SUMS`:

- **Linux x64**: `readm3-linux-x86_64.AppImage` (`chmod +x`, run it) or
  `readm3-linux-x86_64.flatpak` (`flatpak install --user readm3-linux-x86_64.flatpak`).
  `install.sh --desktop` installs the AppImage with a menu entry; on a system without
  libfuse2 (Ubuntu 26.04 ships only fuse3), it unpacks the app instead, since an AppImage
  cannot mount itself there. Running a downloaded AppImage by hand on such a system needs
  `--appimage-extract-and-run` or `sudo apt install libfuse2t64`.
- **macOS** (Apple silicon `readm3-mac-arm64.dmg`, Intel `readm3-mac-x64.dmg`): drag it
  to Applications. It is ad-hoc signed, not notarized, so the first launch needs
  right-click → Open, or `xattr -dr com.apple.quarantine /Applications/readm3.app`.
- **Windows x64**: `readm3-windows-x64-setup.exe` installs for your user only (no admin);
  it is not code-signed, so SmartScreen asks once (More info → Run anyway). A portable
  `readm3-windows-x64.zip` is there too.

Use it the way you use `subl`: the CLI opens files and folders in the app and gives the
shell back.

```sh
readm3                              # the desktop editor, as you left it
readm3 .                            # this folder in the sidebar, like `subl .`
readm3 notes.md src/app.ts          # as tabs; Ctrl+S saves back to disk
readm3 tui                          # the terminal reader instead
readm3 desktop install              # install or update the app
```

Bare `readm3` is the desktop editor when the app is installed and there is a display;
over SSH to a headless box, without the app, or with any terminal-reader option
(`--theme`, `-R`, `--print`…) it is the terminal reader, as before. `readm3 desktop`,
`readm3 --desktop`, `readm3 edit`, `readm3 subl` and `readm3 open` always mean the
desktop editor. It finds the app on `PATH`
(`readm3-desktop`, which `install.sh --desktop` adds), then where each platform installs
it; `READM3_DESKTOP` names the binary yourself. A folder opens with the same rules as
Open folder (no dot-directories, `node_modules`, build output or binaries; 1,000 files).
Opening a folder again refreshes the files that match disk instead of adding copies;
a file you edited and did not save keeps its draft, and the disk version arrives
beside it. While a file is open, a change on disk (a `git pull`, a build) reloads it,
or lands in History when you have unsaved edits. There is no `--wait`: a second launch
hands its files to the window already open and exits, so `readm3 edit` is not a
`core.editor` for git.

**Signing in** in the app is **Sign in with your browser** on the Account page: your
browser opens readm3.com, where your password manager and email are, you approve the
desktop app, and the app is signed in (OAuth with a loopback redirect, then one exchange
of that token for the window's session at `POST /oauth/desktop-session`). An emailed link
or CoinPay page inside the app would sign in the browser instead, so the app does not offer them.

**Open in app** on readm3.com/viewer opens the same page in the desktop app through a
`readm3://open?url=…` link the app registers (macOS, Windows, and Linux through the
installer's desktop entry). When nothing answers, the button becomes **Get the app**.

Files opened with "Open with" (Finder and Explorer included) go straight into the
editor. The window loads readm3.com, so sign-in, sync and sharing work as on the web;
a copy of the editor ships inside the app for a first launch with no connection. The
Flatpak keeps Chromium's sandbox; on Ubuntu 24.04 and newer an AppImage cannot have one
(AppArmor restricts user namespaces and a FUSE mount is `nosuid`), so its launcher
starts it without and says so. Prefer the Flatpak there.

The app lives in `desktop/` (Electron). `cd desktop && bun install && node build.mjs`
builds the packages for the platform it runs on (the Flatpak needs `flatpak-builder`
and the Flathub remote); `.github/workflows/desktop.yml` builds all three and attaches
them to every release.

## The website

### Accounts

Open https://readm3.com/account to create an email-verified account or sign in.
The email link expires after 15 minutes and works once. A confirmation button
prevents email scanners from consuming links. Accounts are created only after
verification; returning users sign in to the same identity. Account settings
include display name, sign out, and sign out on all devices.

The server stores accounts, hashed sessions, verification challenges, and rate
limits in SQLite. Set `READM3_DB` to a persistent volume path (production uses
`/data/readm3.sqlite`), `READM3_URL` to the canonical public origin,
`READM3_MAIL_FROM` to a verified sender, and `RESEND_API_KEY` to an email-sending key.
Missing or failed mail delivery returns an error; verification links are never
printed to logs. Production cookies are Secure, HttpOnly, SameSite=Lax, and
host-scoped. The account page and APIs are excluded from offline caches.

On Railway, attach a volume at `/data`, keep a single replica, and set
`RAILWAY_RUN_UID=0` for the root-owned volume. Back up the volume before changing
the account schema. The local reader remains usable without an account.

```bash
bun run test:accounts  # account security tests and browser signup flow
```

The account service is `server/accounts.ts`. It can accept an existing Bun SQLite
`Database` so workspace APIs share the same `users` and `sessions` tables.
`account_emails` holds the verified identity associated with each user ID.
Use `Accounts.authenticate(token)` or `Accounts.requireAccount(request)` when
authorizing organization, team, role, or API-token operations: these methods
reject sessions whose user has no verified email. Browser sessions use
`__Host-readm3_session` over HTTPS and `readm3_session` on localhost.
Do not enable a separate unverified registration or password-recovery path.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/auth/email` | Send a sign-in link for an email address |
| `POST /api/auth/preview` | Show the email associated with an unconsumed link |
| `POST /api/auth/verify` | Consume the link and set a browser session |
| `GET /api/auth/session` | Return the verified account, or `null` |
| `POST /api/auth/profile` | Update the current account's display name |
| `POST /api/auth/logout` | Revoke the current session |
| `POST /api/auth/logout-all` | Revoke all sessions belonging to the account |

POST requests require JSON and an `Origin` matching `READM3_URL`.

### Sign in with CoinPay

[CoinPay](https://coinpayportal.com) is an OAuth 2.1 / OpenID provider, and a readm3
account can sign in with it instead of, or as well as, an email link. Register readm3
as a CoinPay OAuth client with the redirect URI
`https://readm3.com/api/v1/coinpay/oauth/callback` (for a self-hosted server,
`$READM3_URL/api/v1/coinpay/oauth/callback`) and the scopes `openid profile email`,
then set:

| Variable | Purpose |
| --- | --- |
| `COINPAY_OAUTH_CLIENT_ID` | readm3's CoinPay client ID. Unset, the button is hidden and the routes answer 503. |
| `COINPAY_OAUTH_CLIENT_SECRET` | Its client secret. Server-side only; the CLI never sees it. |
| `COINPAY_URL` | Default `https://coinpayportal.com`. |

**Sign in with CoinPay** on `/account` runs the authorization code grant with PKCE
(S256); the state and verifier live in a ten-minute, single-use database row bound to
an HttpOnly cookie. On the way back:

- signed in already: the CoinPay account is linked to this readm3 account, unless it
  is linked to a different one (refused) or this account has another CoinPay account;
- a CoinPay account linked before: its readm3 account signs in;
- otherwise: a new readm3 account, with its own workspace, is created and linked.

CoinPay reports every email as unverified, so its email never matches, merges into, or
becomes an account email. The same address on an existing email account is a
different account until you link them while signed in. A linked account can be
unlinked on `/account` when it also has an email; an account that signs in only with
CoinPay cannot be, since that would lock it out. Links, unlinks, sign-ins and app calls
are recorded in `identity_events`; identities are in `user_identities`.

### CLI sign-in (OAuth 2.1)

`readm3 login` signs the CLI in with readm3's own OAuth 2.1 server
([`@profullstack/auth-system/oauth2`](https://www.npmjs.com/package/@profullstack/auth-system),
client `readm3-cli`): authorization code + PKCE S256 only, access tokens for an hour,
refresh tokens that rotate on every use, and a reused refresh token revokes the whole
sign-in. The browser step is `/oauth/authorize`, which sends a signed-out browser
through `/account` (email or CoinPay) and then asks to approve. Where the CLI can open a
browser on the same machine it waits on a loopback redirect (`http://127.0.0.1:PORT/callback`);
over SSH, or with `--no-browser` / `READM3_NO_BROWSER=1`, it prints the link to open in
any browser and `/oauth/cli` shows a code to paste back. Tokens are kept in `cloud.json`
(0600) and refreshed by every command; `readm3 logout` revokes them on the server.
`readm3 login --coinpay` is the same sign-in. Metadata is at
`/.well-known/oauth-authorization-server`; tokens at `/oauth/token`, revocation at `/oauth/revoke`.
`POST /api/v1/coinpay/oauth/cli-exchange` remains for CLI versions before 0.14.0.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/coinpay/status` | Whether CoinPay is configured, its client ID, and your linked identities |
| `GET /api/v1/coinpay/oauth/start[?next=/admin]` | Redirect to CoinPay to sign in or link |
| `GET /api/v1/coinpay/oauth/callback` | CoinPay's redirect target; sets the browser session |
| `POST /api/v1/coinpay/oauth/cli-exchange` | Trade a loopback grant for a readm3 API token |
| `POST /api/v1/coinpay/unlink` | Unlink CoinPay from the signed-in account |

### Trusted apps

Other apps that sign people in with CoinPay can call the readm3 API as those people
with the CoinPay access token they already hold, without a readm3 token:
`Authorization: Bearer <CoinPay access token>`. Only apps on an allowlist are accepted:

```sh
READM3_COINPAY_TRUSTED_CLIENTS=ai-profullstack,another-client-id  # CoinPay client_ids
```

readm3 checks each token by calling CoinPay's userinfo (which verifies its signature
and expiry), and only then reads `client_id` from the token; a client not on the list
gets a 403 naming it. Answers are cached by the token's SHA-256 until it expires or for
five minutes, whichever is sooner. The CoinPay account maps to its linked readm3 user,
and one that has never been seen gets a new account exactly as a first sign-in would.
Each validation is recorded in `identity_events` with the acting `client_id`. These are
server-to-server calls: a browser `Origin` other than readm3's is still refused.

```sh
curl -X POST https://readm3.com/api/v1/documents -H "authorization: Bearer $COINPAY_TOKEN" \
  -H 'content-type: application/json' -d '{"title":"Answer.md","source":"# Hi","access":"private"}'
curl -X POST https://readm3.com/api/v1/documents/DOC_ID/shares -H "authorization: Bearer $COINPAY_TOKEN" \
  -H 'content-type: application/json' -d '{"role":"view"}'   # → {"url":"https://readm3.com/s/…"}
```

`orgId` is optional on `POST /api/v1/documents`: without it a document goes to the
caller's personal workspace (the oldest organization they own), else their only
organization; several memberships and none owned is a 400 asking for `orgId`.

### Building and serving

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
for access to the mounted volume. Use one service replica for SQLite and configure
volume backups in the hosting platform.

Set `READM3_ADMIN_BOOTSTRAP_SECRET` to a random secret. Sign in at `/account` as
the intended super administrator, then open `/admin#claim=YOUR_SECRET`. This is a
one-time claim stored in the database. Never publish this URL; remove the environment
secret after claiming. Email sign-in never grants administrator access by itself.

Accounts use verified email sign-in and HttpOnly cookies. API tokens and share
capabilities are stored as SHA-256 hashes. Shared documents are not cached in the
PWA or saved in the browser's local workspace, so revocation applies to future access.

```sh
bun run test:server  # auth, roles, version history, persistence, CLI and MCP
bun run test:site    # local/offline reader plus browser sharing and admin workflows
```

## Workspace and settings sync

Every signed-in device (browser tab, installed app, desktop app) syncs the workspace
and reader settings **automatically and end to end encrypted**. Turn it off for one
device with **Sync automatically on this device** in the Sync dialog.

- **Automatic**: on load, a few seconds after each edit, on focus, and every 30 s
  (that check asks only for the latest revision number). Edits merge per file
  (`src/sync-merge.ts`): a file changed on one device takes that change; changed on two,
  the account copy keeps the name and the other is kept beside it as
  `name (conflict <device> <date>).md`. A device that has never synced loads first and
  never uploads its starter files over an account.
- **End-to-end encrypted** (`src/sync-crypto.ts`): the workspace and settings are
  gzip-compressed, then sealed with AES-256-GCM under a key derived (PBKDF2-SHA256,
  600,000 iterations, per-account salt) from your **sync passphrase**. readm3.com stores
  one `sealed.json` per revision and cannot read file names, text or settings. You choose
  the passphrase on the first device and type it once on each other one (the derived key
  stays in that device's IndexedDB, non-extractable); a password manager can store it.
  There is no reset: without it the synced copy cannot be opened, though every device
  keeps its local files. **Change sync passphrase** re-seals the account copy; other
  devices then ask for the new one. The first encrypted save deletes every readable
  revision the server held, and the server refuses readable saves after that.

Shared documents continue to use their own document permissions and version history.
Sync requires a connection; the local reader still works offline. The CLI's
`readm3 save`/`load`/`sync` still move readable snapshots and are refused by an account
that syncs encrypted.

Sign in with verified email at `/account`, then create a personal API token in `/admin`
for the CLI.

The CLI, document commands, and MCP use one credential file, `cloud.json`, under
`$XDG_CONFIG_HOME/readm3` (normally `~/.config/readm3`). It is written with mode
0600. Login verifies the account; logout removes the local credential. Revoke a token
in `/admin` to invalidate remote copies. Tokens can also be created and revoked from the account page.

```sh
readm3 login                             # or --token-stdin: paste a token, then Ctrl+D
readm3 whoami
readm3 settings --theme nord --flavor github
readm3 save ./notes                      # explicitly import and save Markdown
readm3 sync status
readm3 sync revisions
readm3 load --dry-run                    # inspect the incoming changes
readm3 load ./downloaded-notes           # load and export into a new directory
readm3 load --force                      # replace local conflicts, with backups
readm3 logout
```

For self-hosting, set `READM3_URL` to the server origin, or set `READM3_API_URL` to
its API base such as `http://127.0.0.1:3000/api/v1`. `READM3_TOKEN` supplies a token
without writing it to disk. `READM3_CONFIG_DIR` selects an isolated client directory.
HTTPS is required except on localhost. A saved token is never sent to a different
server merely because an environment variable changed.

Sync uses `@profullstack/synconfig`, the same package used by moshcode. Only
`settings.json` (theme and flavor) and `workspace.json` (the explicitly imported
workspace) are allowed. Credentials, local revision markers, and backups are excluded.
Running `save` without a path saves those local files; it does not scan the current
directory. Running `load` without an output directory updates those files, and loaded
preferences apply to subsequent terminal reader invocations.

Each account keeps ten revisions. Saves carry the last loaded revision and reject
concurrent changes; a new device starts at revision 0. Loads refuse to replace
conflicting local edits, including on a device that has never synced. `--force`
explicitly overrides a conflict. Replaced local files receive numbered `.bak-NNN`
backups. Browser replacements receive backups in IndexedDB, accessible through
**Sync → Local backups** for download or restoration. Clearing browser site data
also removes those local backups. The CLI syncs a readable workspace of up to 4 MB
per file and 20 MB in total; the browser and desktop app sync up to 250,000 files (a workspace holds up to 1,000,000) of
up to 5 GB each (see File limits and storage).

The authenticated API exposes:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/me` | Current account; `user: null` when signed out |
| `GET /api/v1/settings` | Latest snapshot, digest, and revision; 404 when empty |
| `PUT /api/v1/settings` | Save `{ snapshot, ifRevision }`; 409 on a conflict |
| `GET /api/v1/settings/revisions` | The last ten revision summaries |

`/api/v1/synconfig` is an alias for the settings endpoints. A snapshot is
`{ version: 1, host, app, files: { "settings.json": { content: "{...}" } } }`.
`workspace.json` uses `{ name, active, documents: [{ path, source }] }` inside its
JSON content string. Send `ifRevision: 0` for a first save, the revision last loaded
for subsequent saves, or `null` for an explicitly forced save. API callers use
`Authorization: Bearer TOKEN`; browser callers use the same account's HTTP-only
session cookie and same-origin requests. Account responses are never cached offline.

Start MCP with `readm3 mcp`. Alongside the document and organization tools, it exposes
`settings_get`, `settings_save`, and `settings_revisions`. `settings_save` requires
a nonnegative `ifRevision` and uses the same validation and conflict checks as the API.

Run `bun run test:server` for account/sync integration checks and `bun run test:site`
for browser checks. The server needs Bun and a persistent `READM3_DB` SQLite path;
in the container this defaults to `/data/readm3.sqlite`, so mount persistent storage
at `/data`. Set `READM3_URL` to the public origin for browser origin checks.

## License

MIT.
