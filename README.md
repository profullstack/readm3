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
stored, so the link cannot be shown again. The Share button in the web reader makes
one when you are signed out. Pastes expire after seven days by default (1h, 1d, 7d or
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

A link can open a document too: `https://readm3.com/viewer?url=https://host/doc.md`
fetches that raw Markdown URL into the workspace, so a site that publishes plain
Markdown can put a "render this" link on every page. The host must allow
cross-origin reads (`Access-Control-Allow-Origin: *`); when the fetch fails, the
Open URL dialog opens with the address and the reason filled in.

Install through your browser’s app menu, or Share → Add to Home Screen on iOS.
After the first visit, the application and saved workspace work offline. Remote URLs
need a connection and a host that permits browser access (CORS); files are fetched
directly with no credentials or server proxy. Local files are uploaded only when you explicitly choose Share → Save online.

Imports are limited to 4 MB per file, 20 MB per workspace, and 1,000 files.

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

Sign in with verified email at `/account`, then create a personal API token in `/admin`. The PWA's **Sync** button saves or loads
your local Markdown workspace and reader preferences on that same account. Shared
documents continue to use their own document permissions and version history.
Local files are uploaded only when you choose **Save to account**, `readm3 save`,
or a sharing action. Sync requires a connection; the local reader still works offline.

The CLI, document commands, and MCP use one credential file, `cloud.json`, under
`$XDG_CONFIG_HOME/readm3` (normally `~/.config/readm3`). It is written with mode
0600. Login verifies the account; logout removes the local credential. Revoke a token
in `/admin` to invalidate remote copies. Tokens can also be created and revoked from the account page.

```sh
readm3 login --token-stdin               # paste a token, then Ctrl+D
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
also removes those local backups. Sync supports the browser's workspace limits:
1,000 Markdown files, 4 MB per file, and 20 MB of source in total.

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
