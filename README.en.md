# dsh-model-pool

Automatic model failover for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).
When one provider runs out of quota, rejects its credentials, or has no adapter, the plugin
benches it, retries the same step on the next route in the pool, and gets out of the way.
A sidebar page lets you pick which routes are allowed to take part.

[中文说明](README.md) · MIT

---

## What it does

A pool is an ordered list of `provider/model` routes. The plugin hooks two host extension
points and never probes anything on its own:

| Hook | Order | Job |
| --- | --- | --- |
| `agent/request` | `prepend` | If the route about to be used is cooling down, swap in the next usable one |
| `agent/request-error` | normal | Attribute the failure: a hard failure benches the route and returns `{kind:'retry'}` so the loop re-runs the same step |

The ordering is deliberate:

- **`agent/request` must be outermost (`prepend`).** In a cordis waterfall the first
  registered listener runs first and the rewrite happens *after* `next()` returns, so
  outermost means last word. Sitting inside would let `model-selection` and friends
  overwrite the choice back to the manually selected route.
- **`agent/request-error` is deliberately not prepended.** It sits inside so the official
  `@deepseek-ai/dsh-llm-retry` gets asked first — a transient error it already handles
  never benches a healthy route.

### Which failures bench a route

Benched (the route is genuinely unusable right now):

`QUOTA` · `ACCOUNT_QUOTA` · `AUTH` · `INVALID_CREDENTIAL` · `MISSING_CREDENTIAL` · `NO_ADAPTER`

Not benched (jitter — the host's own retry policy owns these):

`RATE_LIMIT` · `SERVER` · `TIMEOUT` · `TRANSPORT` · `EMPTY_RESPONSE` · `CONTEXT_WINDOW_EXCEEDED` · `IMAGE_OFFLOAD_REQUIRED`

Error codes alone are not enough, because providers word quota exhaustion in their own
language. A text pattern list catches what the codes miss — including Chinese
(`余额不足`, `额度已用尽`), which the host's built-in matcher does not cover. **Text
evidence wins over a soft code:** a `RATE_LIMIT` whose message says "insufficient balance"
is a quota failure wearing a rate-limit coat, and gets benched.

Cooldowns are exponential per route: `cooldownMs × 2^(strikes-1)`, capped at
`maxCooldownMs`. A route that serves successfully again resets its strikes.

### What it does not do

- **No active probing.** Quota is learned from real failures only. Probing costs money and
  burns tokens for a status line — you would be paying to find out what the next real
  request tells you for free.
- **Does not steal your manual pick.** If the current route is not cooling, it passes
  through untouched.
- **Does not rewrite the system prompt.** Nudging the prompt to mention the active route
  would break prompt caching on every switch, which costs far more than the convenience is
  worth.

## Sidebar: choose which routes participate

Once installed, a **额度池 / Model Pool** page appears in the right sidebar next to Files and
Git, with a checkbox per route:

- **Checked** — in auto-switch scope: skipped when it fails, and eligible as a fallback target
- **Unchecked** — out of scope: it can still be the route you pick by hand, but auto-switch
  will never land on it

Changes take effect immediately, no restart. The selection persists to
`%DSH_HOME%/model-pool-selection.json`, separate from the cooldown table.

The default is **all on**: the file only records routes you removed, so adding a route to
`config.pool` later does not require revisiting this page.

Two guards:

- Unchecking every route falls back to the whole pool. Otherwise one careless click would
  silence every model at once — nobody wants that switch.
- If the page cannot read state it says so plainly (e.g. the plugin has not been restarted
  yet) instead of pretending there are zero routes.

The same thing is available without the page via the `model_pool_toggle` tool.

## Configuration

In your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-model-pool
      name: dsh-model-pool
      config:
        enabled: true
        cooldownMs: 600000         # first failure: 10 min
        maxCooldownMs: 3600000     # cap: 1 hour
        maxFailoversPerStep: 0     # 0 = derive from pool size
        persist: true
        statePath: ''              # empty = %DSH_HOME%/model-pool-state.json
        pool:                      # order is priority
          - { provider: open-design,  model: deepseek-v4.1-flash }
          - { provider: command-code, model: deepseek/deepseek-v4.1-flash }
          - { provider: zhipu,        model: glm-4.7-flash }
```

A pool entry may carry `reasoningEffort` and `maxTokens`. When switching away from a route
those inherited values are stripped: they belong to the previous provider's vocabulary, and
carrying them across makes `prepareCall` reject the request.

## Tools

| Tool | Purpose |
| --- | --- |
| `model_pool_status` | Which routes exist, who is cooling, which are out of scope, what the next request will use |
| `model_pool_reset` | Clear cooldowns (all, or one route) — run this after topping up |
| `model_pool_toggle` | Move a route in or out of auto-switch scope (same as the sidebar checkbox) |

## Install

```powershell
# 1) link into your profile's node_modules
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-model-pool" `
  -Target "<path-to-this-repo>"

# 2) add the insert block above to your profile's cordis.patch.yml

# 3) restart DSH
```

The sidebar page additionally needs
[`dsh-better-sidebar`](https://github.com/deepseek-ai/dsh-better-sidebar) — without it the
failover half still works, you just get no page. (Its tab registers through
`ctx.betterSidebar`.)

## State files

| File | Contents |
| --- | --- |
| `%DSH_HOME%/model-pool-state.json` | Cooldown table: route, deadline, failure code, strikes |
| `%DSH_HOME%/model-pool-selection.json` | Routes removed from auto-switch scope |

Both are plain JSON and safe to delete while DSH is stopped — losing them only forgets
cooldowns and your checkboxes.

## Known limits

- The composer's `/model` picker shows the session-level manual choice. When this plugin
  overrides the route at the `agent/request` layer, the two can disagree. The sidebar page
  is the accurate view of what will actually be used.
- Free tiers often cap `maxTokens` aggressively (GLM's free models, for instance). A route
  with a small ceiling may reject a large-context request even though it has quota left;
  that surfaces as a hard failure and benches it, which is the intended behaviour but can
  make free routes churn. Uncheck them in the sidebar if that is not what you want.
- No active health probing, by design (see above). A route that is dead but never receives
  a request will not be discovered until it does.

## Development

```sh
node --test test/pool.test.mjs test/host.test.mjs
```

30 cases: failure classification, exponential backoff, selection persistence, route picking
under cooldown, the HTTP endpoint's same-origin guard, and the panel's rendering across
states. No network, no host required.

## License

MIT
