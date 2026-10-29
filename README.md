# @pipeworx/ny-omig-exclusions

New York State OMIG Medicaid provider exclusion screening — check a provider
by name, NPI or license number against the NY Office of the Medicaid
Inspector General's exclusion list, the state-level counterpart to the
federal HHS OIG LEIE (`leie` pack) for New York specifically.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ny_omig_check_exclusion(name?, npi?, license?, limit?)` — screens a
  provider against the ~9,100-row NY OMIG exclusion list. An NPI or license
  match is an **identification** (both are exact, provider-specific
  identifiers); a name match — even an exact one — is a **candidate lead
  only**, since OMIG's list carries no date of birth or address to tell
  same-named providers apart.
- `ny_omig_exclusion_coverage()` — total exclusions held, how many carry an
  NPI or license number, provider-type diversity, the oldest/newest exclusion
  date, and OMIG's own "data last updated" date for the baked copy this pack
  serves.

## Auth

Keyless.

## Data sources

- <https://apps.omig.ny.gov/exclusions/tabdelimited.aspx> — the full
  exclusion list as tab-delimited text (provider name, license number, NPI,
  provider type, exclusion effective date). No JSON/REST endpoint exists;
  this is the cleanest of OMIG's export formats (vs. a 6.5MB HTML "formatted
  list" for the same ~9,100 rows).
- <https://apps.omig.ny.gov/exclusions/shortlist.aspx> — the "last 30 days"
  HTML page, fetched only for its cheap "Data was last updated" banner
  (45KB vs. 6.5MB for the full formatted list).
- <https://apps.omig.ny.gov/exclusions/ex_search.aspx> — OMIG's own online
  search tool (up to 5 names at once), linked in every response as
  `online_search_url` for a caller who wants to verify directly.

### Why this is baked, not a live proxy

OMIG publishes the list only as flat files. Per root CLAUDE.md's standing
rule for exactly this shape, the table (~9,117 rows, ~1.3MB as generated
TypeScript) is baked by `scripts/bake-index.mjs` into
`src/ny-omig-index-data.ts`, registered in
`workers/gateway/src/pack-baked-indexes.json`, uploaded to KV at deploy, and
injected into every call as `args._bakedIndex` — never a static module-scope
import (fleet #2754: six packs doing that put ~48MB of retained heap into
every gateway isolate and cost about one call in four as a Cloudflare 1102).
A missing or malformed injection throws loudly rather than answering
"not found" — see `src/index.test.ts`.

Re-run `node mcps/ny-omig-exclusions/scripts/bake-index.mjs` periodically to
refresh the copy and recommit; `data_as_of` on every response says how stale
it is relative to OMIG's own "last updated" banner, so staleness is visible
rather than silent.

### What this data does NOT include

Every OMIG export — tab-delimited, Excel, and the HTML formatted list —
carries only provider name, license number, NPI, provider type and the
exclusion effective date. There is **no exclusion reason, statutory
authority or case citation** in this data, unlike the federal LEIE's
statutory exclusion-type code. Per-record detail, if OMIG holds any, sits
behind an ASP.NET VIEWSTATE postback tied to a freshly-loaded search
session rather than a stable queryable endpoint, and was not pursued for
this first cut. Every response says this plainly rather than inventing a
field OMIG does not publish.

### Reachability

Verified live 2026-10-07 from both a laptop curl and a throwaway
`wrangler dev --remote` Worker on the prod account: identical `200` /
535,395 bytes from the Cloudflare edge on `tabdelimited.aspx`. Unlike
`oklahoma-code` / `utah-code` / `new-hampshire-code`, this host needs no
Supabase egress relay.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ny-omig-exclusions": {
      "url": "https://gateway.pipeworx.io/ny-omig-exclusions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ny-omig-exclusions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ny_omig_check_exclusion \
  -H 'Content-Type: application/json' \
  -d '{"name":"1 STOP PHARMACY AND FOOD MART INC"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ny_omig_check_exclusion`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-ny-omig-exclusions` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/ny-omig-exclusions/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "ny-omig-exclusions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ny-omig-exclusions"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ny Omig Exclusions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
