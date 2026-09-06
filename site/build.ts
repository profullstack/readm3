/**
 * Builds readm3.com into site/dist.
 *
 * Every rendered document on the page goes through the package's own
 * `renderMarkdown`, and every color comes from an HQTUI theme, so the site
 * cannot drift from what the reader actually draws. Spans are emitted with
 * their semantic role and the roles become CSS variables, which is the same
 * separation `roles.ts` makes for the terminal: one parse, nine palettes.
 */
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { themeList, resolveTheme, type Theme } from "@profullstack/hqtui";
import { renderMarkdown, type Line, type Role } from "../src/markdown.ts";
import { flatten, type Entry } from "../src/tree.ts";
import { VERSION } from "../src/cli.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "dist");

const SITE = "https://readm3.com";
const REPO = "https://github.com/profullstack/readm3";
const NPM = "https://www.npmjs.com/package/@profullstack/readm3";
const HQTUI = "https://hqtui.com";
const CP_PROJECT = "528372c9-c79a-425f-9f80-f9fe44c5865e";
const CP_SLOT = "b918cc2d-4bd9-45e4-9b9e-52955b4e2e54";

/* -------------------------------------------------------------- colors --- */

/** HQTUI packs a color as a set-bit plus 24 bits of RGB. */
function cssColor(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
}

/**
 * The variables a themed pane needs. The role-to-slot mapping is `roles.ts`,
 * restated once here so the web pane and the terminal agree by construction.
 */
function themeVars(theme: Theme): Record<string, string> {
  return {
    "--bg": cssColor(theme.background),
    "--surface": cssColor(theme.surface),
    "--fg": cssColor(theme.foreground),
    "--muted": cssColor(theme.muted),
    "--primary": cssColor(theme.primary),
    "--secondary": cssColor(theme.secondary),
    "--accent": cssColor(theme.accent),
    "--info": cssColor(theme.info),
    "--border": cssColor(theme.border),
    "--title": cssColor(theme.title),
    "--selection": cssColor(theme.selection),
    "--selection-text": cssColor(theme.selectionText),
  };
}

function themeBlocks(): string {
  return themeList
    .map((entry) => {
      const theme = resolveTheme(entry.name);
      const body = Object.entries(themeVars(theme))
        .map(([key, value]) => `  ${key}: ${value};`)
        .join("\n");
      return `[data-theme="${entry.name}"] {\n${body}\n}`;
    })
    .join("\n\n");
}

/* ---------------------------------------------------------------- html --- */

function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JSON that is safe to sit inside a script element. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function spanClass(role: Role | undefined, span: { bold?: boolean; italic?: boolean; underline?: boolean; dim?: boolean }): string {
  const parts: string[] = [];
  if (role && role !== "text") parts.push(`r-${role}`);
  if (span.bold) parts.push("b");
  if (span.italic) parts.push("i");
  if (span.underline) parts.push("u");
  if (span.dim) parts.push("d");
  return parts.join(" ");
}

/** Rendered lines to a <pre> body, one span element per styled run. */
function toHtml(lines: Line[]): string {
  return lines
    .map((line) =>
      line.spans
        .map((span) => {
          const cls = spanClass(span.role, span);
          const text = escape(span.text);
          return cls ? `<span class="${cls}">${text}</span>` : text;
        })
        .join(""),
    )
    .join("\n");
}

function render(source: string, width: number): string {
  return toHtml(renderMarkdown(source, width));
}

/* -------------------------------------------------------------- sidebar --- */

function file(name: string, path: string): Entry {
  return { name, path, dir: false, children: [], expanded: false };
}

function dir(name: string, path: string, children: Entry[]): Entry {
  return { name, path, dir: true, children, expanded: true };
}

/**
 * The browser pane, flattened by the reader's own `flatten` so the depth and
 * ordering shown here are the ones the reader computes.
 */
function sidebar(tree: Entry[], selected: string): string {
  return flatten(tree)
    .map(({ entry, depth }) => {
      const indent = "  ".repeat(depth);
      const marker = entry.dir ? (entry.expanded ? "▾ " : "▸ ") : "";
      const cls = entry.path === selected ? "row sel" : "row";
      const role = entry.dir ? "r-h2" : "";
      return `<span class="${cls}">${indent}<span class="${role}">${marker}${escape(entry.name)}</span></span>`;
    })
    .join("\n");
}

const TREE: Entry[] = [
  dir("docs", "docs", [file("options.md", "docs/options.md"), file("themes.md", "docs/themes.md")]),
  file("README.md", "README.md"),
  file("CHANGELOG.md", "CHANGELOG.md"),
  file("LICENSE.md", "LICENSE.md"),
];

/* ----------------------------------------------------------------- page --- */

interface PaneOptions {
  title: string;
  body: string;
  tree?: Entry[];
  selected?: string;
  percent?: string;
}

/** One reader window: the frame, the two panes, and the status line. */
function pane({ title, body, tree, selected, percent = "24%" }: PaneOptions): string {
  const left = tree
    ? `<div class="pane pane-tree"><div class="pane-title">readm3</div><pre class="tree">${sidebar(tree, selected ?? "")}</pre></div>`
    : "";
  return `<div class="window" data-theme="dark">
  <div class="chrome"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="chrome-title">${escape(title)}</span></div>
  <div class="panes">
    ${left}
    <div class="pane pane-doc">
      <div class="pane-title">${escape(title)}<span class="pane-pct">${percent}</span></div>
      <div class="scroll"><pre class="doc">${body}</pre></div>
    </div>
  </div>
  <div class="status"><span>↑↓ move</span><span>↵ open</span><span>/ find</span><span>tab reader</span><span>? keys</span><span>q quit</span></div>
</div>`;
}

function themeSwitch(): string {
  const buttons = themeList
    .map(
      (entry, index) =>
        `<button type="button" class="chip${index === 0 ? " on" : ""}" data-set-theme="${entry.name}">${entry.name}</button>`,
    )
    .join("");
  return `<div class="chips" role="group" aria-label="Color theme">${buttons}</div>`;
}

function shell(options: { title: string; description: string; path: string; main: string; jsonLd: unknown }): string {
  const canonical = options.path === "/" ? SITE : `${SITE}${options.path}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(options.title)}</title>
<meta name="description" content="${escape(options.description)}">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
<meta property="og:type" content="website">
<meta property="og:title" content="${escape(options.title)}">
<meta property="og:description" content="${escape(options.description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="readm3">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">${embedJson(options.jsonLd)}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <a class="brand" href="/">readm3</a>
  <nav>
    <a href="/docs">Docs</a>
    <a href="${REPO}">GitHub</a>
    <a href="${NPM}">npm</a>
  </nav>
</header>
<main id="main">
${options.main}
</main>
<footer class="foot">
  <div class="foot-links">
    <span>MIT. Built by <a href="https://profullstack.com">Profullstack</a> on <a href="${HQTUI}">HQTUI</a>.</span>
    <span><a href="${REPO}">Source</a> · <a href="${NPM}">npm</a> · v${VERSION}</span>
  </div>
  <aside data-cp-ad data-slot="${CP_SLOT}" data-format="text_link"></aside>
</footer>
<script src="/app.js" defer></script>
<script data-site="${CP_PROJECT}" src="https://crawlproof.com/stats.js" async></script>
<script src="https://crawlproof.com/ad.js" async></script>
</body>
</html>
`;
}

/* ----------------------------------------------------------------- copy --- */

const INSTALL = `bun add -g @profullstack/readm3`;

/** The README embeds a 90-column ASCII screenshot; render wider or it truncates. */
const README_WIDTH = 100;

function codeBlock(label: string, lines: string[]): string {
  const body = lines.map((line) => escape(line)).join("\n");
  return `<figure class="code"><figcaption>${escape(label)}</figcaption><pre><code>${body}</code></pre></figure>`;
}

function home(): string {
  const demo = readFileSync(join(here, "content", "demo.md"), "utf8");
  const readme = readFileSync(join(root, "README.md"), "utf8");

  const hero = `<section class="hero">
  <p class="eyebrow">Terminal markdown reader</p>
  <h1>Read your docs where you already are.</h1>
  <p class="lede">readm3 opens a directory of markdown, puts the file browser on the left and
  the rendered document on the right, and gets out of the way. It runs on Bun and Node, it
  draws in truecolor, and it restores your terminal no matter how the process dies.</p>
  <div class="cta">
    <div class="install"><code id="install">${escape(INSTALL)}</code><button type="button" id="copy" data-copy="${escape(INSTALL)}">Copy</button></div>
    <a class="ghost" href="/docs">Read the docs</a>
  </div>
  <p class="sub">Or run it without installing: <code>bunx @profullstack/readm3</code></p>
</section>`;

  const demoSection = `<section class="section">
  <div class="section-head">
    <h2>One parse, nine palettes</h2>
    <p>The renderer returns spans carrying a semantic role rather than a color, so changing
    theme re-colors a document without re-parsing it. The window below is real output from
    <code>renderMarkdown</code>, and these buttons swap the palette exactly as
    <code>--theme</code> does in your terminal.</p>
  </div>
  ${themeSwitch()}
  ${pane({ title: "demo.md", body: render(demo, 84), tree: TREE, selected: "README.md" })}
</section>`;

  const printSection = `<section class="section">
  <div class="section-head">
    <h2>A cat for markdown</h2>
    <p><code>--print</code> renders to stdout and exits, so it works in a pipe. Color follows
    the usual rules: on for a terminal, off for a pipe, and <code>NO_COLOR</code> and
    <code>FORCE_COLOR</code> are honored.</p>
  </div>
  ${codeBlock("shell", [
    "readm3 --print CHANGELOG.md          # rendered, colored, to the terminal",
    "readm3 --print README.md | less -R   # into a pager",
    "curl -s https://example.com/x.md | readm3 --print",
    "readm3 --print notes.md | grep TODO  # no escapes when stdout is a pipe",
  ])}
</section>`;

  const librarySection = `<section class="section">
  <div class="section-head">
    <h2>The renderer is a library</h2>
    <p>Parsing and the file tree are pure and need no terminal, so the same code that draws
    this page can run in a test, a build step, or your own tool.</p>
  </div>
  ${codeBlock("typescript", [
    'import { renderMarkdown, toText, scan, files } from "@profullstack/readm3";',
    "",
    'const lines = renderMarkdown("# Hello\\n\\nSome **text**.", 60);',
    "console.log(toText(lines));",
    "// [ 'Hello', '━━━…', '', 'Some text.' ]",
    "",
    'for (const file of files(scan("./docs"))) console.log(file.path);',
  ])}
</section>`;

  const grid = `<section class="section">
  <div class="section-head"><h2>What it renders</h2></div>
  <div class="grid">
    <div class="card"><h3>The whole document</h3><p>Headings, emphasis, links, fenced and indented code with a language label, nested and task lists, blockquotes, tables with per-column alignment, rules, and images as labelled placeholders.</p></div>
    <div class="card"><h3>Front matter, shown</h3><p>YAML front matter is rendered rather than hidden, because it is usually what you opened the file for.</p></div>
    <div class="card"><h3>HTML folded back</h3><p>The HTML that real READMEs are full of becomes markdown again instead of printing as tags. Inline code is held out of that, so <code>Array&lt;string&gt;</code> survives.</p></div>
    <div class="card"><h3>A pruned tree</h3><p>The browser shows only markdown. Directories with nothing beneath them disappear, <code>node_modules</code> and friends are never walked, and README sorts first.</p></div>
    <div class="card"><h3>Mouse and keyboard</h3><p>The wheel scrolls whichever pane it is over and a click opens a file. Everything has a key as well, including <code>/</code> to filter and <code>?</code> for help.</p></div>
    <div class="card"><h3>Two runtimes</h3><p>Bun is the default and Node 22.6 or newer runs the same code. Tested on Linux, macOS and Windows Terminal.</p></div>
  </div>
</section>`;

  const readmeSection = `<section class="section">
  <div class="section-head">
    <h2>Its own README, through itself</h2>
    <p>The document below is this project's README, rendered by the version of the parser
    that shipped with ${escape(`v${VERSION}`)}. It is the page's own regression test.</p>
  </div>
  ${pane({ title: "README.md", body: render(readme, README_WIDTH), percent: "100%" })}
</section>`;

  return shell({
    title: "readm3 — a terminal markdown reader",
    description:
      "readm3 is a terminal markdown reader: a file browser on the left, the rendered document on the right. Bun and Node, truecolor, nine themes, and a --print mode that works in a pipe.",
    path: "/",
    main: [hero, demoSection, grid, printSection, librarySection, readmeSection].join("\n"),
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "readm3",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Linux, macOS, Windows",
      softwareVersion: VERSION,
      description: "A terminal markdown reader: file browser on the left, rendered markdown on the right.",
      url: SITE,
      downloadUrl: NPM,
      codeRepository: REPO,
      license: "https://opensource.org/licenses/MIT",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      author: { "@type": "Organization", name: "Profullstack, Inc.", url: "https://profullstack.com" },
    },
  });
}

function docs(): string {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const main = `<section class="hero hero-tight">
  <p class="eyebrow">Documentation</p>
  <h1>readm3 ${escape(`v${VERSION}`)}</h1>
  <p class="lede">Everything below is the project README, rendered by readm3's own parser at
  build time. Change the theme and the same parse re-colors, which is what happens in your
  terminal when you pass <code>--theme</code>.</p>
  <div class="cta">
    <div class="install"><code>${escape(INSTALL)}</code><button type="button" data-copy="${escape(INSTALL)}">Copy</button></div>
    <a class="ghost" href="${REPO}">Source on GitHub</a>
  </div>
</section>
<section class="section">
  ${themeSwitch()}
  ${pane({ title: "README.md", body: render(readme, README_WIDTH), tree: TREE, selected: "README.md", percent: "100%" })}
</section>`;

  return shell({
    title: "readm3 docs",
    description: "The readm3 README, rendered by readm3: install, keys, options, --print, and the library API.",
    path: "/docs",
    main,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: "readm3 documentation",
      about: "A terminal markdown reader",
      url: `${SITE}/docs`,
      version: VERSION,
      author: { "@type": "Organization", name: "Profullstack, Inc.", url: "https://profullstack.com" },
    },
  });
}

/* ------------------------------------------------------------ discovery --- */

const today = new Date().toISOString().slice(0, 10);

const robots = `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml
`;

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${SITE}/docs</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>
</urlset>
`;

const llms = `# readm3

> A terminal markdown reader. A file browser on the left, the rendered document on the
> right. Runs on Bun and Node, built on HQTUI, MIT licensed, currently v${VERSION}.

## What it is

readm3 opens a directory of markdown files and renders them in the terminal in truecolor.
The browser pane shows only markdown, prunes directories with nothing beneath them, never
walks node_modules, and sorts README first. The reader pane renders headings, emphasis,
inline code, links, fenced and indented code blocks, nested and task lists, blockquotes,
tables with per-column alignment, rules, images as labelled placeholders, and YAML front
matter.

## Install

    bun add -g @profullstack/readm3
    npm install -g @profullstack/readm3

Or run it without installing with bunx or npx.

## Print mode

\`readm3 --print FILE\` renders to stdout and exits, so it works in a pipe and as a cat for
markdown. Color is on for a terminal and off for a pipe; NO_COLOR and FORCE_COLOR are
honored, and --color always|never|auto overrides.

## As a library

renderMarkdown(source, width) returns lines of spans carrying a semantic role such as h1,
code, link or quote rather than a color, so a document can be re-themed without being
re-parsed. scan() and files() expose the pruned file tree. Both are pure and need no
terminal.

## Links

- Site: ${SITE}
- Source: ${REPO}
- Package: ${NPM}
- Built on: ${HQTUI}
`;

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#05070a"/>
  <rect x="8" y="8" width="18" height="48" rx="3" fill="#101720"/>
  <path d="M13 18h8M13 26h8M13 34h6" stroke="#5fd7ff" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M32 18h20M32 27h20M32 36h14M32 45h18" stroke="#c8d3e0" stroke-width="3" stroke-linecap="round"/>
  <path d="M32 18h20" stroke="#ffd75f" stroke-width="3" stroke-linecap="round"/>
</svg>
`;

/* ----------------------------------------------------------------- emit --- */

function write(name: string, body: string): void {
  const target = join(out, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(out, { recursive: true });

const css = readFileSync(join(here, "assets", "styles.css"), "utf8").replace(
  "/* THEMES */",
  themeBlocks(),
);

write("index.html", home());
write("docs/index.html", docs());
write("styles.css", css);
write("robots.txt", robots);
write("sitemap.xml", sitemap);
write("llms.txt", llms);
write("favicon.svg", favicon);
cpSync(join(here, "assets", "app.js"), join(out, "app.js"));

console.log(`built readm3.com v${VERSION} into ${out} (${themeList.length} themes)`);
