import type { Line, Role } from "../src/markdown.ts";

export function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function spanClass(role: Role | undefined, span: Line["spans"][number]): string {
  return [role && role !== "text" ? `r-${role}` : "", span.bold ? "b" : "",
    span.italic ? "i" : "", span.underline ? "u" : "", span.dim ? "d" : "",
    span.strike ? "s" : ""].filter(Boolean).join(" ");
}

/** Only escaped text and renderer-owned classes reach the DOM, never source HTML. */
export function toHtml(lines: Line[]): string {
  return lines.map((line) => line.spans.map((span) => {
    const cls = spanClass(span.role, span);
    return cls ? `<span class="${cls}">${escape(span.text)}</span>` : escape(span.text);
  }).join("")).join("\n");
}
