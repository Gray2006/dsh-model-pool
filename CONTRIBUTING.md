# 贡献

短版：提 issue 说清现象和期望，改代码前先跑测试，别引入运行时依赖。

## 开发环境

只需要 Node ≥ 20。没有构建步骤，没有 bundler，没有依赖树：

```sh
node --test test/pool.test.mjs test/host.test.mjs
```

宿主编译器不参与——`lib/*.js` 直接就是发出去的产物。

## 代码分工

| 文件 | 职责 | 能碰网络/磁盘吗 |
| --- | --- | --- |
| `lib/pool.js` | 纯逻辑：失败分类、冷却表、选路 | 不能（测试靠这一点） |
| `lib/index.js` | 宿主半侧：挂钩子、注册工具、HTTP 路由 | 能 |
| `lib/client.js` | 浏览器半侧：侧边栏页面 | 只能 fetch 自家路由 |

`pool.js` 保持纯函数是刻意的：它的 30 个测试用例不碰网络、不碰磁盘、不需要宿主，
所以本地和 CI 都能秒跑。想加新逻辑优先放这里。

## 改客户端 bundle 的注意事项

`lib/client.js` 是手写的 `window.__ModuleLoader__.load({...})`，不是打包产物。写的时候：

- 不要 `import` 任何东西；用到的模块走 `require('react')` 这种平台外置表
- `exports.inject` 里列出的服务名，是 cordis 运行时服务名（如 `betterSidebar`），
  不是包名。**没列进去的服务，`ctx.get(name)` 会直接抛**
  `cannot get property "..." without inject`
- 整个文件必须能在脚本执行期就成功注册；materialize 阶段的错误会让 tab 静默消失

## 提交前

- 测试全绿
- 没有把本机路径、真实 API key、profile 名写进代码或文档
- 如果改了失败分类或冷却语义，同步更新 `README.md` 和 `README.en.md` 的表格

## 提 PR

一个 PR 一件事。行为改动请附上「为什么」，尤其是分类规则——把某个错误码从
「拉黑」挪到「放行」是有代价的，说明白代价你算过。
