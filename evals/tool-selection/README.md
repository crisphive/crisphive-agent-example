# Tool-selection eval

Does an agent connected to the [Crisphive MCP server](https://github.com/crisphive/crisphive-mcp)
pick the **right tools, in the right order**? This eval never grades the
model's prose — only the trace of `mcp_tool_use` calls it actually made.

Ten seed questions live in [`questions.json`](./questions.json). Each runs as a
fresh conversation; the runner records the ordered tool-call trace and scores
it deterministically against the question's `expect` rules:

| Rule | Meaning |
|---|---|
| `all_of` | every named tool must appear at least once |
| `any_of` | at least one named tool must appear |
| `none_of` | no named tool may appear — `"@mutations"` expands to every state-changing tool (previews are pure and excluded) |
| `before` | `[a, b]`: **if** `b` was called, `a`'s first call must precede it — vacuously true when `b` never fires, so a preview-only run still passes |

The `before` rule is the one that matters most here: *preview before commit*
is the discipline the Crisphive scheduler is built around, and it is exactly
the kind of thing an agent silently gets wrong.

## Run it

```bash
npm install
CRISPHIVE_API_KEY=chsk_test_... ANTHROPIC_API_KEY=sk-ant-... \
  ANTHROPIC_MODEL=claude-sonnet-5 ANTHROPIC_MAX_TOKENS=4000 npm run eval

# a subset, or a JSON trace report:
npm run eval -- --only bike-ride-read-only,emergency-preview-before-commit
npm run eval -- --out results.json
```

**`ANTHROPIC_MODEL` and `ANTHROPIC_MAX_TOKENS` are required — there is no
default.** A full run is 10+ multi-turn conversations and the MCP connector
re-sends the whole context plus every tool result on every turn, so the model
tier and the per-turn cap ARE the bill. Pick them deliberately
(`claude-haiku-4-5` cheapest → `claude-sonnet-5` → `claude-opus-5` most
expensive). `EVAL_MAX_TURNS` (default 6) bounds pause_turn continuations per
question.

⚠️ The questions **mutate the sandbox** (bookings, an emergency commit, a new
technician) — the runner refuses anything but a `chsk_test_` key. Exit code is
non-zero when any question fails, so it slots into CI as-is; note the model is
non-deterministic, so treat a single failure as a lead to read the trace, not
as a verdict.

## Adding questions

Append to `questions.json` — no code change needed unless you need a new rule
type. Keep expectations about **selection and ordering**, not about outcomes
(the sandbox's state varies between runs); when a question should be
read-only, say so in the prompt (the way `bike-ride-read-only` does) so the
eval measures instruction-following rather than ambiguity.
