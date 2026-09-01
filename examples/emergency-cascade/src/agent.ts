// The same dispatch flow, driven by a Claude agent over MCP.
//
// No tool loop to write: the Anthropic API's MCP connector talks to
// https://api.crisphive.com/mcp server-side, authenticated with your own
// sandbox key. Claude picks the tools (listEmergencyCandidates →
// previewEmergencyReschedule → commitEmergencyReschedule, createCustomer →
// createJobRequest → quote → confirm, ...) exactly as it would from
// claude.ai or Claude Code.
//
// The three prompts are the ones from our Claude-directory listing — they
// run against a seeded sandbox out of the box.
//
// Needs: CRISPHIVE_API_KEY (chsk_test_) + ANTHROPIC_API_KEY
//        + ANTHROPIC_MODEL + ANTHROPIC_MAX_TOKENS (both REQUIRED — see below).

import Anthropic from "@anthropic-ai/sdk";

const BASE = (process.env.CRISPHIVE_API_URL ?? "https://api.crisphive.com").replace(/\/$/, "");
const CRISPHIVE_KEY = process.env.CRISPHIVE_API_KEY ?? "";

// The spend knobs are REQUIRED — no silent default. Each prompt is a
// multi-turn conversation where the MCP connector re-sends the whole context
// + every tool result on every turn, so model choice and the per-turn token
// cap are the bill. The person paying picks them, deliberately.
function requiredEnv(name: string, hint: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} — ${hint}`);
  return v;
}
const MODEL = requiredEnv(
  "ANTHROPIC_MODEL",
  'e.g. "claude-sonnet-5" (good default) or "claude-haiku-4-5" (cheapest); "claude-opus-5" is the expensive one',
);
const MAX_TOKENS = Number(
  requiredEnv("ANTHROPIC_MAX_TOKENS", "per-turn output cap, e.g. 4000"),
);
if (!Number.isInteger(MAX_TOKENS) || MAX_TOKENS < 1) {
  throw new Error(`ANTHROPIC_MAX_TOKENS must be a positive integer, got "${process.env.ANTHROPIC_MAX_TOKENS}"`);
}
// Optional: pause_turn continuations per prompt (the eval runner's
// EVAL_MAX_TURNS sibling) — each continuation re-sends the whole context.
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS ?? "8");
if (!Number.isInteger(MAX_TURNS) || MAX_TURNS < 1) {
  throw new Error(`AGENT_MAX_TURNS must be a positive integer, got "${process.env.AGENT_MAX_TURNS}"`);
}

const PROMPTS = [
  'Schedule a 2-hour HVAC job at 145 Laurier Ave W tomorrow for Marie Tremblay, 613-555-0142.',
  'Emergency plumbing job now at 99 Bank St for David Okafor (613-555-0198) — show me what gets rescheduled. Preview first, then commit.',
  'Find 3 hours this week for a bike ride with my wife without risking any jobs.',
];

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

async function runPrompt(prompt: string) {
  console.log(`\n════ PROMPT ════\n${prompt}\n`);
  let messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];

  // Server-side MCP tools loop until done; `pause_turn` means the server-side
  // tool loop hit its iteration limit — resend to resume where it left off.
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: ["mcp-client-2025-11-20"],
      mcp_servers: [
        {
          type: "url",
          url: `${BASE}/mcp`,
          name: "crisphive",
          authorization_token: CRISPHIVE_KEY, // chsk_test_ ⇒ sandbox only
        },
      ],
      tools: [{ type: "mcp_toolset", mcp_server_name: "crisphive" }],
      messages,
    });

    for (const block of response.content) {
      if (block.type === "text") {
        console.log(block.text);
      } else if (block.type === "mcp_tool_use") {
        console.log(`   🔧 ${block.name}(${JSON.stringify(block.input).slice(0, 160)})`);
      }
    }

    if (response.stop_reason === "pause_turn") {
      messages = [...messages, { role: "assistant", content: response.content }];
      continue;
    }
    if (response.stop_reason === "refusal") {
      console.log("   (the model declined this request — see stop_details)");
    }
    return;
  }
  console.log(`   (stopped after ${MAX_TURNS} continuation turns)`);
}

async function main() {
  // SANDBOX ONLY: the prompts book jobs and commit an emergency reschedule.
  // A chsk_live_ key would let the agent mutate a real business's schedule.
  if (!CRISPHIVE_KEY.startsWith("chsk_test_")) {
    throw new Error(
      "Set CRISPHIVE_API_KEY to a chsk_test_ SANDBOX key (see .env.example) — the prompts mutate data, so live keys are refused.",
    );
  }
  for (const prompt of PROMPTS) {
    await runPrompt(prompt);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
