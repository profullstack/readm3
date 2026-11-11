/**
 * readm3.com/privacy and readm3.com/terms, as static pages in the site shell.
 *
 * Every sentence here is meant to be true of the code in this repository: what
 * an account stores (server/accounts.ts, server/profile.ts), what is end-to-end
 * encrypted (src/sync-crypto.ts), who is called (Resend, CoinPay, the AI
 * providers in server/billing.ts, ElevenLabs), and what the hosted MCP server
 * and the stdio one can reach. Change the code, change this page.
 */

export const LEGAL_EFFECTIVE_DATE = "November 11, 2026";
export const LEGAL_PATHS = ["/privacy", "/terms"] as const;

const OPERATOR = "Profullstack, Inc., 16375 Bonnie Lane, Los Gatos, CA 95032, USA";
const CONTACT = "support@profullstack.com";
const contact = `<a href="mailto:${CONTACT}">${CONTACT}</a>`;

function hero(title: string, lede: string): string {
  return `<section class="hero hero-tight">
  <p class="eyebrow">Legal</p>
  <h1>${title}</h1>
  <p class="lede">Effective date: ${LEGAL_EFFECTIVE_DATE}. ${lede}</p>
</section>`;
}

export function privacyMain(site: string): string {
  return `${hero("Privacy Policy", "What readm3 stores, why, and who else is involved.")}
<section class="section legal">
<p>This policy covers readm3.com, its API and MCP server, and the data the readm3 CLI, desktop app and installable web app send to it. readm3 is run by ${OPERATOR}.</p>

<h2>1. Without an account</h2>
<p>The editor works in your browser without an account. Documents you open or write there are kept in your browser's own storage on your device, or saved straight back to a folder you opened from disk, and are not sent to us. They reach our server only when you choose to save to a workspace, share, paste, sync or ask AI about them, as described below.</p>
<p><strong>Pastes.</strong> A paste stores the text or file you send, its title, detected language, size and expiry. Only a hash of the paste's secret link is kept, so a paste cannot be listed or found without the link. Every paste expires (1 hour to 30 days, 7 days by default) and is then deleted, and anyone with the link can delete it sooner.</p>
<p><strong>The document reader</strong> (<code>/api/v1/read</code> and the hosted MCP server) fetches the URL you give it from the public web and returns its text. Requests are counted per IP address for the free hourly allowance.</p>

<h2>2. What an account stores</h2>
<ul>
<li><strong>Your email address</strong>, which is how you sign in: we email you a link, and there is no password. Pending sign-in links are stored only as a hash and expire after 15 minutes.</li>
<li><strong>Your profile:</strong> username and display name, and the profile fields you fill in (first and last name, company domain, job title, LinkedIn URL). Profile fields are private to your account.</li>
<li><strong>Sessions and tokens:</strong> a hash of each browser session, API token and CLI sign-in (OAuth) token, with its label and expiry. Sessions last 30 days.</li>
<li><strong>Linked CoinPay account</strong>, if you sign in with CoinPay: the identifier and email CoinPay gives us, a record of link and sign-in events, and whether you hold an active Profullstack Pass.</li>
<li><strong>Workspace documents:</strong> documents saved to an organization, every saved version with its author, view and edit links (stored as hashes), permissions, organizations, teams, members and invitations.</li>
<li><strong>Synced files and stored files</strong> are end-to-end encrypted on your device with a key derived from your sync passphrase, which never leaves the device. We store the sealed data, its size and revision, and the name of the device that saved it, and cannot read the contents or file names. The same applies to the version history of synced files.</li>
<li><strong>Settings</strong> you sync between devices.</li>
<li><strong>AI summaries, answers and audio</strong> you ask for, kept on your account so asking again is free, with the model used and what it cost.</li>
<li><strong>Billing:</strong> your prepaid balance as a ledger of top-ups and charges, and each top-up's payment reference, amount, chain and status.</li>
</ul>
<p>Sign-in requests are rate-limited using a hash of your IP address and email address, kept only until the limit window expires.</p>

<h2>3. Cookies and browser storage</h2>
<p>Signing in sets one session cookie. It is HttpOnly, SameSite=Lax and Secure, so scripts cannot read it and it is not sent on cross-site requests. Signing in with CoinPay sets a short-lived cookie that ties the round trip together. The editor keeps your local documents and preferences in your browser's storage on your device. readm3 sets no advertising cookies of its own.</p>

<h2>4. Who else is involved</h2>
<ul>
<li><strong>Resend</strong> delivers sign-in emails, so it processes your email address.</li>
<li><strong>CoinPay</strong> (coinpayportal.com) handles Sign in with CoinPay, top-ups (any supported coin, or PayPal, on CoinPay's checkout page) and x402 reader and crawl passes. We receive the payment status and amount, not your wallet keys or PayPal details.</li>
<li><strong>AI providers.</strong> When you ask for a summary or ask AI a question, the text you send (the document, the changed lines of a file, or the files you pick, cut to a budget) goes to c0mpute, Anthropic (Claude) or OpenAI to write the answer. PDFs and images go only to Anthropic or OpenAI.</li>
<li><strong>ElevenLabs</strong> turns a summary into audio when you press Listen; it receives the summary text.</li>
<li><strong>CrawlProof</strong> (crawlproof.com) supplies page statistics on the site's public pages and the ad unit on its inner pages.</li>
<li><strong>jsDelivr</strong> serves the WebMCP script on the site's public pages, which offers readm3's tools to an AI agent running in your browser.</li>
<li><strong>Sites you ask the reader to fetch</strong> see a request from our server, not from you.</li>
</ul>
<p>Scripts loaded from other services receive your IP address and browser details when your browser loads them. Nothing is sold, and no advertising profile is built from you.</p>

<h2>5. What is public</h2>
<p>Nothing you store is public by default. A paste, a shared document or a shared version can be read by anyone who has its link, and share pages are marked noindex. Workspace documents are visible to the people and teams you share them with.</p>

<h2>6. AI agents and MCP</h2>
<p>The hosted MCP server is at <code>${site}/mcp</code> (Streamable HTTP, no login). It has one read-only tool, <code>read_url</code>, which returns the text of a public document at a URL. It needs no account: there is a free hourly allowance per IP address, then an x402 reader pass paid through CoinPay; a signed-in account's session or API token reads without the hourly allowance.</p>
<p>The stdio MCP server (<code>readm3 mcp</code>, in the CLI) acts on your account with the API token or <code>readm3 login</code> token you give it. Besides pastes and reading, it can list, read, create, update, share and delete your workspace documents and versions, and manage organizations, teams, members, invitations, permissions, tokens and settings, always with the same permissions you have on the web.</p>
<p>MCP and API requests are logged (time, tool or route, IP address, and the account or token if any) for abuse prevention and rate limiting. No MCP data is sold or used for advertising.</p>

<h2>7. Keeping and deleting it</h2>
<p>Pastes are deleted when they expire. Synced history keeps a limited number of recent revisions and versions per file. Everything else is kept while your account exists, and you can delete documents, shares, tokens and stored files yourself. To delete your account and everything attached to it, email ${contact} from the address you signed up with.</p>

<h2>8. Security</h2>
<p>Data travels over TLS. Sessions, tokens, sign-in links and share links are stored only as hashes, and synced files only as ciphertext. No system is perfectly secure, and we cannot guarantee absolute security.</p>

<h2>9. Children</h2>
<p>readm3 is not directed at children under 13, and we do not knowingly collect personal information from them.</p>

<h2>10. Your rights</h2>
<p>Depending on where you live, you may have the right to access, correct, delete or export your personal data. Contact us to exercise them.</p>

<h2>11. Changes</h2>
<p>If readm3 changes what it collects, this page changes with it. The effective date above says when it last did.</p>

<h2>12. Contact</h2>
<p>${OPERATOR}. Email ${contact}.</p>
</section>`;
}

export function termsMain(site: string): string {
  return `${hero("Terms of Service", "The terms for using readm3, its API and its MCP server.")}
<section class="section legal">
<h2>1. Acceptance of terms</h2>
<p>By using readm3.com, its API, MCP server, CLI or apps (the "Service"), run by ${OPERATOR}, you agree to these Terms of Service. If you do not agree, do not use the Service.</p>

<h2>2. The Service</h2>
<p>readm3 is for writing, reading and sharing Markdown and other documents: an editor, pastes, shared workspaces, sync, a document reader, AI summaries and answers, a CLI, an API and MCP servers. The editor and pastes need no account. An account is free; some features are paid as you go from a prepaid balance.</p>

<h2>3. Accounts</h2>
<p>Your account is your email address or linked CoinPay account. You are responsible for keeping that inbox, your API tokens, your sync passphrase and anything signed in with them safe, and for all activity under your account. We cannot recover a lost sync passphrase, because we never have it. Tell us at once if you think someone else is using your account.</p>

<h2>4. Payments</h2>
<p>Top-ups, reader passes and crawl passes are paid through CoinPay, in cryptocurrency or PayPal on CoinPay's checkout. A top-up adds to a prepaid balance that is charged for what you use at the prices shown in the Service.</p>

<h2>5. Your content</h2>
<p>You keep the rights you have in what you write, paste or upload. You allow us to store, process and show it as needed to run the Service for you, including sending it to an AI provider when you ask for a summary or an answer, and showing it to the people you share it with. You confirm you have the right to share whatever you share, and you are responsible for who has your links.</p>

<h2>6. Acceptable use</h2>
<p>Do not use the Service for anything unlawful, to distribute malware, to infringe someone else's rights, or to harass anyone. Do not use it to bypass access controls on the documents you ask the reader to fetch. Do not send automated traffic heavy enough to degrade the Service for anyone else. AI training crawlers and scrapers must buy a crawl pass, as the site explains when they arrive.</p>

<h2>7. MCP and API use</h2>
<p>The same rules apply to the API and the MCP servers, including the hosted one at <code>${site}/mcp</code>. An agent using your token acts as you, and what it does is your responsibility. Requests are rate-limited, the free reader allowance is per IP address, and tokens used for abuse may be revoked.</p>

<h2>8. Intellectual property</h2>
<p>The readm3 name, site and service belong to Profullstack, Inc. or its licensors. The readm3 software is open source under the MIT license; open-source components are governed by their own licenses.</p>

<h2>9. Disclaimer of warranties</h2>
<p>The Service is provided "as is" without warranties of any kind. We do not guarantee that it will be uninterrupted, secure or error-free, or that AI summaries and answers are accurate.</p>

<h2>10. Limitation of liability</h2>
<p>To the maximum extent permitted by law, Profullstack, Inc. shall not be liable for any indirect, incidental, special, consequential or punitive damages arising out of your use of the Service.</p>

<h2>11. Changes to these terms</h2>
<p>We may update these Terms from time to time. Continued use of the Service after a change means you accept the revised Terms.</p>

<h2>12. Contact</h2>
<p>Questions about these Terms? Email ${contact}.</p>
</section>`;
}
