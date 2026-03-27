---
name: sdr-agent-local-skill
description: Run multi-turn SDR agent tests locally from a curl or request template, drive simulated customer and scoring with a configurable local LLM command such as Claude Code or another CLI model tool, and output markdown/json reports.
---

# SDR Agent Local Skill

Use this skill when you need a pure local SDR test runner without a frontend.

## What it does

- Accepts natural-language testing intent from the user, then turns it into an executable local test plan
- Reads a config JSON file when deterministic execution is needed
- Replays a target SDR request from a `curl` or direct request template
- Runs multiple test directions, `N` sessions per direction, and `K` turns per session
- Uses a configurable local model command for customer simulation and scoring
- Writes a Markdown report and a JSON report under `reports/`
- Stops immediately on key failures by default, so it does not waste time empty-running after an upstream issue

Built-in driver presets:

- `codex`: uses `codex exec` non-interactively
- `claude`: uses `claude -p` non-interactively
- `openclaw`: reserved for custom OpenClaw command wiring; provide `command` or `shellCommand` if your local install differs

## Project shape

- `examples/task.example.json`: example input
- `examples/task-brief.example.md`: example natural-language brief
- `src/index.mjs`: CLI entry
- `src/driver.mjs`: local LLM command driver
- `src/sdrProxy.mjs`: SDR request proxy and官网客服 WebIM handling
- `src/report.mjs`: report writer

## Run

From this project root:

```bash
node src/index.mjs --config examples/task.example.json
```

Or run directly from a natural-language brief:

```bash
node src/index.mjs --brief examples/task-brief.example.md
```

Or:

```bash
npm run test -- --config examples/task.example.json
```

When this skill is used through an AI assistant, prefer the following workflow:

1. Read the user's natural-language request
2. Extract the testing target, conversation directions, loops, turns, curl/request template, and driver choice
3. Materialize a temporary JSON config under this project
4. Run the CLI
5. Return the report path and the key findings

The user does not need to hand-write strict JSON if the assistant can infer the parameters safely.

## Config notes

- `directions` supports multiple testing directions; each item can be either a string or an object
- `--brief` supports a natural-language task note with sections such as 目标, 测试参数, 用户画像, 历史背景, 测试方向, and 目标请求 curl
- Prefer `curl` when the upstream request is easiest to copy from browser DevTools
- Use `driver` for a shared local model command
- Use `simulationDriver` or `scoringDriver` only when they differ from the default driver
- If no driver is provided, the runner will auto-detect `codex`, then `claude`, then `openclaw`
- If `driver.preset` is `codex` or `claude`, the runner will automatically fill the recommended non-interactive CLI parameters
- `--driver-preset codex|claude|openclaw` can override the file when you want to switch the local AI driver quickly
- If your local CLI needs a shell pipeline, use `shellCommand` and read the prompt from env var `SDR_PROMPT`
- If your local CLI accepts prompt via stdin, use `command` + `args` + `promptMode: "stdin"`
- `stopOnError` defaults to `true`; keep it this way for realistic testing so the run stops once the target chain is broken

## Output expectations

- Simulator output: one natural customer utterance, no explanation
- Scoring output: JSON with `score` and `reason`

If the scorer returns extra text, the runner will try to extract the first JSON object.
