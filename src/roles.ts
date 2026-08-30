/**
 * The one place a span's semantic role becomes a color.
 *
 * Both the reader and `--print` go through here, so a document looks the same
 * dumped to a pipe as it does in the pane.
 */
import type { Color, Theme } from "@profullstack/hqtui";
import type { Span } from "./markdown.ts";

export function colorOf(span: Span, theme: Theme): Color {
  switch (span.role) {
    case "h1":
      return theme.title;
    case "h2":
      return theme.primary;
    case "h3":
      return theme.secondary;
    case "code":
    case "lang":
    case "bullet":
      return theme.accent;
    case "fence":
      return theme.foreground;
    case "gutter":
    case "rule":
      return theme.border;
    case "link":
    case "url":
      return theme.info;
    case "quote":
      return theme.secondary;
    case "meta":
      return theme.muted;
    case "th":
      return theme.title;
    default:
      return theme.foreground;
  }
}
