# dsh-model-pool

按额度自动换通道。一条通道报「额度用尽 / 鉴权失败 / 没有适配器」就把它拉黑冷却，
同一步自动重跑到池里下一条可用通道，不用人盯着。

[English](README.en.md) · MIT

## 侧边栏：手动勾选哪些通道参与切换

装好后右侧栏多一个「额度池」页（和「文件」「Git」那些并排）。里面每条通道一个勾选框：

- **勾上** = 在自动切换范围里，它出问题时会被跳过，也会被当成兜底目标
- **取消** = 移出范围。它仍然可以是你手选的当前通道，只是自动切换不会往它身上落

改完立刻生效，不用重启。勾选存在 `%DSH_HOME%/model-pool-selection.json`，
和冷却表分开，重启后还在。

默认是「全开」：文件里只记被移出的通道，所以往 `config.pool` 里新加一条通道时
不需要再去侧边栏点一次。

两条保险：

- 全部移出会自动退回整池。否则等于一键把模型全掐死，没人想要这个。
- 侧边栏页面读不到状态时会明说（比如插件还没重启生效），不会假装成「一条都没有」。

不想开页面也行，等价入口是 `model_pool_toggle` 工具。

## 它怎么工作

挂两个已核实的宿主扩展点：

| 扩展点 | 排序 | 干什么 |
| --- | --- | --- |
| `agent/request` | `prepend` | 本次要用的路由如果正在冷却，换成池里第一条可用的 |
| `agent/request-error` | 常规 | 失败归因：硬伤就拉黑并返回 `{kind:'retry'}`，loop 重跑同一步 |

两条排序都有理由：

- `agent/request` 必须排最外层（`prepend`）。waterfall 里先注册的最先跑，改写发生在
  `next()` 返回之后，所以最外层等于最后生效。排在内层会被 `model-selection` 之类的
  下游改写盖回手选值。
- `agent/request-error` 故意不 prepend。排在内层就会先问下边的监听器（官方
  `llm-retry` 的重试策略），它要重试就让它重试；只有它放手、且判明是额度类硬伤时
  我才接管，不会把手抖当成额度废号。

因为 `agent/request-error` 返回 `retry` 后 loop 会 `continue`，下一次迭代重新走
`prepareRequest()` → `agent/request`，所以拉黑当场就生效，不需要等下一轮。

## 失败怎么分类

| 失败码 | 处理 | 理由 |
| --- | --- | --- |
| `QUOTA` / `ACCOUNT_QUOTA` | 拉黑 | 余额没了，重试多少次都是零 |
| `AUTH` / `INVALID_CREDENTIAL` / `MISSING_CREDENTIAL` | 拉黑 | key 坏了，同一条通道不会自愈 |
| `NO_ADAPTER` | 拉黑 | 这个 provider 没装适配器 |
| `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE` | 放行 | 抖动，宿主自己的重试策略负责 |
| `CONTEXT_WINDOW_EXCEEDED` / `IMAGE_OFFLOAD_REQUIRED` | 放行 | 换谁都一样，换通道只会白烧一次调用 |

失败码不可靠时看文本兜底：`余额不足`、`额度已用尽`、`insufficient balance`、
`quota exceeded`、`invalid api key` 等。适配器把额度错误笼统归成 `SERVER` 时，
文本判定优先于软码，不会白烧掉剩下的重试次数。

## 冷却

- 首次失败 `cooldownMs`（默认 10 分钟），同一条通道连续失败翻倍，封顶 `maxCooldownMs`（默认 1 小时）
- 冷却期过了 strikes 归零，重新从 base 开始
- 全池都在冷却时退化为「最早解冻的那条」，宁可试一下也不让这一轮直接死
- 冷却表落盘到 `%DSH_HOME%/model-pool-state.json`，重启后仍记得

## 刻意不做的事

- **不主动发探测请求**。探活是要花钱的，额度只从真实失败里学。
- **不抢用户手选的模型**。当前路由没在冷却就原样放行；你手选了池外的通道也不会被改。
- **不改 `system-prompt/assemble` 里的 provider/model**。那两项每轮变化会击穿
  prompt 缓存，代价比「提示里写的模型名和实际路由不同步」大得多。真实路由看
  `model_pool_status`。

## 配置

```yaml
- insert:
    - id: dsh-model-pool
      name: dsh-model-pool
      config:
        enabled: true
        cooldownMs: 600000          # 首次冷却 10 分钟
        maxCooldownMs: 3600000      # 封顶 1 小时
        maxFailoversPerStep: 0      # 0 = 按池大小自动
        persist: true               # 冷却表落盘
        statePath: ''               # 空 = %DSH_HOME%/model-pool-state.json
        pool:                       # 顺序即优先级
          - { provider: open-design,  model: deepseek-v4.1-flash }
          - { provider: command-code, model: deepseek/deepseek-v4.1-flash }
          - { provider: zhipu,        model: glm-4.7-flash }
```

池条目可带 `reasoningEffort`；不带时换通道会清掉继承来的强度值，因为那是上一条
通道的词汇表。

## 工具

- `model_pool_status` —— 池里有谁、谁在冷却、哪条被移出了范围、下次请求走哪条
- `model_pool_reset` —— 手动解除冷却（全部或指定一条），充值到账后用它立刻恢复
- `model_pool_toggle` —— 把某条通道纳入/移出切换范围（和侧边栏勾选等价）

## 安装

```powershell
# 1) junction 到 profile 的 node_modules
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-model-pool" `
  -Target "<这个仓库的路径>"

# 2) profile 的 cordis.patch.yml 加 insert 段（见上）

# 3) 重启 DSH 桌面端
```

侧边栏那一页还需要 [`dsh-better-sidebar`](https://github.com/deepseek-ai/dsh-better-sidebar)。
没装它自动切换照样工作，只是看不到勾选页面（tab 走 `ctx.betterSidebar` 注册）。

## 已知边界

- UI 的 `/model` 显示的是会话级手选，插件在 `agent/request` 层覆盖路由后两边可能不同步。
  实际生效的是插件选的（除非手选那条正在冷却）。用 `model_pool_status` 看真实路由。
- 只按失败学，不预判额度：如果一条通道额度还剩一点，会用到真失败为止。
- 失败归因依赖 `failure.code`；纯文本兜底有误判可能，误判方向是「过早拉黑」，冷却到期会自己恢复。
- 免费额度通常卡 `maxTokens`（智谱的免费模型尤其）。这类通道额度还剩也会因为上下文装不下
  被判硬伤拉黑，是预期行为，但会让免费通道反复进出。不想要就在侧边栏取消勾选。

## 测试

```powershell
node --test test/pool.test.mjs test/host.test.mjs
```

30 个用例，覆盖分类、退避、选路、全池冷却退化、落盘恢复、切换范围的持久化、
HTTP 端点的同源校验，以及侧边栏面板在各状态下的渲染。不联网、不需要宿主。

## 许可

MIT
