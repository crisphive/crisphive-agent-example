// Tool-selection eval runner.
//
// For each seed question, run a FRESH Claude conversation against the
// Crisphive MCP server (the Anthropic API's MCP connector — no tool loop to
// write), record the ORDERED list of tool calls the model actually made, and
// score that trace against the question's `expect` rules. The model's prose
// is never judged — only which tools it reached for, and in what order.
//
// Scoring is deterministic over the trace:
//   all_of   every named tool appears at least once
//   any_of   at least one named tool appears
//   none_of  no named tool appears ("@mutations" = every state-changing tool)
//   before   [a, b]: IF b was called, a's first call precedes b's first call
//            (vacuously true when b never fires — a preview-only run passes)
//
// Needs: CRISPHIVE_API_KEY (chsk_test_ — questions DO mutate the sandbox)
//        + ANTHROPIC_API_KEY
//        + ANTHROPIC_MODEL (required, no default — you pick what you pay for)
//        + ANTHROPIC_MAX_TOKENS (required — per-turn output cap, e.g. 4000)
//        + EVAL_MAX_TURNS (optional, default 6 — pause_turn continuations)
//
// Usage: ANTHROPIC_MODEL=claude-sonnet-5 ANTHROPIC_MAX_TOKENS=4000 npm run eval
//        npm run eval -- --only book-basic,bike-ride-read-only
//        npm run eval -- --out results.json

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.CRISPHIVE_API_URL ?? "https://api.crisphive.com").replace(/\/$/, "");
const CRISPHIVE_KEY = process.env.CRISPHIVE_API_KEY ?? "";

// The spend knobs are REQUIRED — no silent default. A 10-question run on an
// expensive model with a fat token budget is real money (the MCP connector
// re-sends the whole conversation + every tool result on every turn), so the
// person paying picks the model and the budget, deliberately.
function requiredEnv(name: string, hint: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} — ${hint}`);
  return v;
}
const MODEL = requiredEnv(
  "ANTHROPIC_MODEL",
  'e.g. "claude-sonnet-5" (recommended for evals) or "claude-haiku-4-5"; "claude-opus-5" is the expensive one',
);
const MAX_TOKENS = Number(
  requiredEnv("ANTHROPIC_MAX_TOKENS", "per-turn output cap, e.g. 4000 — tool selection needs no essays"),
);
if (!Number.isInteger(MAX_TOKENS) || MAX_TOKENS < 1) {
  throw new Error(`ANTHROPIC_MAX_TOKENS must be a positive integer, got "${process.env.ANTHROPIC_MAX_TOKENS}"`);
}
// Optional: how many pause_turn continuations before giving up on a question.
const MAX_TURNS = Number(process.env.EVAL_MAX_TURNS ?? "6");
if (!Number.isInteger(MAX_TURNS) || MAX_TURNS < 1) {
  throw new Error(`EVAL_MAX_TURNS must be a positive integer, got "${process.env.EVAL_MAX_TURNS}"`);
}

// Every tool that changes state. Previews (previewJobRequestMove,
// previewEmergencyReschedule) are pure by design and deliberately absent.
const MUTATIONS = [
  "createCustomer",
  "updateCustomer",
  "deleteCustomer",
  "createJobRequest",
  "quoteJobRequest",
  "confirmJobRequest",
  "updateJobPriority",
  "commitEmergencyReschedule",
  "commitJobRequestMove",
  "createTechnician",
  "updateTechnician",
  "deleteTechnician",
  "replaceTechnicianSkills",
  "replaceTechnicianBuddies",
  "replaceTechnicianLeads",
  "replaceTechnicianVehicles",
  "replaceTechnicianServiceAreas",
];

interface Expect {
  all_of?: string[];
  any_of?: string[];
  none_of?: string[];
  before?: [string, string][];
}
interface Question {
  id: string;
  prompt: string;
  expect: Expect;
  notes?: string;
}
interface RuleResult {
  rule: string;
  pass: boolean;
  detail: string;
}
interface QuestionResult {
  id: string;
  pass: boolean;
  trace: string[];
  rules: RuleResult[];
  error?: string;
}

const expandMacros = (names: string[]): string[] =>
  names.flatMap((n) => (n === "@mutations" ? MUTATIONS : [n]));

function score(expect: Expect, trace: string[]): RuleResult[] {
  const results: RuleResult[] = [];
  const first = (tool: string) => trace.indexOf(tool);

  for (const tool of expect.all_of ?? []) {
    results.push({
      rule: `all_of ${tool}`,
      pass: trace.includes(tool),
      detail: trace.includes(tool) ? "called" : "never called",
    });
  }
  if (expect.any_of?.length) {
    const hit = expect.any_of.find((t) => trace.includes(t));
    results.push({
      rule: `any_of [${expect.any_of.join(", ")}]`,
      pass: !!hit,
      detail: hit ? `called ${hit}` : "none called",
    });
  }
  for (const tool of expandMacros(expect.none_of ?? [])) {
    if (trace.includes(tool)) {
      results.push({ rule: `none_of ${tool}`, pass: false, detail: "CALLED — forbidden" });
    }
  }
  if (expect.none_of?.length && !results.some((r) => r.rule.startsWith("none_of"))) {
    results.push({
      rule: `none_of [${expect.none_of.join(", ")}]`,
      pass: true,
      detail: "no forbidden tool called",
    });
  }
  for (const [a, b] of expect.before ?? []) {
    const ia = first(a);
    const ib = first(b);
    if (ib === -1) {
      results.push({ rule: `before ${a}→${b}`, pass: true, detail: `${b} never called (vacuous)` });
    } else if (ia === -1) {
      results.push({ rule: `before ${a}→${b}`, pass: false, detail: `${b} called without ${a}` });
    } else {
      results.push({
        rule: `before ${a}→${b}`,
        pass: ia < ib,
        detail: ia < ib ? "order held" : `${b} came first`,
      });
    }
  }
  return results;
}

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

/** One fresh conversation; returns the ordered tool-call trace. */
async function runQuestion(q: Question): Promise<string[]> {
  const trace: string[] = [];
  let messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: q.prompt }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: ["mcp-client-2025-11-20"],
      mcp_servers: [
        { type: "url", url: `${BASE}/mcp`, name: "crisphive", authorization_token: CRISPHIVE_KEY },
      ],
      tools: [{ type: "mcp_toolset", mcp_server_name: "crisphive" }],
      messages,
    });

    for (const block of response.content) {
      if (block.type === "mcp_tool_use") {
        trace.push(block.name);
        console.log(`      🔧 ${block.name}`);
      }
    }
    if (response.stop_reason === "pause_turn") {
      messages = [...messages, { role: "assistant", content: response.content }];
      continue;
    }
    return trace;
  }
  console.log(`      (stopped after ${MAX_TURNS} continuation turns)`);
  return trace;
}

async function main() {
  if (!CRISPHIVE_KEY.startsWith("chsk_test_")) {
    throw new Error(
      "Set CRISPHIVE_API_KEY to a chsk_test_ SANDBOX key — the eval questions mutate data.",
    );
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const seeds = JSON.parse(readFileSync(join(here, "..", "questions.json"), "utf8")) as {
    questions: Question[];
  };

  const args = process.argv.slice(2);
  const onlyArg = args.indexOf("--only");
  const only = onlyArg !== -1 ? new Set(args[onlyArg + 1]!.split(",")) : null;
  const outArg = args.indexOf("--out");
  const outPath = outArg !== -1 ? args[outArg + 1]! : null;

  const questions = seeds.questions.filter((q) => !only || only.has(q.id));
  if (questions.length === 0) throw new Error("--only matched no question ids");

  const results: QuestionResult[] = [];
  for (const q of questions) {
    console.log(`\n── ${q.id}`);
    console.log(`   "${q.prompt}"`);
    try {
      const trace = await runQuestion(q);
      const rules = score(q.expect, trace);
      const pass = rules.every((r) => r.pass);
      results.push({ id: q.id, pass, trace, rules });
      for (const r of rules) {
        console.log(`   ${r.pass ? "✅" : "❌"} ${r.rule} — ${r.detail}`);
      }
    } catch (e) {
      // An API error is a FAILED question, not a crashed eval — the other
      // questions still deserve their run.
      results.push({ id: q.id, pass: false, trace: [], rules: [], error: String(e) });
      console.log(`   ❌ run error: ${e}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n════ ${passed}/${results.length} questions passed ════`);
  for (const r of results) {
    console.log(`   ${r.pass ? "✅" : "❌"} ${r.id}  [${r.trace.join(" → ") || "no tools called"}]`);
  }
  if (outPath) {
    writeFileSync(outPath, JSON.stringify({ model: MODEL, when: new Date().toISOString(), results }, null, 2));
    console.log(`\nTrace report written to ${outPath}`);
  }
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
