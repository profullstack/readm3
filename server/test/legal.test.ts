import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { privacyMain, termsMain, LEGAL_EFFECTIVE_DATE } from "../../site/legal.ts";

const SITE = "https://readm3.com";
const build = readFileSync(new URL("../../site/build.ts", import.meta.url), "utf8");

for (const [name, main, heading] of [
  ["privacy", privacyMain(SITE), "Privacy Policy"],
  ["terms", termsMain(SITE), "Terms of Service"],
] as const) {
  test(`/${name} is headed "${heading}", dated, and names the operator and MCP endpoint`, () => {
    expect(main).toContain(`<h1>${heading}</h1>`);
    expect(main).toContain(`Effective date: ${LEGAL_EFFECTIVE_DATE}`);
    expect(LEGAL_EFFECTIVE_DATE).toBe("November 11, 2026");
    expect(main).toContain("Profullstack, Inc., 16375 Bonnie Lane, Los Gatos, CA 95032, USA");
    expect(main).toContain("support@profullstack.com");
    expect(main).toContain(`${SITE}/mcp`);
    expect(main).not.toMatch(/[–—]/);
  });

  test(`/${name} is built as a page in the site shell`, () => {
    expect(build).toContain(`write("${name}/index.html", shell({`);
    expect(build).toContain(`path: "/${name}"`);
  });
}

test("the privacy policy has the AI agents and MCP section", () => {
  const main = privacyMain(SITE);
  expect(main).toContain("AI agents and MCP");
  expect(main).toContain("read_url");
  expect(main).toContain("MCP and API requests are logged");
  expect(main).toContain("No MCP data is sold or used for advertising");
});

test("the footer links to both pages, and neither carries an ad", () => {
  expect(build).toContain('{ label: "Privacy", href: "/privacy" }');
  expect(build).toContain('{ label: "Terms", href: "/terms" }');
  expect(build).toMatch(/const ads = options\.path !== "\/" && !\(LEGAL_PATHS/);
});
