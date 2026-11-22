// dsh-model-pool —— 按额度自动换通道（DSH host 插件）
//
// 干两件事，都挂在已核实的宿主扩展点上：
//   1) agent/request        —— 当前路由在冷却期就换成池里下一个可用的
//   2) agent/request-error  —— 认出「这条通道废了」（额度/AUTH/MISSING_CREDENTIAL），
//                              拉黑它并让 loop 重跑同一步，于是 1) 会选到别的通道
//
// 刻意不做的事：
//   - 不主动发探测请求（那是花钱的行为），额度只从真实失败里学
//   - 不摘 RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT —— 那是抖动，宿主自己的重试策略负责
//   - 不抢用户手选的模型：当前路由没在冷却就原样放行
//
// 状态落在 %DSH_HOME%/model-pool-state.json，重启后仍记得谁在冷却。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Cooldowns,
  classifyFailure,
  isConcurrencyFailure,
  pickRoute,
  routeKey,
  sameRoute,
  shouldFailover,
} from './pool.js';

export const name = 'dsh-model-pool';
// llm 是扫描全部模型用的（listProviders/listModels）；没有它自动切换照常工作，
// 只是候选集退回 config.pool，侧边栏列不出扫描结果。
export const inject = ['tools', 'llm'];

const TEXT_OUTPUT = {
  schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

/** 只在 config.debug 打开时说话；发布版不该每次加载都往宿主日志里灌东西。 */
let debugEnabled = false;
const log = (...args) => {
  if (!debugEnabled) return;
  try { console.log(`[${name}]`, ...args); } catch {}
};
/** 诊断类消息（客户端各阶段上报）走这条，默认静默。 */
const diag = (...args) => {
  if (!debugEnabled) return;
  try { console.log(`[${name}]`, ...args); } catch {}
};

/**
 * 换通道播报。不受 debug 控制：切没切是使用者最需要知道的事，
 * 静默切换只会让人怀疑插件根本没工作。
 * 由 start() 赋值（它知道名字和宿主 logger）。
 */
let loggerRef = null;

const DEFAULTS = {
  enabled: true,
  pool: [],
  /** 首次失败冷却多久；连续失败指数退避。 */
  cooldownMs: 10 * 60_000,
  maxCooldownMs: 60 * 60_000,
  /**
   * 并发撞车的冷却时长。固定值，不参与指数退避。
   * 并发槽位通常几秒内释放，用 10 分钟罚它就把一条好通道白白闲置了。
   */
  concurrencyCooldownMs: 20_000,
  /** 同一步最多换几次通道；0 表示按池大小自动。 */
  maxFailoversPerStep: 0,
  /** 冷却表落盘路径，空则用 %DSH_HOME%/model-pool-state.json。 */
  statePath: '',
  persist: true,
  /** 打开后往宿主日志写装配与客户端诊断信息；默认关。 */
  debug: false,
};

/** 侧边栏写的「哪些通道在切换范围」落在独立的文件里，和冷却表分开。 */
const SELECTION_FILE = 'model-pool-selection.json';

/**
 * 侧边栏勾选的启用集合。
 *
 * 语义是「白名单」：扫描出来的模型可能几十个，默认全开会把各种小模型也塞进池里，
 * 换过去反而坑自己。所以只记**勾上的**。
 *
 * 但保留一个 `all` 开关（全选），以及向后兼容：老版本写的是 {disabled:[...]}，
 * 读到那种格式就当作「除这些之外都启用」，避免升级后勾选全丢。
 */
function readSelection(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return { enabled: new Set(), all: false, legacy: null, saved: false };
    const enabled = new Set(
      Array.isArray(parsed.enabled) ? parsed.enabled.filter((k) => typeof k === 'string') : [],
    );
    const all = parsed.all === true;
    // 老格式：{version:1, disabled:[...]} —— 转成「除这些之外全开」
    const legacy = Array.isArray(parsed.disabled) && parsed.all === undefined
      ? new Set(parsed.disabled.filter((k) => typeof k === 'string'))
      : null;
    // saved=true 表示用户明确表过态（勾过 / 全选 / 或写的是老格式），
    // 这时候就不能再自作聪明地退回 config.pool
    const saved = all || enabled.size > 0 || legacy !== null;
    return { enabled, all, legacy, saved };
  } catch {
    return { enabled: new Set(), all: false, legacy: null, saved: false };
  }
}

function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function normalizeRoute(raw) {
  if (raw === null || typeof raw !== 'object') return undefined;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (provider === '' || model === '') return undefined;
  const route = { provider, model };
  if (typeof raw.reasoningEffort === 'string' && raw.reasoningEffort !== '') route.reasoningEffort = raw.reasoningEffort;
  if (Number.isFinite(raw.maxTokens) && raw.maxTokens > 0) route.maxTokens = raw.maxTokens;
  return route;
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return [];
    const list = Array.isArray(parsed.entries) ? parsed.entries : [];
    return list.filter((entry) => entry && typeof entry.route === 'string' && Number.isFinite(entry.until));
  } catch {
    return [];
  }
}

/**
 * 扫宿主里所有「已配好且 key 可用」的模型，作为额度池的候选全集。
 *
 * 两条宿主接口（已核实）：
 *   llm.listProviders()      → [{ id, ... }] 已注册适配器的 provider
 *   await llm.listModels(id) → [{ provider, id, name, ... }] 该 provider 能用的模型
 *
 * 适配器在 key 缺失时返回空数组（pi-ai 就是先 resolveApiKey，MISSING_CREDENTIAL 时返 []），
 * 所以扫出来的天然就是「能用」的那些，不需要我们判断凭据。
 *
 * @returns {Promise<{routes: Array, failed: number}>} failed=有适配器但列不出模型的 provider 数
 */
async function scanModels(ctx) {
  const routes = [];
  let failed = 0;
  let llm;
  try {
    llm = ctx.get('llm');
  } catch {
    return { routes, failed: 0 };
  }
  if (!llm || typeof llm.listProviders !== 'function') return { routes, failed: 0 };

  let providers = [];
  try {
    providers = llm.listProviders();
  } catch {
    return { routes, failed: 0 };
  }
  if (!Array.isArray(providers)) return { routes, failed: 0 };

  for (const provider of providers) {
    const id = typeof provider?.id === 'string' ? provider.id : '';
    if (id === '') continue;
    if (typeof llm.listModels !== 'function') continue;
    try {
      const models = await llm.listModels(id);
      if (!Array.isArray(models)) { failed += 1; continue; }
      for (const model of models) {
        const modelId = typeof model?.id === 'string' ? model.id : '';
        if (modelId === '') continue;
        routes.push({ provider: id, model: modelId });
      }
    } catch {
      // 单个 provider 挂掉不影响别的
      failed += 1;
    }
  }
  return { routes, failed };
}

export function apply(ctx, config) {
  // 配置写错不能拖死整个 profile：任何一步炸了都只停掉本插件。
  // 这一条永远要说：插件悄悄不工作比报错更难查。
  try {
    start(ctx, config);
  } catch (error) {
    try {
      console.error(`[${name}] 启动失败，本插件不生效：${error?.message ?? error}`);
    } catch { /* 连 stderr 都没有就算了 */ }
  }
}

function start(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  debugEnabled = cfg.debug === true;
  // 换通道播报始终可见
  loggerRef = (...args) => {
    try { console.log(`[${name}]`, ...args); } catch { /* 忽略 */ }
  };
  const pool = Array.isArray(cfg.pool) ? cfg.pool.map(normalizeRoute).filter(Boolean) : [];
  if (pool.length === 0) {
    // 空池同样是「装了但没生效」，也不该被 debug 吞掉
    try { console.warn(`[${name}] pool 为空 —— 不做任何切换（检查 config.pool）`); } catch { /* 忽略 */ }
  }

  const stateFile = cfg.statePath && String(cfg.statePath).trim()
    ? path.resolve(String(cfg.statePath).trim())
    : path.join(homeDir(), 'model-pool-state.json');

  const cooldowns = new Cooldowns();
  if (cfg.persist !== false) {
    for (const entry of readState(stateFile)) {
      const [provider, ...rest] = entry.route.split('/');
      const model = rest.join('/');
      if (provider === '' || model === '') continue;
      cooldowns.entries.set(routeKey({ provider, model }), {
        until: entry.until,
        code: typeof entry.code === 'string' ? entry.code : '',
        reason: typeof entry.reason === 'string' ? entry.reason : '',
        strikes: Number.isFinite(entry.strikes) ? entry.strikes : 1,
      });
    }
  }

  function persist() {
    if (cfg.persist === false) return;
    try {
      const now = Date.now();
      const entries = [];
      for (const [key, entry] of cooldowns.entries) {
        if (entry.until <= now) continue;
        entries.push({ route: key, until: entry.until, code: entry.code, reason: entry.reason, strikes: entry.strikes });
      }
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
    } catch (e) {
      log(`写状态失败：${e?.message ?? e}`);
    }
  }

  // —— 侧边栏勾选的启用集合 ——
  const selectionFile = path.join(homeDir(), SELECTION_FILE);
  const selection = readSelection(selectionFile);

  /**
   * 用户第一次动勾选前，先把「当前实际生效的那一组」物化进 selection.enabled。
   *
   * 不这么做的话：初始 saved=false 时 enabledPool() 退回 config.pool（A、B 都在用），
   * 但 enabled 集合是空的 —— 用户取消 B 只是 delete 一个本来就不在里面的 key，
   * 结果写盘成「一条都没勾」，重启后整池消失。
   */
  function materializeSelection() {
    if (selection.saved) return;
    const active = enabledPool();
    selection.enabled = new Set(active.map(routeKey));
    selection.all = false;
    selection.legacy = null;
  }

  /** 改一条通道的勾选状态。 */
  function setRouteEnabled(route, enabled) {
    materializeSelection();
    if (enabled) selection.enabled.add(routeKey(route));
    else selection.enabled.delete(routeKey(route));
    selection.all = false;
    selection.legacy = null;
    persistSelection();
  }

  function persistSelection() {
    try {
      selection.saved = true;
      fs.mkdirSync(path.dirname(selectionFile), { recursive: true });
      fs.writeFileSync(
        selectionFile,
        JSON.stringify(
          { version: 2, all: selection.all, enabled: [...selection.enabled].sort() },
          null,
          2,
        ),
        'utf8',
      );
    } catch (e) {
      log(`写勾选失败：${e?.message ?? e}`);
    }
  }

  /**
   * 扫描到的全部候选模型（host 侧一份缓存，刷新时才重扫）。
   * scanError 记录上一次扫描的失败情况，侧边栏要能显示「为什么列表是空的」。
   */
  let scanned = { routes: [], failed: 0, at: 0, error: '' };

  /** 重新扫描；失败不抛，只记录原因。 */
  async function refreshScan() {
    try {
      const result = await scanModels(ctx);
      scanned = { ...result, at: Date.now(), error: '' };
    } catch (e) {
      scanned = { ...scanned, at: Date.now(), error: String(e?.message ?? e) };
    }
    return scanned;
  }

  /**
   * 候选全集 = config.pool（手写的，排在前面，用来定优先级）
   *            + 扫出来的其他模型（按 provider 分组，去重）。
   *
   * 为什么两者都要：手写的那几条是用户明确想优先用的；扫出来的是「还能用的」。
   * 如果只信扫描，用户没法表达优先级；如果只信手写，就有了原来那个
   * 「加个模型得去改 YAML 再重启」的毛病。
   */
  function candidatePool() {
    const seen = new Set();
    const out = [];
    for (const route of pool) {
      const key = routeKey(route);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(route);
    }
    for (const route of scanned.routes) {
      const key = routeKey(route);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(route);
    }
    return out;
  }

  /**
   * 池里当前「在切换范围」的那些。
   *
   * 语义：白名单（只认勾上的）。退回 config.pool 只在一种情况下发生——
   * 用户从来没保存过任何勾选（刚装好、没打开过侧边栏）。一旦他动手勾过，
   * 就完全按他的意思来：全部取消就是全部取消，不能自作聪明地退回，
   * 否则「移出某条」在只剩两条池时根本不生效。
   */
  function enabledPool() {
    const candidates = candidatePool();
    if (candidates.length === 0) return [];

    // 老版本格式：{disabled:[...]} → 除这些之外全启用
    if (selection.legacy !== null) {
      return candidates.filter((r) => !selection.legacy.has(routeKey(r)));
    }
    if (selection.all) return candidates;

    if (selection.saved) {
      // 用户已经表过态：严格按白名单
      return candidates.filter((r) => selection.enabled.has(routeKey(r)));
    }

    // 从没保存过勾选：退回 config.pool，装好就能用
    return pool.length > 0 ? pool : candidates;
  }

  const maxPerStep = cfg.maxFailoversPerStep > 0 ? cfg.maxFailoversPerStep : Math.max(pool.length, 1);

  /** 本会话里每一步实际用的路由：`turn:step` → route */
  const activeRoutes = new Map();
  /** 本会话里每一步已经换了几次：`turn:step` → count */
  const failovers = new Map();
  /** @type {{at: number, from: string, to: string, code: string} | null} */
  let lastSwitch = null;
  // 手选路由（宿主 seed，即 /model 里显示的值）与本步实际使用的路由。
  // 两者可能不同：插件在请求层换路，UI 未必跟得上。
  let lastManual = null;
  /** 本步实际发出去的路由。和 lastManual 不同时说明插件换过路。 */
  let lastActual = null;

  /** 在切换范围内、且 provider 集合里有适配器的那些（拿不到 llm 服务时不过滤）。 */
  function usablePool() {
    const scoped = enabledPool();
    let providers;
    try {
      const llm = ctx.get('llm');
      if (llm && typeof llm.listProviders === 'function') {
        const list = llm.listProviders();
        if (Array.isArray(list) && list.length > 0) providers = new Set(list.map((p) => p.id));
      }
    } catch { /* 忽略：退回整池 */ }
    if (providers === undefined) return scoped;
    const filtered = scoped.filter((r) => providers.has(r.provider));
    return filtered.length > 0 ? filtered : scoped;
  }

  function prune(turn) {
    for (const key of activeRoutes.keys()) {
      if (!key.startsWith(`${turn}:`)) activeRoutes.delete(key);
    }
    for (const key of failovers.keys()) {
      if (!key.startsWith(`${turn}:`)) failovers.delete(key);
    }
  }

  // —— 1) 请求路由：只有当前路由在冷却时才换 ——
  // prepend：必须先于 model-selection 之类的下游改写跑，否则它会把路由又盖回手选值
  const disposeRequest = ctx.on('agent/request', async (payload, next) => {
    const resolved = await next();
    if (cfg.enabled === false || pool.length === 0) return resolved;
    if (!resolved || typeof resolved !== 'object') return resolved;

    const current = { provider: resolved.provider, model: resolved.model };
    if (typeof current.provider !== 'string' || typeof current.model !== 'string') return resolved;

    const turn = Number.isFinite(payload?.turn) ? payload.turn : 0;
    const step = Number.isFinite(payload?.step) ? payload.step : 0;
    prune(turn);
    // 手选值 = 宿主 seed（/model 里显示的那个）。插件换路后它不会变，
    // 所以两者要分别记下来，侧边栏才能说清「你以为走 A，其实走了 B」。
    lastManual = routeKey(current);
    let chosen = current;

    if (cooldowns.isCooling(current)) {
      const { route } = pickRoute({ pool: usablePool(), cooldowns });
      if (route !== undefined && !sameRoute(route, current)) {
        lastSwitch = { at: Date.now(), from: routeKey(current), to: routeKey(route), code: lastSwitch?.code ?? '' };
        log(`route ${routeKey(current)} 在冷却 → ${routeKey(route)}`);
        chosen = route;
      }
    }

    activeRoutes.set(`${turn}:${step}`, chosen);
    lastActual = routeKey(chosen);
    if (sameRoute(chosen, current)) return resolved;
    // 换通道时丢掉继承来的 reasoningEffort 与 maxTokens：
    // 前者是上一条通道的强度词汇，后者可能超过目标模型的上限，
    // 两者都会让 prepareCall 直接拒掉这次请求 —— 换通道反而弄死这一轮。
    // 交给目标适配器用自己的默认值。
    const { reasoningEffort: _inheritedEffort, maxTokens: _inheritedMaxTokens, ...rest } = resolved;
    return {
      ...rest,
      provider: chosen.provider,
      model: chosen.model,
      ...chosen.reasoningEffort === undefined ? {} : { reasoningEffort: chosen.reasoningEffort },
      ...chosen.maxTokens === undefined ? {} : { maxTokens: chosen.maxTokens },
    };
  }, { prepend: true });

  // —— 2) 失败归因：额度/鉴权这类硬伤就拉黑并重跑同一步 ——
  const disposeError = ctx.on('agent/request-error', async (payload, next) => {
    if (cfg.enabled === false || pool.length === 0) return next();
    const failure = payload?.failure ?? {};
    const code = typeof failure.code === 'string' ? failure.code : '';
    const message = typeof failure.message === 'string' ? failure.message : '';
    if (!shouldFailover(code, message)) return next();

    const turn = Number.isFinite(payload?.turn) ? payload.turn : 0;
    const step = Number.isFinite(payload?.step) ? payload.step : 0;
    const key = `${turn}:${step}`;
    const provider = typeof payload?.provider === 'string' ? payload.provider : '';

    // 优先用这一步实际请求的路由；取不到就按 provider 在池里找
    const attempted = activeRoutes.get(key)
      ?? [lastSwitch?.from, lastSwitch?.to].map(parseKey).find((r) => r !== undefined && r.provider === provider)
      ?? pool.find((r) => r.provider === provider && cooldowns.isCooling(r))
      ?? pool.find((r) => r.provider === provider);

    if (attempted !== undefined) {
      // 并发撞车：换通道有用（对面有自己的并发额度），但冷却只要几秒，
      // 而且不能计入连续失败次数。
      const concurrency = isConcurrencyFailure(code, message);
      const until = cooldowns.strike(attempted, {
        code,
        message,
        baseMs: cfg.cooldownMs,
        maxMs: cfg.maxCooldownMs,
        ...concurrency
          ? { fixedMs: cfg.concurrencyCooldownMs, noStrike: true }
          : {},
      });
      persist();
      const kind = concurrency ? '并发撞车' : '失败';
      log(`${routeKey(attempted)} ${kind}(${code || classifyFailure(code, message)}) → 冷却 ${Math.round((until - Date.now()) / 1000)}s`);
    } else {
      log(`失败(${code || '?'}) 但认不出是哪条通道：provider=${provider}`);
    }

    const used = failovers.get(key) ?? 0;
    if (used >= maxPerStep) {
      log(`step ${key} 已换 ${used} 次，放弃切换`);
      return next();
    }
    const { route } = pickRoute({ pool: usablePool(), cooldowns });
    if (route === undefined) return next();
    if (attempted !== undefined && sameRoute(route, attempted)) {
      log(`没有别的通道可换（全在冷却），放弃`);
      return next();
    }
    failovers.set(key, used + 1);
    if (lastSwitch !== null) lastSwitch.code = code;
    // 这条不受 debug 控制：切没切是使用者最需要知道的事，
    // 静默切换只会让人怀疑插件根本没工作。
    if (typeof loggerRef === 'function') {
      loggerRef(`换通道 ${attempted !== undefined ? routeKey(attempted) : provider}`
        + ` → ${routeKey(route)}（${code || classifyFailure(code, message)}）`);
    }
    return { kind: 'retry' };
  });

  // —— 3) 工具 ——
  const disposers = [];
  const registry = {
    pool, cooldowns, stateFile, maxPerStep, failovers,
    lastSwitch: () => lastSwitch,
    usablePool,
    enabledPool,
    candidatePool: () => candidatePool(),
    scanInfo: () => scanned,
    isEnabled: (route) => enabledPool().some((r) => routeKey(r) === routeKey(route)),
  };
  try {
    const tools = ctx.get('tools');
    if (tools) {
      disposers.push(tools.register({
        name: 'model_pool_status',
        description: '看模型额度池：池里有哪些通道、谁在冷却、下次请求会走哪条、本会话已经换过几次。只读。',
        output: TEXT_OUTPUT,
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        async execute() {
          return { text: renderStatus(registry) };
        },
      }));
      disposers.push(tools.register({
        name: 'model_pool_reset',
        description: '手动解除冷却（全部或指定一条通道），让额度池立刻回到首选。充值到账后用它恢复。',
        output: TEXT_OUTPUT,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            route: { type: 'string', description: '要解除的通道，写成 provider/model；省略则清全部。' },
          },
        },
        async execute(args) {
          const target = typeof args?.route === 'string' ? args.route.trim() : '';
          if (target === '') {
            cooldowns.clearAll();
            persist();
            return { text: '已清空全部冷却，池按配置顺序重新开始。' };
          }
          const route = pool.find((r) => routeKey(r) === target);
          if (route === undefined) {
            return { text: `池里没有 ${target}。现有：${pool.map(routeKey).join('、') || '（空）'}` };
          }
          cooldowns.clear(route);
          persist();
          return { text: `已解除 ${target} 的冷却。` };
        },
      }));
      disposers.push(tools.register({
        name: 'model_pool_toggle',
        description: '把池里某条通道加入或移出「自动切换范围」。侧边栏的额度池页面也能点，效果一样。',
        output: TEXT_OUTPUT,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['route', 'enabled'],
          properties: {
            route: { type: 'string', description: '池里的通道，写成 provider/model。' },
            enabled: { type: 'boolean', description: 'true = 纳入切换范围，false = 移出。' },
          },
        },
        async execute(args) {
          const target = typeof args?.route === 'string' ? args.route.trim() : '';
          const candidates = candidatePool();
          const route = candidates.find((r) => routeKey(r) === target);
          if (route === undefined) {
            return { text: `候选里没有 ${target}。现有：${candidates.map(routeKey).join('、') || '（空）'}` };
          }
          setRouteEnabled(route, args?.enabled !== false);
          return { text: `${target} 已${args?.enabled === false ? '移出' : '纳入'}自动切换范围。` };        },
      }));
    } else {
      log('没有 tools 服务 —— 只挂路由钩子，不注册工具');
    }
  } catch (e) {
    log(`注册工具失败：${e?.message ?? e}`);
  }

  // —— 4) 给侧边栏额度池页面用的 HTTP 路由 ——
  // 网页那半是普通浏览器代码，只能靠 HTTP 跟这里说话；走 webServer 的具名路由。
  // 用 ctx.inject 等 webServer 就绪再挂：apply 跑的时候它可能还没起来，
  // 直接 ctx.get() 会拿到 undefined，路由就永远注册不上了。
  try {
    ctx.inject(['webServer'], (scoped) => {
      const webServer = scoped.webServer ?? scoped.get('webServer');
      if (!webServer || typeof webServer.register !== 'function') {
        log('webServer 不可用 —— 侧边栏页面读不到状态（不影响自动切换）');
        return;
      }
      scoped.effect(() => {
        const dispose = webServer.register({
          kind: 'exact',
          path: '/model-pool/state',
          handler: async (request, response) => {
          if (request.method === 'GET') {
            sendJson(response, 200, snapshotState());
            return;
          }
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'GET, POST' });
            response.end();
            return;
          }
          // 会改磁盘的请求：只认同源，别让别的页面替你改勾选
          if (!sameOrigin(request)) {
            sendJson(response, 403, { ok: false, error: 'untrusted origin' });
            return;
          }
          let body;
          try {
            body = await readJsonBody(request);
          } catch (e) {
            sendJson(response, 400, { ok: false, error: `读请求体失败：${e?.message ?? e}` });
            return;
          }
          // 自检通道：客户端 bundle 各阶段会 ping，日志里就能定位断在哪
          if (typeof body?.ping === 'string') {
            const extra = typeof body?.error === 'string' && body.error ? ` —— ${body.error}` : '';
            diag(`客户端诊断：${body.ping}${extra}`);
            sendJson(response, 200, { ok: true });
            return;
          }
          // 重新扫描全部模型（不重启就能看到新配的 provider）
          if (body?.rescan === true) {
            await refreshScan();
            sendJson(response, 200, snapshotState());
            return;
          }
          // 全选 / 全不选
          if (typeof body?.all === 'boolean') {
            selection.all = body.all;
            if (body.all) selection.enabled.clear();
            selection.legacy = null;
            persistSelection();
            sendJson(response, 200, snapshotState());
            return;
          }
          const route = typeof body?.route === 'string' ? body.route.trim() : '';
          if (route === '') {
            sendJson(response, 400, { ok: false, error: '缺少 route' });
            return;
          }
          if (!candidatePool().some((r) => routeKey(r) === route)) {
            sendJson(response, 404, { ok: false, error: `候选里没有 ${route}`, ...snapshotState() });
            return;
          }
          // 一勾就把「全选」取消掉：勾选是具体集合，和 all 不能同时成立
          const target = candidatePool().find((r) => routeKey(r) === route);
          setRouteEnabled(target, body?.enabled !== false);
          sendJson(response, 200, snapshotState());
        },
        });
        log('HTTP 已挂 /model-pool/state —— 侧边栏可以读写了');
        return dispose;
      }, `${name}: http route`);
    });
  } catch (e) {
    log(`注册 HTTP 路由失败：${e?.message ?? e}`);
  }

  /** 侧边栏一次性要的全部状态。 */
  function snapshotState() {
    const now = Date.now();
    const { route } = pickRoute({ pool: usablePool(), cooldowns });
    const candidates = candidatePool();
    const inScope = new Set(enabledPool().map(routeKey));
    return {
      ok: true,
      enabled: cfg.enabled !== false,
      cooldownMs: cfg.cooldownMs,
      maxCooldownMs: cfg.maxCooldownMs,
      next: route === undefined ? null : routeKey(route),
      degraded: route !== undefined && cooldowns.isCooling(route, now),
      // 「/model 显示的路由」vs「实际发出去的路由」。不一致时侧边栏要明说，
      // 否则用户会以为自己手选的那条在跑。
      manual: lastManual,
      actual: lastActual,
      swapped: lastManual !== null && lastActual !== null && lastManual !== lastActual,
      // 扫描与勾选状态，侧边栏要用来渲染「全部模型 + 勾选」
      scannedAt: scanned.at || null,
      scanError: scanned.error,
      scanFailed: scanned.failed,
      all: selection.all,
      // 候选全集：config.pool 在前，扫出来的在后
      candidates: candidates.map((r) => routeKey(r)),
      pool: candidates.map((r) => {
        const remainingMs = cooldowns.remaining(r, now);
        return {
          route: routeKey(r),
          provider: r.provider,
          model: r.model,
          inScope: inScope.has(routeKey(r)),
          pinned: pool.some((p) => routeKey(p) === routeKey(r)),
          remainingMs,
          cooling: remainingMs > 0,
        };
      }),
    };
  }

  log(`ready — pool ${pool.map(routeKey).join(' → ') || '(空)'} · 冷却 ${cfg.cooldownMs / 1000}s~${cfg.maxCooldownMs / 1000}s · ${stateFile}`);

  // 启动时扫一次全部模型：侧边栏一打开就能看到候选，不用先点刷新
  refreshScan().then((result) => {
    log(`扫描到 ${result.routes.length} 个模型${result.failed > 0 ? `（${result.failed} 个 provider 列不出来）` : ''}`);
  }).catch(() => { /* 扫描失败不影响自动切换 */ });

  ctx.effect(() => () => {
    try { disposeRequest(); } catch { /* ignore */ }
    try { disposeError(); } catch { /* ignore */ }
    for (const dispose of disposers) { try { dispose?.(); } catch { /* ignore */ } }
  }, `${name}: hooks`);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

/** 会改磁盘的请求要求 Origin 与 Host 一致，挡掉别的页面替你改勾选。 */
function sameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined || host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJsonBody(request, limitBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

function parseKey(key) {  if (typeof key !== 'string') return undefined;
  const index = key.indexOf('/');
  if (index <= 0 || index === key.length - 1) return undefined;
  return { provider: key.slice(0, index), model: key.slice(index + 1) };
}

function renderStatus(registry) {
  const { cooldowns, stateFile, maxPerStep, failovers } = registry;
  const now = Date.now();
  const lines = [];
  const usable = registry.usablePool();
  const scoped = registry.enabledPool();
  const candidates = registry.candidatePool();
  const scan = registry.scanInfo();
  const scopedKeys = new Set(scoped.map(routeKey));
  const usableKeys = new Set(usable.map(routeKey));

  lines.push(`额度池（候选 ${candidates.length} 条，在切换范围 ${scoped.length} 条）：`);
  if (scan?.at && candidates.length > 0) {
    lines.push(`  扫描到 ${scan.routes.length} 个可用模型${scan.failed > 0 ? `（${scan.failed} 个 provider 列不出来）` : ''}`);
  }
  if (scan?.error) lines.push(`  上次扫描失败：${trim(scan.error, 120)}`);
  if (candidates.length === 0) {
    lines.push('  （没有候选 —— 检查 provider 是否配好 key，或 config.pool 是否为空）');
  }
  for (const [index, route] of candidates.entries()) {
    const key = routeKey(route);
    const ms = cooldowns.remaining(route, now);
    const state = !scopedKeys.has(key)
      ? '不在切换范围'
      : ms > 0
        ? `冷却中，剩 ${fmt(ms)}`
        : usableKeys.has(key) ? '可用' : '无适配器';
    lines.push(`  ${index + 1}. ${key} — ${state}`);
  }
  if (scoped.length === 0 && candidates.length > 0) {
    lines.push('（一条都没勾 —— 插件不会切换任何路由；去侧边栏勾上至少一条）');
  }
  const cooling = cooldowns.snapshot(now);
  if (cooling.length > 0) {
    lines.push('冷却明细：');
    for (const entry of cooling) {
      lines.push(`  ${entry.route} · 剩 ${fmt(entry.remainingMs)}${entry.code ? ` · ${entry.code}` : ''}${entry.reason ? ` · ${trim(entry.reason, 80)}` : ''}`);
    }
  }
  const { route } = pickRoute({ pool: usable.length > 0 ? usable : scoped, cooldowns });
  const degraded = route !== undefined && cooldowns.isCooling(route, now);
  lines.push(route === undefined ? '下次请求：无可用通道' : `下次请求：${routeKey(route)}${degraded ? '（全池冷却，退化试最早解冻的一条）' : ''}`);
  const switches = [...failovers.entries()].map(([key, n]) => `${key} 换了 ${n} 次`).join('、');
  lines.push(`本会话换通道：${switches || '还没有'}（每步上限 ${maxPerStep} 次）`);
  const last = registry.lastSwitch();
  if (last) lines.push(`最近一次：${last.from} → ${last.to}${last.code ? `（${last.code}）` : ''}`);
  lines.push(`状态文件：${stateFile}`);
  return lines.join('\n');
}

function fmt(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

function trim(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
