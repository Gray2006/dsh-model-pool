# dsh-model-pool

[English](README.en.md) · [简体中文](README.md) · MIT

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的**按额度自动换模型通道**插件。一条通道报「额度用尽 / 鉴权失败 / 没装适配器」时，自动拉黑冷却，同一步重跑到下一条可用的。侧边栏列出宿主里**所有配好且有 key 的模型**，勾哪些就切哪些。

> 目标版本 DSH `0.2.1-rc.2`。宿主扩展点 `agent/request`、`agent/request-error`、`llm.listProviders/listModels` 均为公开接口。

```
额度池
2/4 条在切换范围
[全选] [全不选]
OPEN-DESIGN                        1/2
☑ deepseek-v4.1-flash  [置顶]      [可用]
☐ deepseek-v4.1-pro                [不在范围]
COMMAND-CODE                       1/1
☑ deepseek/deepseek-v4.1-flash     [冷却 2m3s]
已扫描 · 冷却 10 分钟起    [重新扫描] [刷新]
```

---

## 它解决什么

手上有好几个中转站和几个官方额度的时候，最烦的不是模型不够聪明，而是**跑到一半突然没额度**：

```
你这个月的额度已用尽
```

然后这一轮就废了，得手动去 `/model` 换一个，重来。

这个插件把这步自动化：池里排好几条通道，一条不行就自己换下一条，同一轮同一步接着跑，你甚至不会察觉。

## 装

插件目录挂进 profile 的 `node_modules`，再在 `cordis.patch.yml` 里登记。

**Windows**（管理员不需要，普通 PowerShell 即可）：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-model-pool" `
  -Target "<这个仓库的路径>"
```

**macOS / Linux**：

```sh
ln -s "<这个仓库的路径>" ~/.dsh/profiles/desktop/node_modules/dsh-model-pool
```

> 走命令行的话，profile 名是 `desktop`（桌面应用）或 `web`（`dsh web`）。装错 profile 不会报错，插件只是不出现。

然后编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，加一段：

```yaml
- insert:
    - id: dsh-model-pool
      name: dsh-model-pool
      config:
        enabled: true
        pool:
          - { provider: open-design, model: deepseek-v4.1-flash }
```

重启 DSH，跑 `model_pool_status` 确认。

**`config.pool` 可以留空**（甚至整个 `pool:` 都不写）：插件启动时会自己扫宿主里所有配好且有 key 的模型，直接去侧边栏勾。写进去的作用是**指定优先级**——那几条排最前，UI 上标「置顶」。

## 用

### 侧边栏勾选

右侧栏 **+** 菜单 → 「额度池」。第一次装时自动开一次，之后关掉就不再打扰。

页面按 provider 分组列出扫描到的全部模型，每条一个勾选框，改完立刻生效，不用重启。

| 操作 | 怎么做 |
| --- | --- |
| 加模型 | provider 已配好 → 点「重新扫描」→ 勾上 |
| 暂时不用 | 取消勾选，立刻生效 |
| 彻底移除 | 把 provider 从 DSH 配置里去掉，再重新扫描 |

勾选语义是**严格白名单**：只认勾上的。全部取消就真的不切换——「取消」就是取消，插件不会自作聪明偷偷退回某个默认池。

唯一例外：**从来没勾过**（刚装好、页面没打开过）时退回 `config.pool`，保证装完就能用。

勾选存在 `%DSH_HOME%/model-pool-selection.json`，和冷却表分开，重启后还在。

### 工具

不想开页面也行：

| 工具 | 干什么 |
| --- | --- |
| `model_pool_status` | 看全部候选、谁在切换范围、谁在冷却、下次走哪条 |
| `model_pool_toggle` | 把某条加入或移出自动切换范围 |
| `model_pool_reset` | 手动解除冷却，充值到账后立刻恢复 |

## 它怎么工作

挂两个宿主扩展点：

| 扩展点 | 排序 | 干什么 |
| --- | --- | --- |
| `agent/request` | `prepend` | 本次要用的路由如果正在冷却，换成池里第一条可用的 |
| `agent/request-error` | 常规 | 失败归因：硬伤就拉黑并返回 `{kind:'retry'}`，loop 重跑同一步 |

两条排序都有理由：

- **`agent/request` 必须排最外层（`prepend`）**。waterfall 里先注册的最先跑，改写发生在 `next()` 返回之后，所以最外层等于最后生效。排在内层会被 `model-selection` 之类的下游改写盖回手选值。
- **`agent/request-error` 故意不 prepend**。排在内层就会先问下边的监听器（官方 `dsh-llm-retry`），它想重试就让它重试；它不管了我们才换通道。

换通道时顺手剥掉继承来的 `reasoningEffort` / `maxTokens`：这两个字段是 provider 方言，跨厂商带着走会被 `prepareCall` 拒掉。反过来，**永远不改** `system-prompt/assemble` 里的 provider/model —— 那会让 prompt cache 全部失效。

### 扫描模型

```
llm.listProviders()      → 有适配器的 provider
llm.listModels(id)       → 这个 provider 真能用的模型
```

`llm-pi-ai` 在列模型前先解析 key，key 缺失返回空数组。所以扫出来的天然就是「能用」的那些，插件不用自己判断凭据。

## 失败怎么分类

只有**硬伤**才拉黑换人：

| 类别 | 判据 | 处理 |
| --- | --- | --- |
| 硬伤 | `AUTH` `INVALID_CREDENTIAL` `MISSING_CREDENTIAL` `QUOTA` `ACCOUNT_QUOTA` `NO_ADAPTER` | 拉黑 + 冷却 + 换下一条 |
| 软故障 | `RATE_LIMIT` `SERVER` `TIMEOUT` `TRANSPORT` `EMPTY_RESPONSE` 等 | 不动池子，交还宿主自己的重试策略 |

**文本证据优先于错误码**。真实案例：套餐周额度耗尽时上游回的是

```
429 rate_limit_error: You've reached your weekly usage limit for your plan
```

`code` 是 `RATE_LIMIT`（本该放行），但正文说的是额度用尽。只认 `code` 就会一直卡在同一条上重试到死。所以正文命中额度词表时按硬伤处理。

## 冷却

失败后进冷却，同一步立刻换下一条：

- 首次 `cooldownMs`（默认 10 分钟），连错按 `2^(n-1)` 翻倍，封顶 `maxCooldownMs`（默认 1 小时）
- 成功一次就清零，不累积旧账
- 全池都在冷却时不硬卡：挑最早解冻的那条再试一次，总比直接报错强
- 冷却表存 `%DSH_HOME%/model-pool-state.json`，重启后仍记得谁在冷却

## 刻意不做的事

- **不主动探活**。定时 ping 每个 provider 要花钱，而且探到的「可用」和真跑起来的可用不是一回事。只从真实失败里学。
- **不抢手选**。你手动在 `/model` 选了某条，请求照你的走；只有那条挂了才轮到池子。
- **不改你的 provider 配置**。key 和 provider 都归 DSH 管，插件只在请求出门前换一下路由。
- **不做负载均衡**。它是有序降级，不是轮询——稳定优先。

## 配置项

```yaml
- insert:
    - id: dsh-model-pool
      name: dsh-model-pool
      config:
        enabled: true
        cooldownMs: 600000         # 首次失败冷却 10 分钟
        maxCooldownMs: 3600000     # 翻倍封顶 1 小时
        maxFailoversPerStep: 0     # 0 = 按池大小自动定
        persist: true              # 冷却表落盘
        statePath: ''              # 空 = %DSH_HOME%/model-pool-state.json
        debug: false               # true 打开详细日志
        pool:
          - { provider: open-design, model: deepseek-v4.1-flash }
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉就完全不动路由 |
| `cooldownMs` | `600000` | 首次失败冷却时长 |
| `maxCooldownMs` | `3600000` | 指数翻倍的上限 |
| `maxFailoversPerStep` | `0` | 同一步最多换几次，`0` = 池大小 |
| `persist` | `true` | 冷却表是否落盘 |
| `statePath` | `''` | 自定义冷却表路径 |
| `debug` | `false` | 详细日志（换通道播报始终可见） |
| `pool` | `[]` | 优先路由；留空则全用扫描结果 |

## 状态文件

| 文件 | 内容 |
| --- | --- |
| `%DSH_HOME%/model-pool-state.json` | 冷却表 |
| `%DSH_HOME%/model-pool-selection.json` | 侧边栏勾选 |

两个都只是 JSON，删掉等于重置，不会破坏别的状态。

## 已知边界

- **免费额度常常卡 `maxTokens`**。智谱这类免费模型上下文窗口小，大请求换过去也装不下，会被判 `CONTEXT_WINDOW_EXCEEDED` 拉黑。这不是 bug，是那档额度本来就装不下——留它在池外更合适。
- **`/model` 显示的可能不是实际路由**。那是会话级手选值，插件在请求层换路，UI 未必跟得上。以 `model_pool_status` 为准。
- **侧边栏那页依赖 `dsh-better-sidebar`**。没装的话自动切换照常工作，只是没有那个页面。
- **跨会话不共享换路次数**。`maxFailoversPerStep` 按 `turn:step` 计，避免一个坏步骤把整池冷却吃干净。

## 开发

无构建步骤，源码就是运行产物。

```bash
node --test test/pool.test.mjs test/host.test.mjs    # 32 个用例
```

| 文件 | 内容 |
| --- | --- |
| `lib/pool.js` | 纯逻辑：失败分类、冷却、选路。无 I/O，好测 |
| `lib/index.js` | 宿主半侧：钩子、工具、HTTP 路由 |
| `lib/client.js` | 侧边栏页面（手写 bundle，不依赖构建器） |
| `test/` | `node:test` 用例 |

`cordis.patch.yml` 里默认 `pool: []`，保证照抄配置的人不会莫名其妙被切走。

## 由来

这个插件不是先有想法再找场景，是从一个具体的气人时刻长出来的：手上攒了几条中转和几个官方额度，本该宽裕，结果总是在一轮推理跑到一半时撞上「额度已用尽」，整轮作废，手动换模型，重来。

写的过程中也踩了几个坑，这些坑直接决定了代码长什么样：

- 套餐周额度耗尽时上游回的是 `429 rate_limit_error`，错误码看着像普通限流。只认错误码就会一直卡在死路上重试——所以文本证据被提到错误码之上
- 侧边栏的 tab 注册了却不出现，追下去才发现宿主在会话未绑定时会静默返回，且 `registerTab` 只登记类型、不落到 tab 条上
- 勾选语义最初做成「剔除表」，结果只有两条通道时取消其中一条根本不生效——取消后自动退回整池，把取消的那条又拉了回来

设计上的几个「不做」同样是权衡的结果，不是遗漏：不探活是因为探活要花钱、且探到的可用和真跑起来的可用不是一回事；不抢手选是因为人的判断优先于插件的猜测；不改 provider 配置是因为那属于 DSH 的地盘。

代码由我（Gray2006）与 AI 编码助手协作完成。每一条规则、每一个取舍，都是实际跑出来的结论，不是猜的。

## 许可

MIT
