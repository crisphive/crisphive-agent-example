# Book a job, absorb an emergency — the Crisphive dispatch flow

The four beats of a real dispatch day, runnable against your sandbox in under
five minutes:

1. **Connect** — verify the key, read the roster and catalog.
2. **Book** — create a customer, request a job, quote it, pick a real slot,
   confirm. Every slot offered is a slot that exists.
3. **Emergency cascade** — a P0 no-heat call lands on a committed board.
   `listEmergencyCandidates` ranks who can absorb it, `preview` computes the
   whole ripple as data — which jobs slide, which reassign, what it costs —
   and **nothing moves until `commit`**. Preview is a pure function: run it
   twice, get the identical plan (the demo does exactly that).
4. **The impossible request** — ask for a slot that can't exist. The solver
   returns *no feasible slot* with the reasons instead of inventing an
   appointment. That's the difference between a solver and an LLM guessing.

Two ways to run it:

| Script | What it is |
|---|---|
| `npm run demo` | The four beats as plain `/v1` REST calls — deterministic, CI-tested, no LLM anywhere. Read this to learn the API. |
| `npm run agent` | The same flow driven by **Claude over MCP**: the Anthropic API connects server-side to `api.crisphive.com/mcp` with your sandbox key and runs the three prompts from our listing copy. Read this to learn what your agent can do. |

## Setup

```bash
cp .env.example .env   # fill in CRISPHIVE_API_KEY (chsk_test_...)
npm install
npm run demo           # REST flow — needs only the Crisphive key
npm run agent          # Claude agent — also needs ANTHROPIC_API_KEY
```

Get a sandbox key at [docs.crisphive.com](https://docs.crisphive.com) ("Get
demo key" — no signup form, arrives by email) or from your dashboard. A fresh
sandbox comes pre-seeded with a working roster, so the demo has technicians to
dispatch from the first run.

## What the output looks like

```text
── 3. Emergency cascade
   P0 created: no heat at 99 Bank St (David Okafor) — REQ #ABC123
   candidates: 3 ranked technicians (top: 2 moves, 14 min travel)
   preview: emergency lands 11:15–13:15 · 3 jobs touched, 0 dropped
     slide   #K7M2P1  Marie Tremblay   09:00→14:15
     reassign #QW84RD  install visit    → Priya S. (same window, +4 min travel)
   determinism: second preview identical ✓
   commit: board redrawn. Notifications drafted for every moved party.
```

## Notes for the reader

- **`chsk_test_` keys touch sandbox data only.** The same code runs live by
  swapping in a `chsk_live_` key — that is the entire mode switch.
- **Every mutating flow is preview → commit.** Your agent can show a human the
  plan before it changes the board; `commit` accepts `expected_move_ids` so a
  drifted board is rejected instead of silently rearranged.
- **Error codes are stable strings** (`JOB_REQUEST_STAGE_CONFLICT`,
  `API_KEY_EXPIRED`, …) — match codes, never message text.
- **Idempotency**: the create endpoints accept an `Idempotency-Key` header;
  retries replay the original response.
- For production agents, mint **365-day keys** and rotate with the two-key
  changeover (create second key → deploy → revoke first).

## Files

```
src/client.ts   tiny typed /v1 client (fetch + envelope handling, ~60 lines)
src/demo.ts     the four beats as REST calls
src/agent.ts    Claude + MCP connector running the listing prompts
```
