# Demo video

2m 29s. Chapters below are the real scene marks from the recording.

---

## Title

```
DataSweep Pro — a local-first execution environment for AI data agents (WebMCP)
```

Alternatives, if you want something shorter or punchier:

```
DataSweep Pro — 15 WebMCP tools, one surface for agents and humans
```
```
An AI agent cleaned my spreadsheet — and couldn't write a single row without me
```

---

## Description

```
DataSweep Pro is a data cleaning studio where an AI agent and a person work on
the same messy spreadsheet through the same 15 WebMCP tools. Every change the
agent proposes is previewed against real tables, approved by a human,
attributed, and reversible.

Data processing runs locally in your browser — the file is parsed and queried by
DuckDB compiled to WebAssembly, in the tab, and is never uploaded. External
communication is opt-in and separately gated.

── How WebMCP is used ──────────────────────────────

• 15 tools registered on document.modelContext via @mcp-b/global
• The UI and the agent call the identical registered tool — there is no separate
  "agent path" that could behave differently from the buttons
• A live Tool Inspector renders each tool's JSON Schema from the same object
  that was registered, so what you inspect cannot drift from what an agent sees
• Bridgeable to Claude Code / Claude Desktop via @mcp-b/webmcp-local-relay
• Calls arriving over document.modelContext are attributed to an external MCP
  client in the audit ledger, not to the user

── Chapters ────────────────────────────────────────

0:00  One tool surface, four callers
0:14  Loading a messy CSV — 8 quality checks, on device
0:30  The WebMCP surface: 15 tools and their live schemas
0:53  An agent proposes a write — and is stopped by the approval gate
1:20  Approved, applied, attributed, reversible
1:40  Prompt injection: cell values are data, never instructions
1:59  Publishing to a pull request — the one path off the machine
2:17  Light, dark, or system

── The security model ──────────────────────────────

• Two-phase confirmation — a mutating tool called without a token runs against
  scratch tables, measures what changed, drops them, and returns a token bound
  to those exact arguments. Single-use and expiring. The agent never sees it.
• Quarantine — cell content leaves every tool inside a fence carrying a
  per-call random nonce, so injected text cannot escape into the instruction
  region. Structural, so it holds for payloads no rule matches.
• Identifier allowlist — table names are minted, never derived from input;
  columns are validated by membership in the live schema.
• No WebMCP tool can reach the GitHub export. The button is the only entry.

380 tests, including integration and security-eval suites running real
DuckDB-Wasm through its Node bindings — not a mock database.

Built with Vite, React 19, TypeScript, Tailwind v4, DuckDB-Wasm and @mcp-b/global.

Source: https://github.com/Unknown1502/DataSweep-Pro
```

---

## Tags

```
WebMCP, MCP, Model Context Protocol, DuckDB, WebAssembly, AI agents, data cleaning,
local-first, prompt injection, human in the loop, browser tools, agentic web
```

Category: **Science & Technology** · Language: **English** · Visibility: **Public**
(the challenge requires a public link)

---

## Reproducing the video

The `demo/` directory holds the pipeline. It is not committed — the frames alone
run to several hundred megabytes — so regenerate it rather than expecting it in
a clone.

```bash
npm run dev -- --port 5190      # the recording targets this port
cd demo
node voice.mjs                  # narration, needs ELEVENLABS_API_KEY in demo/.env.local
node record.mjs                 # drives a throwaway browser, captures frames
node assemble.mjs               # muxes to datasweep-demo.mp4
```

Notes worth keeping:

- **Its own browser.** `record.mjs` launches Chrome against a throwaway profile.
  A fresh profile raises no "Allow remote debugging?" prompt, and nothing from a
  real browser — tabs, history, accounts — can appear in a public video.
- **Frames, not screen.** Capture is `Page.captureScreenshot` over CDP with four
  requests in flight, which measured 29.6 fps against 5.3 fps serially; the
  encode is the bottleneck, so overlapping requests hides it.
  `Page.startScreencast` is the natural API here and was tried first — it
  delivered 0–1 frames in every configuration on this machine.
- **Ordering.** Overlapping requests return out of order, so each frame is
  stamped on arrival and the set is sorted by time before encoding.
- **Sync.** The driver logs when each scene actually began; narration clips are
  delayed to those measured marks, so automation latency cannot drift the audio.
- **No truncation.** The recorder holds the last frame until the narration is
  fully covered plus a tail, because an earlier build ended 3s early and
  `-shortest` cut the final sentence mid-word.

Nothing in the video is staged: the quality scores, row counts, tool schemas and
manifest hashes are produced live by the application during the take.
