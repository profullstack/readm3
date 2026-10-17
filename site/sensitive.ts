/**
 * The "is this safe to share?" notice above every button that makes a link.
 *
 * Personal details get a caution and nothing more. A secret gets a red notice and a
 * checkbox the button waits on, so a key cannot go out on one careless click. The
 * scan is src/sensitive.ts, the same one the API, CLI and MCP run.
 */
import { scanSensitive, type SensitiveReport } from "../src/sensitive.ts";

export type SensitiveGate = {
  /** Scan this text and redraw the notice; null clears it (a PDF or image). */
  check(source: string | null): SensitiveReport;
  /** A secret is showing and its box is not ticked. */
  blocked(): boolean;
};

export function sensitiveGate(notice: HTMLElement, button: HTMLButtonElement): SensitiveGate {
  let report: SensitiveReport = { level: null, findings: [] };
  let confirmed = false;
  // The text the box was ticked for: an edit that adds another secret asks again.
  let confirmedFor = "";
  const blocked = () => report.level === "secret" && !confirmed;
  const render = () => {
    notice.replaceChildren();
    notice.hidden = !report.level;
    notice.className = `sensitive sensitive-${report.level ?? "none"}`;
    button.disabled = blocked();
    if (!report.level) return;
    const heading = document.createElement("strong");
    heading.textContent = report.level === "secret"
      ? "Not safe to share: this looks like it holds a secret."
      : "Check before sharing: this identifies you.";
    const why = document.createElement("p");
    why.textContent = report.level === "secret"
      ? "Anyone with the link could read it and use it. Remove it, or rotate it after sharing."
      : "Anyone with the link will see these.";
    const list = document.createElement("ul");
    for (const finding of report.findings) {
      const item = document.createElement("li");
      item.className = `sensitive-${finding.level}`;
      const sample = document.createElement("code");
      sample.textContent = finding.sample;
      item.append(`${finding.label[0]!.toUpperCase()}${finding.label.slice(1)} on line ${finding.line}${finding.count > 1 ? ` (${finding.count} different)` : ""}: `, sample);
      list.append(item);
    }
    notice.append(heading, why, list);
    if (report.level !== "secret") return;
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = confirmed;
    box.onchange = () => { confirmed = box.checked; button.disabled = blocked(); };
    label.append(box, " I know, share it anyway");
    notice.append(label);
  };
  return {
    check(source) {
      report = source === null ? { level: null, findings: [] } : scanSensitive(source);
      const key = report.findings.filter((f) => f.level === "secret").map((f) => `${f.label}:${f.sample}:${f.count}`).join("|");
      if (key !== confirmedFor) { confirmed = false; confirmedFor = key; }
      render();
      return report;
    },
    blocked,
  };
}
