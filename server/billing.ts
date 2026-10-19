/**
 * Pay-as-you-go AI summaries of how a file changed.
 *
 * A signed-in account holds a prepaid balance (topped up through CoinPay) in a
 * ledger of signed micro-dollar amounts; the balance is their sum. Each summary is
 * priced at what the model call actually cost times a multiplier, and the multiplier
 * is the price experiment: every account is assigned once, deterministically, to
 * one arm, so a person always sees one price and the arms can be compared on
 * top-ups, summaries and revenue (GET /billing/experiment, admins only).
 *
 * The model is given only the changed hunks (src/diff.ts), never the whole file.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { diffLines, type Diff } from "../src/diff.ts";
import { HttpError, id, now, type Store, type User } from "./store.ts";

export const BILLING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS billing_ledger (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('topup','charge','refund')), amountMicros INTEGER NOT NULL, ref TEXT UNIQUE, arm TEXT, detail TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS billing_ledger_user ON billing_ledger(userId,createdAt);
  CREATE TABLE IF NOT EXISTS pricing_arms (userId TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, arm TEXT NOT NULL, assignedAt TEXT NOT NULL);
`;

/** The price experiment: each arm's multiple of the model's real cost. */
export const ARMS = { "2x": 2, "4x": 4 } as const;
export type Arm = keyof typeof ARMS;
const ARM_NAMES = Object.keys(ARMS) as Arm[];

/** Micro-dollars per token for each model the summaries may use (Anthropic list prices). */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
export const DEFAULT_MODEL = "claude-opus-5-5";
/** Longest text sent per side, and the most of the diff the model is shown. */
export const MAX_SOURCE = 400 * 1024;
const MAX_PROMPT_CHARS = 60_000;
const MAX_OUTPUT_TOKENS = 2_000;

export type Usage = { input_tokens: number; output_tokens: number };
/** One model call: the prompt in, the text and token usage out. Injected so tests never call the API. */
export type Summarize = (system: string, prompt: string) => Promise<{ text: string; usage: Usage; refused: boolean }>;

export function anthropicSummarizer(apiKey: string, model: string): Summarize {
  const client = new Anthropic({ apiKey });
  return async (system, prompt) => {
    const response = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      // A short abstract of a diff is simple work; low effort keeps the cost (and price) small.
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("").trim();
    return { text, usage: response.usage, refused: response.stop_reason === "refusal" };
  };
}

export const costMicros = (model: string, usage: Usage) => {
  const price = MODEL_PRICES[model] ?? MODEL_PRICES[DEFAULT_MODEL]!;
  return usage.input_tokens * price.input + usage.output_tokens * price.output;
};
export const priceMicros = (cost: number, arm: Arm) => Math.ceil(cost * ARMS[arm]);

export const SYSTEM = `You describe how a file changed between two versions, for its owner's history.
Write a one or two sentence abstract of what changed and what it means, then up to three short bullet points naming the specific changes (values, keys, functions, sections).
Be concrete and literal; say "values changed" rather than guessing why. Plain text, no heading, no preamble.`;

/** The prompt: the file's name, the size of the change, and its hunks, cut to a budget. */
export function prompt(path: string, diff: Diff): string {
  const head = `File: ${path}\nChange: +${diff.added} -${diff.removed} lines in ${diff.hunks.length} place(s).\n`;
  let body = "";
  let shown = 0;
  for (const hunk of diff.hunks) {
    const block = `@@ old line ${hunk.oldStart}, new line ${hunk.newStart}\n${hunk.removed.map((line) => `- ${line}`).join("\n")}${hunk.removed.length && hunk.added.length ? "\n" : ""}${hunk.added.map((line) => `+ ${line}`).join("\n")}\n`;
    if (body.length + block.length > MAX_PROMPT_CHARS) break;
    body += block;
    shown++;
  }
  const cut = shown < diff.hunks.length ? `\n(${diff.hunks.length - shown} more change(s) not shown.)\n` : "";
  return `${head}\n${body || "(The change is too large to show line by line.)\n"}${cut}`;
}

export class Billing {
  /** One summary at a time per account, so two requests cannot both spend the same balance. */
  private running = new Set<string>();
  constructor(private store: Store, private summarize: Summarize | null, readonly model = DEFAULT_MODEL) {
    store.db.exec(BILLING_SCHEMA);
  }

  /** The account's price arm, assigned on first use from its id so it never changes. */
  arm(user: User): Arm {
    const found = this.store.get<{ arm: string }>("SELECT arm FROM pricing_arms WHERE userId=?", user.id);
    if (found && found.arm in ARMS) return found.arm as Arm;
    const arm = ARM_NAMES[createHash("sha256").update(`readm3-price-v1:${user.id}`).digest()[0]! % ARM_NAMES.length]!;
    this.store.run("INSERT OR IGNORE INTO pricing_arms (userId,arm,assignedAt) VALUES (?,?,?)", user.id, arm, now());
    return arm;
  }

  balance(userId: string): number {
    return this.store.get<{ total: number | null }>("SELECT SUM(amountMicros) AS total FROM billing_ledger WHERE userId=?", userId)?.total ?? 0;
  }

  /** Adds money once per payment reference; a repeated webhook changes nothing. */
  credit(userId: string, amountMicros: number, ref: string, detail: string): boolean {
    const result = this.store.run(
      "INSERT OR IGNORE INTO billing_ledger (id,userId,kind,amountMicros,ref,arm,detail,createdAt) VALUES (?,?,?,?,?,NULL,?,?)",
      id(), userId, "topup", amountMicros, ref, detail, now(),
    );
    return result.changes > 0;
  }

  /** Takes money once per reference (storage charges it by the hour); false when already taken. */
  debit(userId: string, amountMicros: number, ref: string, detail: string): boolean {
    const result = this.store.run(
      "INSERT OR IGNORE INTO billing_ledger (id,userId,kind,amountMicros,ref,arm,detail,createdAt) VALUES (?,?,?,?,?,NULL,?,?)",
      id(), userId, "charge", -amountMicros, ref, detail, now(),
    );
    return result.changes > 0;
  }

  account(user: User) {
    const arm = this.arm(user);
    return {
      balanceMicros: this.balance(user.id),
      arm,
      multiplier: ARMS[arm],
      model: this.model,
      enabled: !!this.summarize,
      ledger: this.store.all<{ kind: string; amountMicros: number; detail: string; createdAt: string }>(
        "SELECT kind,amountMicros,detail,createdAt FROM billing_ledger WHERE userId=? ORDER BY createdAt DESC LIMIT 20", user.id,
      ),
    };
  }

  /** A rough upper bound for one summary, so an empty balance is refused before the call. */
  estimate(arm: Arm, promptText: string): number {
    const price = MODEL_PRICES[this.model] ?? MODEL_PRICES[DEFAULT_MODEL]!;
    return priceMicros(Math.ceil((promptText.length + SYSTEM.length) / 3) * price.input + 400 * price.output, arm);
  }

  async summary(user: User, args: Record<string, unknown>) {
    if (!this.summarize) throw new HttpError(503, "AI summaries are not configured on this server.");
    const path = typeof args.path === "string" && args.path.trim() ? args.path.trim().slice(0, 300) : "file";
    const before = args.before;
    const after = args.after;
    if (typeof before !== "string" || typeof after !== "string") throw new HttpError(400, "before and after must be the two versions' text.");
    if (before.length > MAX_SOURCE || after.length > MAX_SOURCE) throw new HttpError(413, "Each version may be up to 400 KB for a summary.");
    const diff = diffLines(before, after);
    if (!diff.hunks.length) throw new HttpError(400, "The two versions are the same.");
    const arm = this.arm(user);
    const text = prompt(path, diff);
    const estimate = this.estimate(arm, text);
    if (this.balance(user.id) < estimate) {
      throw new HttpError(402, `Not enough balance for a summary (about $${(estimate / 1e6).toFixed(4)}). Top up to continue.`);
    }
    if (this.running.has(user.id)) throw new HttpError(429, "A summary is already being written for this account.");
    this.running.add(user.id);
    let result: Awaited<ReturnType<Summarize>>;
    try { result = await this.summarize(SYSTEM, text); }
    catch { throw new HttpError(502, "The summary could not be written. You were not charged; try again."); }
    finally { this.running.delete(user.id); }
    // A declined request is not the customer's to pay for.
    if (result.refused || !result.text) throw new HttpError(422, "The model declined to summarize this change. You were not charged.");
    const cost = costMicros(this.model, result.usage);
    const charged = priceMicros(cost, arm);
    const ref = `summary:${id()}`;
    this.store.run(
      "INSERT INTO billing_ledger (id,userId,kind,amountMicros,ref,arm,detail,createdAt) VALUES (?,?,?,?,?,?,?,?)",
      id(), user.id, "charge", -charged, ref, arm, JSON.stringify({ path, model: this.model, costMicros: cost, input: result.usage.input_tokens, output: result.usage.output_tokens }), now(),
    );
    return { summary: result.text, chargedMicros: charged, costMicros: cost, arm, balanceMicros: this.balance(user.id), added: diff.added, removed: diff.removed };
  }

  /** The experiment so far, per arm: accounts assigned, how many paid, money in, summaries, model cost. */
  experiment() {
    return ARM_NAMES.map((arm) => {
      const row = this.store.get<{ accounts: number; payers: number; topups: number | null; summaries: number; charged: number | null; cost: number | null }>(
        `SELECT
          (SELECT COUNT(*) FROM pricing_arms WHERE arm=?1) AS accounts,
          (SELECT COUNT(DISTINCT l.userId) FROM billing_ledger l JOIN pricing_arms p ON p.userId=l.userId WHERE p.arm=?1 AND l.kind='topup') AS payers,
          (SELECT SUM(l.amountMicros) FROM billing_ledger l JOIN pricing_arms p ON p.userId=l.userId WHERE p.arm=?1 AND l.kind='topup') AS topups,
          (SELECT COUNT(*) FROM billing_ledger WHERE arm=?1 AND kind='charge') AS summaries,
          (SELECT -SUM(amountMicros) FROM billing_ledger WHERE arm=?1 AND kind='charge') AS charged,
          (SELECT SUM(json_extract(detail,'$.costMicros')) FROM billing_ledger WHERE arm=?1 AND kind='charge') AS cost`,
        arm,
      )!;
      return { arm, multiplier: ARMS[arm], accounts: row.accounts, payers: row.payers, topupMicros: row.topups ?? 0, summaries: row.summaries, chargedMicros: row.charged ?? 0, costMicros: row.cost ?? 0 };
    });
  }
}
