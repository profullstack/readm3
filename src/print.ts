/**
 * `--print`: render a document straight to stdout instead of opening the reader.
 *
 * Useful in a pipe, as a `cat` for markdown, or fed to a pager. Color depth comes
 * from the same detection the reader uses, so NO_COLOR, FORCE_COLOR and "stdout
 * is not a terminal" are all honored without special-casing them here.
 */
import { readFileSync } from "node:fs";
import {
  detectCapabilities,
  resolveTheme,
  to16,
  to256,
  type Color,
  type ColorDepth,
  type Theme,
} from "@profullstack/hqtui";
import { renderMarkdown, type RenderOptions, type Span } from "./markdown.ts";
import { colorOf } from "./roles.ts";

export type ColorMode = "auto" | "always" | "never";

export const COLOR_MODES: ColorMode[] = ["auto", "always", "never"];

const ESC = String.fromCharCode(27);
/** Used when stdout has no width to report. */
const DEFAULT_WIDTH = 80;

export interface PrintOptions extends RenderOptions {
  /** File to render. Omitted, or "-", reads stdin. */
  path?: string | undefined;
  width?: number | undefined;
  theme?: string | undefined;
  color?: ColorMode | undefined;
}

/** The SGR parameters that set a foreground color at a given depth. */
export function colorParams(color: Color, depth: ColorDepth): string[] {
  switch (depth) {
    case "truecolor":
      return ["38", "2", String((color >>> 16) & 255), String((color >>> 8) & 255), String(color & 255)];
    case "ansi256":
      return ["38", "5", String(to256(color))];
    case "ansi16": {
      const index = to16(color);
      return [String(index < 8 ? 30 + index : 90 + (index - 8))];
    }
    default:
      return [];
  }
}

/** One span, escaped. Every span resets, so nothing leaks onto the next. */
export function styleSpan(span: Span, theme: Theme, depth: ColorDepth): string {
  if (span.text === "") return "";
  if (depth === "none") return span.text;
  const params: string[] = [];
  if (span.bold) params.push("1");
  if (span.dim) params.push("2");
  if (span.italic) params.push("3");
  if (span.underline) params.push("4");
  if (span.strike) params.push("9");
  params.push(...colorParams(colorOf(span, theme), depth));
  if (params.length === 0) return span.text;
  return `${ESC}[${params.join(";")}m${span.text}${ESC}[0m`;
}

/** A whole document as text, colored to `depth`. */
export function renderAnsi(
  source: string,
  width: number,
  theme: Theme,
  depth: ColorDepth,
  options: RenderOptions = {},
): string {
  return renderMarkdown(source, width, options)
    .map((line) =>
      line.spans
        .map((span) => styleSpan(span, theme, depth))
        .join("")
        // Trailing table and list padding is meaningful on screen, noise in a pipe.
        .replace(/[ \t]+$/, ""),
    )
    .join("\n");
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function resolveDepth(mode: ColorMode = "auto"): ColorDepth {
  if (mode === "never") return "none";
  if (mode === "always") {
    const detected = detectCapabilities({ tty: true }).colors;
    return detected === "none" ? "truecolor" : detected;
  }
  return detectCapabilities().colors;
}

export function resolveWidth(explicit?: number): number {
  if (explicit && explicit > 0) return explicit;
  const columns = process.stdout.columns;
  return columns && columns > 0 ? columns : DEFAULT_WIDTH;
}

export function printDocument(options: PrintOptions = {}): void {
  const source = options.path && options.path !== "-" ? readFileSync(options.path, "utf8") : readStdin();
  const theme = resolveTheme(options.theme);
  const text = renderAnsi(source, resolveWidth(options.width), theme, resolveDepth(options.color), {
    flavor: options.flavor,
    spoilers: options.spoilers,
  });
  process.stdout.write(text === "" ? "" : `${text}\n`);
}
