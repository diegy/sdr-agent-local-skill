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
- 官网客服模式默认不透传原始 `Cookie`，以减少不同 loop 复用同一个真实后端会话的风险
- 官网客服模式会单独识别首轮欢迎语；欢迎语会保留在日志/报告里，但不会被当成正式回复推进下一轮对话
- If you intentionally want to reuse the real webpage session, set `preserveWebsiteCookies: true`

## Output expectations

- Simulator output: one natural customer utterance, no explanation
- Scoring output: JSON with `score` and `reason`

If the scorer returns extra text, the runner will try to extract the first JSON object.

## Prompt And Flow Change Discipline

When the task involves diagnosing or modifying prompt templates / flows for the SDR agent, follow these rules before making changes:

1. Diagnose first, then decide how to change. Do not jump straight to prompt edits before checking traces, current prompt IO schema, active flow version, and whether the issue is caused by prompt, flow wiring, or downstream topic / lead-field injection.
2. Evaluate full-flow impact before changing strategy. Changes to `followupMode` /追问模式, topic library /话题库, and lead capture /留资字段 must be checked together so they do not fight each other. `followupMode` only decides whether asking is allowed and what category is allowed; the concrete follow-up topic still comes from the topic library when follow-up is permitted.
3. For prompt input variables, register them in step 1 `基础信息配置` first, then insert them into the prompt body using the same variable-tag format as existing variables. Editing body text alone is not enough.
4. For prompt output fields, ensure the prompt body and `outputSetting` schema stay aligned. If the body requires `followup_mode` or another field, the template output config must declare it before the flow can publish cleanly.
5. Every prompt / flow edit must be saved as a new version and then switched to the new active version. Do not assume `保存为新版本` also made it current.
6. When modifying prompts through browser automation, verify you are inside the correct prompt editor (`apiName`, version, current flag) before saving. Do not reuse a patch flow that may still be attached to the wrong editor context.
7. After any prompt change, regress all required scenarios instead of only the one that triggered the edit. Repetition, over-follow-up, unsupported knowledge expansion, and tone hardening can regress across scenes.
8. For reply-effect testing, prefer request-level regression first. Do not ask for Keychain / secret access just to validate output quality if the same verification can be done by replaying real web customer-service requests.
9. Never close, restart, or take over the user's browser unless the user explicitly authorizes that action for the current step. If browser automation is unavoidable, attach only to the user-specified browser/profile and keep the browser state intact.
10. If a scripted regression times out on some scenes, retry those failed scenes with a narrowed config instead of rerunning everything blindly. This keeps trace collection stable and avoids mixing timeout noise into unrelated scenarios.
11. Treat control variables and content variables differently. A variable like `followupMode` /追问模式 should stay content-agnostic and only describe follow-up control, not business-specific content. Do not encode domain-specific subtypes such as `限定ERP追问` into the main control contract; if a restriction depends on product line / scenario content, solve it with topic selection, prompt rules, or another content-layer mechanism instead.
12. When evaluating a proposed fix, first ask whether the proposed new field is carrying control or carrying content. If it carries content, it should not be used as a top-level flow control variable. This is a required checkpoint before deciding the solution direction.
13. Never design prompt / flow rules around hard-coded business content such as specific products, modules, industries, or scenario labels. Content must come from `知识库`, `话题库`, and `话术案例库`, not from control-layer rules.
14. When solving repetition problems, prefer abstract structural constraints over content constraints. The right targets are things like:
    - answer the newest user delta first
    - avoid repeating the previous turn's opening pattern
    - avoid reusing the same answer skeleton on same-topic follow-ups
    - avoid expanding scope after the user narrows scope
    Do NOT solve repetition by enumerating specific product phrases such as “模块定位句最多一次”.
15. Before proposing a fix, classify the problem into one of two buckets:
    - control / structure problem: should be solved by flow gates, turn-level variables, or abstract prompt rules
    - content / retrieval problem: should be solved by `知识库` / `话题库` / `案例库` selection or matching
    Only after that classification should you decide what to modify.
