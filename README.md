# Crisphive Agent Examples

Runnable, end-to-end examples of building scheduling agents on the
[Crisphive Developer API](https://docs.crisphive.com) — REST (`/v1`) and MCP
(`https://api.crisphive.com/mcp`).

Every example runs against a **sandbox** (`chsk_test_` key): isolated test
data, safe to experiment, free to start. Get a key in two minutes at
[docs.crisphive.com](https://docs.crisphive.com) ("Get demo key"), or from
your dashboard under Settings → Developers → API keys.

## Examples

| Example | What it shows |
|---|---|
| [`examples/emergency-cascade`](examples/emergency-cascade) | The full dispatch flow: connect → book a job (quote → slots → confirm) → insert a P0 emergency and watch the cascade reschedule the board (preview → commit) — as plain REST calls **and** as a Claude agent driving the same tools over MCP. |

More examples land in `examples/<name>/` — each is self-contained with its own
README, dependencies, and run instructions.

## The three prompts

Connected via MCP (Claude, Cursor, ChatGPT, or any MCP client), these run
against a seeded sandbox out of the box — the same prompts you'll find on our
[Claude directory listing](https://claude.ai/directory/crisphive) and in the
[crisphive-mcp README](https://github.com/crisphive/crisphive-mcp):

1. *"Find 3 hours this week for a bike ride with my wife without risking any jobs."*
2. *"Emergency plumbing job now at 99 Bank St for David Okafor (613-555-0198) — show me what gets rescheduled."*
3. *"Schedule a 2-hour HVAC job at 145 Laurier Ave W tomorrow for Marie Tremblay, 613-555-0142."*

## Links

- API reference: https://docs.crisphive.com · OpenAPI: https://api.crisphive.com/developers/openapi.json
- MCP server: https://github.com/crisphive/crisphive-mcp
- SDKs: [Node](https://github.com/crisphive/crisphive-node) · [Python](https://github.com/crisphive/crisphive-python) · [Go](https://github.com/crisphive/crisphive-go) · [PHP](https://github.com/crisphive/crisphive-php) · [Ruby](https://github.com/crisphive/crisphive-ruby) · [Java](https://github.com/crisphive/crisphive-java) · [.NET](https://github.com/crisphive/crisphive-dotnet)

## License

MIT
