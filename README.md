# dsh-model-pool

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的**按额度自动换模型通道**插件。

一条通道报「额度用尽 / 鉴权失败 / 没装适配器」时，把它拉黑冷却，同一步自动重跑到池里
下一条可用的，不用人盯着。侧边栏有一页勾选框，手动决定哪些通道参与切换。

[English](README.en.md) · MIT

---

## 它解决什么

手上有好几个中转站和几个官方额度的时候，最烦的不是模型不够聪明，而是**跑到一半突然没额度**：

```
你这个月的额度已用尽
```

然后这一轮就废了，得手动去 `/model` 换一个，重来。

这个插件把这步自动化：池里排好几条通道，一条不行就自己换下一条，同一轮同一步接着跑，
你甚至不会察觉。

## 三分钟上手

### 1. 装

```powershell
# 把仓库链接到你的 profile 里（Windows）
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-model-pool" `
  -Target "<这个仓库的路径>"
```

macOS / Linux 用软链：

```sh
ln -s "<这个仓库的路径>" ~/.dsh/profiles/desktop/node_modules/dsh-model-pool
```

### 2. 配

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，加一段：

```yaml
- insert:
    - id: dsh-model-pool
      name: dsh-model-pool
      config:
        pool:                       # 顺序即优先级，排前面的先用
          - { provider: open-design,  model: deepseek-v4.1-flash }
          - { provider: command-code, model: deepseek/deepseek-v4.1-flash }
          - { provider: zhipu,        model: glm-4.7-flash }
```

`provider` 和 `model` 的名字，就是你 DSH 里 `llm-pi-ai` 那节 `providers` 里已经配好的。
插件不自己管 key，也不改你的 provider 配置——它只是在请求发出去之前换一下路由。

### 3. 重启 DSH

重启后池子就生效了。想确认：

```
model_pool_status
```

会告诉你池里有谁、谁在冷却、下次请求走哪条。

### 4. （可选）侧边栏勾选

右侧栏的 **+** 菜单里会多一项「额度池」。第一次装时会自动帮你开一次，之后关了就不再打扰，
随时可以从 **+** 菜单重新打开。

页面里每条通道一个勾选框，改完立刻生效，不用重启。

## 侧边栏那一页

```
额度池
2/3 条在切换范围。勾上的才会被自动切过去；取消勾选的通道保持原样，不参与兜底。
┌──────────────────────────────────────┐
│ 下次请求                              │
│ open-design/deepseek-v4.1-flash      │
└──────────────────────────────────────┘
☑ open-design/deepseek-v4.1-flash      [可用]
☑ command-code/deepseek/…-flash        [冷却 2m3s]
☐ zhipu/glm-4.7-flash                  [不在范围]
```

- **勾上** = 在自动切换范围里：出问题时会被跳过，也会被当成兜底目标
- **取消** = 移出范围：它仍然可以是你手选的当前通道，只是自动切换不会往它身上落
- 冷却中的通道显示倒计时，到点自动恢复
- 右下角「刷新」，不想等可以手动拉一次

**为什么需要这个页面**：池里每条通道的成本和限制不一样。比如某些免费模型 `maxTokens`
很小，大上下文请求换过去也装不下，会被判为失败然后拉黑。这种通道你可能想留在池外。

勾选存在 `%DSH_HOME%/model-pool-selection.json`，和冷却表分开，重启后还在。
默认全开：文件里只记被**移出**的通道，所以往 `config.pool` 里新加一条时不用再去点一次。

两条保险：

- 全部取消会自动退回整池。否则等于一键把模型全掐死。
- 页面读不到状态时会明说（比如插件还没重启生效），不会假装成「一条都没有」。

不想开页面也行，等价入口是 `model_pool_toggle` 工具。

## 它怎么工作

挂两个宿主扩展点：

| 扩展点 | 排序 | 干什么 |
| --- | --- | --- |
| `agent/request` | `prepend` | 本次要用的路由如果正在冷却，换成池里第一条可用的 |
| `agent/request-error` | 常规 | 失败归因：硬伤就拉黑并返回 `{kind:'retry'}`，loop 重跑同一步 |

两条排序都有理由：

- **`agent/request` 必须排最外层（`prepend`）**。waterfall 里先注册的最先跑，改写发生在
  `next()` 返回之后，所以最外层等于最后生效。排在内层会被 `model-selection` 之类的
  下游改写盖回手选值。
- **`agent/request-error` 故意不 prepend**。排在内层就会先问下边的监听器（官方
  `llm-retry` 的重试策略），它要重试就让它重试；只有它放手、且判明是额度类硬伤时
  才接管，不会把手抖当成额度废号。

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

错误码不可靠时看文本兜底：`余额不足`、`额度已用尽`、`insufficient balance`、
`quota exceeded`、`invalid api key` 等。**文本判定优先于软码**：一条报 `RATE_LIMIT`
但正文写着「余额不足」的失败，本质是额度问题穿了件限流的外衣，照样拉黑。

## 冷却

- 首次失败 `cooldownMs`（默认 10 分钟），同一条通道连续失败翻倍，封顶 `maxCooldownMs`（默认 1 小时）
- 冷却期过了 strikes 归零，重新从 base 开始
- 全池都在冷却时退化为「最早解冻的那条」，宁可试一下也不让这一轮直接死
- 冷却表落盘到 `%DSH_HOME%/model-pool-state.json`，重启后仍记得

## 刻意不做的事

- **不主动发探测请求**。探活要花钱、要烧 token，额度只从真实失败里学。你为一条状态行
  付费，而下一个真实请求本来就会告诉你同一件事。
- **不抢你手选的模型**。当前路由没在冷却就原样放行；你手选了池外的通道也不会被改。
- **不改 `system-prompt/assemble` 里的 provider/model**。那两项每轮变化会击穿
  prompt 缓存，代价比「提示里写的模型名和实际路由不同步」大得多。真实路由看
  `model_pool_status`。

## 配置项

```yaml
- insert:
    - id: dsh-model-pool
      name: dsh-model-pool
      config:
        enabled: true
        cooldownMs: 600000          # 首次冷却 10 分钟
        maxCooldownMs: 3600000      # 封顶 1 小时
        maxFailoversPerStep: 0      # 同一步最多换几次；0 = 按池大小自动
        persist: true               # 冷却表落盘
        statePath: ''               # 空 = %DSH_HOME%/model-pool-state.json
        debug: false                # 打开后往宿主日志写装配与诊断信息
        pool:                       # 顺序即优先级
          - { provider: open-design,  model: deepseek-v4.1-flash }
          - { provider: command-code, model: deepseek/deepseek-v4.1-flash }
          - { provider: zhipu,        model: glm-4.7-flash }
```

池条目可带 `reasoningEffort` 和 `maxTokens`。切换通道时，**继承来的**这两个值会被清掉：
它们属于上一条通道的词汇表，跨通道带过去会让 `prepareCall` 直接拒掉请求。

## 工具

| 工具 | 用途 |
| --- | --- |
| `model_pool_status` | 池里有谁、谁在冷却、哪条被移出了范围、下次请求走哪条 |
| `model_pool_reset` | 手动解除冷却（全部或指定一条），充值到账后用它立刻恢复 |
| `model_pool_toggle` | 把某条通道纳入/移出切换范围（和侧边栏勾选等价） |

## 状态文件

| 文件 | 内容 |
| --- | --- |
| `%DSH_HOME%/model-pool-state.json` | 冷却表：路由、解冻时间、失败码、连错次数 |
| `%DSH_HOME%/model-pool-selection.json` | 被移出切换范围的通道 |

都是普通 JSON，DSH 关着的时候删掉没关系——只会忘掉冷却和你的勾选。

## 已知边界

- UI 的 `/model` 显示的是会话级手选，插件在 `agent/request` 层覆盖路由后两边可能不同步。
  实际生效的是插件选的（除非手选那条正在冷却）。用 `model_pool_status` 看真实路由。
- 只按失败学，不预判额度：一条通道额度还剩一点，会一直用到真失败为止。
- 失败归因依赖 `failure.code`；纯文本兜底有误判可能，误判方向是「过早拉黑」，
  冷却到期会自己恢复。
- **免费额度通常卡 `maxTokens`**（智谱的免费模型尤其）。这类通道额度还剩也会因为
  上下文装不下被判硬伤拉黑。这是预期行为，但会让免费通道反复进出——不想要就在
  侧边栏取消勾选。
- 侧边栏那一页需要 [`dsh-better-sidebar`](https://github.com/deepseek-ai/dsh-better-sidebar)。
  没装它自动切换照样工作，只是看不到勾选页面。

## 测试

```sh
node --test test/pool.test.mjs test/host.test.mjs
```

30 个用例，覆盖失败分类、指数退避、选路、全池冷却退化、落盘恢复、切换范围的持久化、
HTTP 端点的同源校验，以及侧边栏面板在各状态下的渲染。不联网、不需要宿主。

## 许可

MIT
