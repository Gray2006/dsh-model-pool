# dsh-model-pool

[English](README.en.md) · [简体中文](README.md) · MIT

Quota-aware model failover for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH). When a route reports an exhausted quota, a bad credential, or no adapter, it gets benched and the same step is retried on the next usable route. The sidebar lists **every model in your host that is configured and has a working key** — check the ones you want in the pool.

> Targets DSH `0.2.1-rc.2`. Uses the public host extension points `agent/request`, `agent/request-error`, and `llm.listProviders / listModels`.

```
MODEL POOL
2/4 routes in auto-switch scope
[Select all] [Select none]
OPEN-DESIGN                        1/2
☑ deepseek-v4.1-flash  [pinned]     [ready]
☐ deepseek-v4.1-pro                 [out of scope]
COMMAND-CODE                       1/1
☑ deepseek/deepseek-v4.1-flash      [cooling 2m3s]
scanned · cooldown from 10 min    [Rescan] [Refresh]
```

---

## The problem it solves

When you run several relays and a couple of official quotas, the annoying failure is not a model being not-smart-enough — it is **running out of quota halfway through**:

```
You have reached your monthly usage limit
```

The turn dies, you switch models by hand, you start over.

This plugin automates that step: put several routes in the pool, and when one fails it moves to the next one within the same turn and the same step. You will usually not notice.

## Install

Link the plugin directory into the profile's `node_modules`, then register it in `cordis.patch.yml`.

**Windows** (no administrator needed; a normal PowerShell works):

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-model-pool" `
  -Target "<path to this repo>"
```

**macOS / Linux**:

```sh
ln -s "<path to this repo>" ~/.dsh/profiles/desktop/node_modules/dsh-model-pool
```

> Profile names are `desktop` for the desktop app and `web` for `dsh web`. Installing into the wrong profile does not error — the plugin simply never shows up.

Then edit `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-model-pool
      name: dsh-model-pool
      config:
        enabled: true
        pool:
          - { provider: open-design, model: deepseek-v4.1-flash }
```

Restart DSH and run `model_pool_status` to confirm.

**`config.pool` may be empty** (you can omit `pool:` entirely): on startup the plugin scans every model in the host that is configured and has a usable key, and you pick from the sidebar. What you write there sets **priority** — those routes are tried first and are marked `pinned` in the UI.

## Use

### Pick from the sidebar

Right sidebar **+** menu → **Model Pool**. It opens once automatically after install, then stays out of the way; reopen any time.

The page lists every discovered model grouped by provider, one checkbox each. Changes take effect immediately, no restart.

| Task | How |
| --- | --- |
| Add a model | Provider already configured → hit **Rescan** → check it |
| Stop using one for now | Uncheck it, immediate |
| Remove it entirely | Remove the provider from your DSH config, then rescan |

The semantics are a **strict allow-list**: only what you checked counts. Uncheck everything and nothing switches — "uncheck" means uncheck, and the plugin will not quietly fall back to some default pool.

One exception: if you have **never** checked anything (fresh install, page never opened), it falls back to `config.pool` so it works out of the box.

Selection lives in `%DSH_HOME%/model-pool-selection.json`, separate from the cooldown table, and survives restarts.

### Tools

Prefer not to open the page:

| Tool | Purpose |
| --- | --- |
| `model_pool_status` | Every candidate, what is in scope, who is cooling, which route comes next |
| `model_pool_toggle` | Put a route into or out of auto-switch scope |
| `model_pool_reset` | Clear cooldowns manually — use this once a top-up lands |

## How it works

Two host extension points:

| Point | Order | What it does |
| --- | --- | --- |
| `agent/request` | `prepend` | If this step's route is cooling, swap in the first usable route from the pool |
| `agent/request-error` | normal | Classify the failure; on a hard failure bench the route and return `{kind:'retry'}` so the loop re-runs the same step |

Both orders are deliberate:

- **`agent/request` must be outermost (`prepend`).** In a waterfall the first-registered listener runs first, and the rewrite happens after `next()` returns — so outermost means "last word". Inside, something like `model-selection` would overwrite the swap with the manual pick.
- **`agent/request-error` is deliberately not prepended.** It asks the inner listeners first (the official `dsh-llm-retry`); if that one wants to retry, let it. We take over only when it declines.

When switching, inherited `reasoningEffort` / `maxTokens` are stripped: those two are provider dialect, and carrying them across vendors makes `prepareCall` reject the request. Conversely, the `system-prompt/assemble` provider/model is **never** rewritten — that would invalidate the entire prompt cache.

### Model discovery

```
llm.listProviders()      -> providers with a registered adapter
llm.listModels(id)       -> models that provider can actually serve
```

`llm-pi-ai` resolves the API key before listing and returns an empty array when it is missing, so whatever comes back is already usable — the plugin does not judge credentials itself.

## Failure classification

Only **hard failures** get a route benched:

| Kind | Codes | Action |
| --- | --- | --- |
| Hard | `AUTH` `INVALID_CREDENTIAL` `MISSING_CREDENTIAL` `QUOTA` `ACCOUNT_QUOTA` `NO_ADAPTER` | Bench, cool down, switch |
| Soft | `RATE_LIMIT` `SERVER` `TIMEOUT` `TRANSPORT` `EMPTY_RESPONSE`, etc. | Leave the pool alone, hand back to the host's retry policy |

**Text evidence outranks the error code.** A real case: when a plan's weekly quota runs out, the upstream answers

```
429 rate_limit_error: You've reached your weekly usage limit for your plan
```

The `code` is `RATE_LIMIT` (would be passed through), but the body says the quota is gone. Trusting the code alone kept retrying the same dead route forever. So when the message matches a quota pattern, it is treated as hard.

## Cooldowns

A failed route cools down and the same step immediately moves on:

- First failure: `cooldownMs` (default 10 min); repeats escalate as `2^(n-1)`, capped at `maxCooldownMs` (default 1 hour)
- One success resets the counter — no accumulated debt
- If every route is cooling it does not give up: it retries the one that unblocks soonest, which beats failing outright
- The table persists to `%DSH_HOME%/model-pool-state.json`, so restarts remember who is cooling

## Deliberate non-goals

- **No active health probing.** Periodically pinging every provider costs money, and a probe saying "reachable" is not the same as a real request succeeding. It learns from real failures only.
- **Never preempts a manual pick.** If you chose a route in `/model`, that is what runs; the pool only steps in when it fails.
- **No provider config rewriting.** Keys and providers belong to DSH. The plugin only swaps the route just before the request leaves.
- **No load balancing.** It is ordered degradation, not round-robin — stability first.

## Configuration

```yaml
- insert:
    - id: dsh-model-pool
      name: dsh-model-pool
      config:
        enabled: true
        cooldownMs: 600000         # first failure: 10 min
        maxCooldownMs: 3600000     # cap after escalation: 1 hour
        maxFailoversPerStep: 0     # 0 = derive from pool size
        persist: true              # persist the cooldown table
        statePath: ''              # empty = %DSH_HOME%/model-pool-state.json
        debug: false               # true = verbose logging
        pool:
          - { provider: open-design, model: deepseek-v4.1-flash }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn it off to stop touching routing entirely |
| `cooldownMs` | `600000` | First-failure cooldown |
| `maxCooldownMs` | `3600000` | Ceiling for the exponential escalation |
| `maxFailoversPerStep` | `0` | Max switches per step; `0` = pool size |
| `persist` | `true` | Whether the cooldown table is written to disk |
| `statePath` | `''` | Custom cooldown-table path |
| `debug` | `false` | Verbose logs (switch announcements are always visible) |
| `pool` | `[]` | Priority routes; empty means use the scan results as-is |

## State files

| File | Contents |
| --- | --- |
| `%DSH_HOME%/model-pool-state.json` | Cooldown table |
| `%DSH_HOME%/model-pool-selection.json` | Sidebar selection |

Both are plain JSON. Deleting them resets the plugin and breaks nothing else.

## Known limits

- **Free tiers often cap `maxTokens`.** Small-context free models (GLM/zhipu especially) cannot fit large requests, so they get benched for `CONTEXT_WINDOW_EXCEEDED`. That is not a bug — that tier genuinely cannot hold the request. Leaving it out of the pool is the intended remedy.
- **`/model` may not show the route actually used.** That is the session-level manual choice; the plugin swaps at the request layer, so the UI can lag behind. Trust `model_pool_status`.
- **The sidebar page needs `dsh-better-sidebar`.** Without it failover still works; you just do not get the page.
- **Failover counts are per `turn:step`**, so one pathological step cannot burn the whole pool's cooldowns.

## Development

No build step — the source is the artifact.

```bash
node --test test/pool.test.mjs test/host.test.mjs    # 32 cases
```

| File | Contents |
| --- | --- |
| `lib/pool.js` | Pure logic: classification, cooldowns, route picking. No I/O, easy to test |
| `lib/index.js` | Host half: hooks, tools, HTTP route |
| `lib/client.js` | Sidebar page (hand-written bundle, no bundler) |
| `test/` | `node:test` cases |

`cordis.patch.yml` ships with `pool: []` so anyone copying the config is not silently rerouted.

## Where this came from

This plugin was not designed from a spec. It grew out of one specific annoying moment: a handful of relays and a couple of official quotas — plenty on paper — and yet the turn that mattered would die halfway through with "usage limit reached", forcing a manual model switch and a full restart.

A few bugs found along the way ended up shaping the code:

- When a plan's weekly quota runs out the upstream answers `429 rate_limit_error`, which looks like ordinary rate limiting. Trusting the code alone keeps retrying a dead route — so text evidence was promoted above the error code.
- The sidebar tab registered but never appeared; the host returns silently when no session is bound yet, and `registerTab` only registers the tab *type* without putting anything on the tab strip.
- The selection was first modelled as a removal list, which meant removing one of two routes did nothing at all: the fallback to the whole pool pulled the removed route straight back.

The deliberate non-goals are the same kind of trade-off, not oversights: no probing because probing costs money and "reachable" is not "a real request succeeds"; no preemption of manual picks because human judgement outranks the plugin's guess; no provider config rewriting because that belongs to DSH.

Built by me (Gray2006) in collaboration with an AI coding assistant. Every rule and every trade-off here is the result of something that actually ran, not a guess.

## License

MIT
