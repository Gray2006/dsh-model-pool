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
  pickRoute,
  routeKey,
  sameRoute,
  shouldFailover,
} from './pool.js';

export const name = 'dsh-model-pool';
export const inject = ['tools'];

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
 * 语义刻意做成「剔除表」而不是「白名单」：文件里没提到的池条目默认启用。
 * 这样新加进 config.pool 的通道不需要去侧边栏再点一次，也不会因为一次
 * 手滑的写入就把整池关掉。`all` 为 true 时忽略一切剔除（「全选」）。
 */
function readSelection(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return { disabled: new Set() };
    const disabled = new Set(Array.isArray(parsed.disabled) ? parsed.disabled.filter((k) => typeof k === 'string') : []);
    return { disabled };
  } catch {
    return { disabled: new Set() };
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

  function persistSelection() {
    try {
      fs.mkdirSync(path.dirname(selectionFile), { recursive: true });
      fs.writeFileSync(
        selectionFile,
        JSON.stringify({ version: 1, disabled: [...selection.disabled].sort() }, null, 2),
        'utf8',
      );
    } catch (e) {
      log(`写勾选失败：${e?.message ?? e}`);
    }
  }

  /** 池里当前「在切换范围」的那些：默认全开，只减掉被手工剔除的。 */
  function enabledPool() {
    const kept = pool.filter((r) => !selection.disabled.has(routeKey(r)));
    // 一条都没勾时不能真的空转：退回整池，否则这个功能等于把模型全掐了
    return kept.length > 0 ? kept : pool;
  }

  const maxPerStep = cfg.maxFailoversPerStep > 0 ? cfg.maxFailoversPerStep : Math.max(pool.length, 1);

  /** 本会话里每一步实际用的路由：`turn:step` → route */
  const activeRoutes = new Map();
  /** 本会话里每一步已经换了几次：`turn:step` → count */
  const failovers = new Map();
  /** @type {{at: number, from: string, to: string, code: string} | null} */
  let lastSwitch = null;

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
      const until = cooldowns.strike(attempted, {
        code,
        message,
        baseMs: cfg.cooldownMs,
        maxMs: cfg.maxCooldownMs,
      });
      persist();
      log(`${routeKey(attempted)} 失败(${code || classifyFailure(code, message)}) → 冷却 ${Math.round((until - Date.now()) / 1000)}s`);
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
    isEnabled: (route) => !selection.disabled.has(routeKey(route)),
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
          const route = pool.find((r) => routeKey(r) === target);
          if (route === undefined) {
            return { text: `池里没有 ${target}。现有：${pool.map(routeKey).join('、') || '（空）'}` };
          }
          if (args?.enabled === false) selection.disabled.add(target);
          else selection.disabled.delete(target);
          persistSelection();
          return { text: `${target} 已${args?.enabled === false ? '移出' : '纳入'}自动切换范围。` };
        },
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
          const route = typeof body?.route === 'string' ? body.route.trim() : '';
          if (route === '') {
            sendJson(response, 400, { ok: false, error: '缺少 route' });
            return;
          }
          if (!pool.some((r) => routeKey(r) === route)) {
            sendJson(response, 404, { ok: false, error: `池里没有 ${route}`, ...snapshotState() });
            return;
          }
          if (body?.enabled === false) selection.disabled.add(route);
          else selection.disabled.delete(route);
          persistSelection();
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
    return {
      ok: true,
      enabled: cfg.enabled !== false,
      cooldownMs: cfg.cooldownMs,
      maxCooldownMs: cfg.maxCooldownMs,
      next: route === undefined ? null : routeKey(route),
      degraded: route !== undefined && cooldowns.isCooling(route, now),
      pool: pool.map((r) => {
        const remainingMs = cooldowns.remaining(r, now);
        return {
          route: routeKey(r),
          provider: r.provider,
          model: r.model,
          inScope: !selection.disabled.has(routeKey(r)),
          remainingMs,
          cooling: remainingMs > 0,
        };
      }),
    };
  }

  log(`ready — pool ${pool.map(routeKey).join(' → ') || '(空)'} · 冷却 ${cfg.cooldownMs / 1000}s~${cfg.maxCooldownMs / 1000}s · ${stateFile}`);

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
  const { pool, cooldowns, stateFile, maxPerStep, failovers } = registry;
  const now = Date.now();
  const lines = [];
  const usable = registry.usablePool();
  const scoped = registry.enabledPool();
  const scopedCount = scoped.length;
  lines.push(`额度池（${pool.length} 条，在切换范围 ${scopedCount} 条${usable.length !== scopedCount ? `，有适配器 ${usable.length} 条` : ''}）：`);
  if (pool.length === 0) lines.push('  （空 —— 插件不会切换任何路由）');
  for (const [index, route] of pool.entries()) {
    const ms = cooldowns.remaining(route, now);
    const inScope = registry.isEnabled(route);
    const state = !inScope ? '不在切换范围' : ms > 0 ? `冷却中，剩 ${fmt(ms)}` : '可用';
    lines.push(`  ${index + 1}. ${routeKey(route)} — ${state}`);
  }
  const excluded = pool.filter((r) => !registry.isEnabled(r));
  if (excluded.length > 0 && scopedCount === pool.length) {
    lines.push('（全部移出过，已自动退回整池，免得把模型全掐死）');
  }
  const cooling = cooldowns.snapshot(now);
  if (cooling.length > 0) {
    lines.push('冷却明细：');
    for (const entry of cooling) {
      lines.push(`  ${entry.route} · 剩 ${fmt(entry.remainingMs)}${entry.code ? ` · ${entry.code}` : ''}${entry.reason ? ` · ${trim(entry.reason, 80)}` : ''}`);
    }
  }
  const { route } = pickRoute({ pool: usable.length > 0 ? usable : pool, cooldowns });
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
