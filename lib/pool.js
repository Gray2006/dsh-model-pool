// dsh-model-pool —— 额度池的路由与冷却逻辑（纯函数，不碰宿主）
//
// 设计要点：
//  1. 池 = 有序的路由列表 [{provider, model}]，顺序即优先级。
//  2. 可用性 = 不在冷却期。冷却由失败码驱动：只有 AUTH / QUOTA / ACCOUNT_QUOTA /
//     MISSING_CREDENTIAL 这类「这条通道真的不通」的码才拉黑它；RATE_LIMIT /
//     SERVER / TIMEOUT / TRANSPORT 是抖动，交给宿主自己的重试策略，不摘通道。
//  3. 全池都在冷却时，退化为「最久没被拉黑的那一条」，宁可试也别空转。

/** 触发摘除通道的失败码（这条通道暂时/永久不可用）。 */
export const BENCH_CODES = new Set([
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'NO_ADAPTER',
]);

/** 抖动类失败码：不摘通道，交给宿主重试策略。 */
export const SOFT_CODES = new Set([
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
  'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED',
]);

/** 余额不足的中文/英文兜底词表（适配器可能没把失败归成 QUOTA）。 */
const QUOTA_TEXT = [
  /余额不足/,
  /额度(不足|已用尽|用完)/,
  /配额(不足|已用尽)/,
  /充值/,
  /欠费/,
  /insufficient[\s_-]*(quota|balance|credits?)/i,
  /quota[\s_-]*(exceeded|exhausted|reached)/i,
  /balance[\s_-]*(exhausted|depleted|insufficient)/i,
  /out[\s_-]+of[\s_-]+(credits?|budget)/i,
  // 「reached your weekly usage limit for your plan」「usage limit reached」这类：
  // 供应商常把套餐额度耗尽包成 429 rate_limit_error，光看 code 会被当成抖动放行。
  /(reached|exceeded|hit)[\s\w'-]{0,40}usage[\s_-]*limit/i,
  /usage[\s_-]*limit[\s_-]*(reached|exceeded|exhausted)/i,
  /(weekly|monthly|daily)[\s\w'-]{0,30}limit[\s\w'-]{0,20}(reached|exceeded)/i,
  /(升级|续费)[\s\w]*套餐/,
];

const AUTH_TEXT = [
  /unauthori[sz]ed/i,
  /invalid[\s_-]*(api[\s_-]*)?key/i,
  /incorrect[\s_-]*api[\s_-]*key/i,
  /authentication/i,
  /鉴权失败/,
  /密钥(无效|错误|过期)/,
];

/**
 * 并发槽位撞车：这不是「这条通道没有额度」，而是「这一刻它同时在跑别的请求」。
 *
 * 和普通限流的区别很实际：普通限流罚的是这一整条通道（换个通道确实可能也有号），
 * 而并发限制是**按通道各自算**的——另一条通道有自己独立的并发额度，换过去立刻就能跑。
 * 所以它必须触发切换。
 *
 * 但它也不该占用普通冷却的 10 分钟：并发槽位通常在几秒内就释放了。所以冷却时长
 * 单独给一个很短的默认值，而且**不计入连续失败次数**，免得一次并发撞车把这条通道
 * 的退避阶梯推高。
 */
const CONCURRENCY_TEXT = [
  /concurren(t|cy)[\s_-]*(request|limit|connection)/i,
  /too[\s_-]*many[\s_-]*concurrent/i,
  /maximum[\s_-]*concurren/i,
  /同时(请求|运行|执行)/,
  /并发(限制|超限|过多|数[量已])/,
  /已达(到)?(最大)?并发/,
];

/** 这条失败是不是并发撞车（而非额度耗尽或普通限流）。 */
export function isConcurrencyFailure(code, message) {
  const text = typeof message === 'string' ? message : '';
  return CONCURRENCY_TEXT.some((re) => re.test(text));
}

/**
 * 把一次失败归一成「该不该摘这条通道」。
 * @param {string} code 失败码（failure.code），可能缺失。
 * @param {string} message 失败文本，用于兜底识别。
 * @returns {'bench'|'soft'} bench=摘通道，soft=留着重试
 */
export function classifyFailure(code, message) {
  const text = typeof message === 'string' ? message : '';
  // 并发撞车优先于一切：它命中时往往 code 也是 RATE_LIMIT（宿主归的），
  // 但换通道是对的，所以必须先于软码判断。
  if (isConcurrencyFailure(code, text)) return 'bench';
  if (BENCH_CODES.has(code)) return 'bench';
  // 文本比软码更具体：适配器把「额度已用尽」笼统归成 SERVER/RATE_LIMIT 时，
  // 认文本才不会白烧掉剩下的重试次数
  if (QUOTA_TEXT.some((re) => re.test(text))) return 'bench';
  if (AUTH_TEXT.some((re) => re.test(text))) return 'bench';
  if (SOFT_CODES.has(code)) return 'soft';
  return 'soft';
}

/**
 * 是否值得为了换通道而重跑同一步。
 * 上下文超限、图片超限这类是「换谁都没用」或「换谁都要换策略」的情况，不试。
 */
export function shouldFailover(code, message) {
  if (code === 'CONTEXT_WINDOW_EXCEEDED' || code === 'IMAGE_OFFLOAD_REQUIRED') return false;
  return classifyFailure(code, message) === 'bench';
}

export function routeKey(route) {
  return `${route.provider}/${route.model}`;
}

export function sameRoute(a, b) {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.model === b.model;
}

/**
 * 池条目 vs 探到的通道：探到的只带 provider 时算 provider 级匹配。
 * （llm.listProviders() 只报 provider，不报具体 model。）
 */
export function matchRoute(probe, route) {
  if (probe === undefined || route === undefined) return false;
  if (probe.provider !== route.provider) return false;
  return probe.model === undefined || probe.model === '' || probe.model === route.model;
}

/**
 * 冷却表。时间由外部注入，方便测试。
 */
export class Cooldowns {
  /** @param {{now?: () => number}} [options] */
  constructor(options = {}) {
    this.now = options.now ?? Date.now;
    /** @type {Map<string, {until: number, reason: string, code: string, strikes: number}>} */
    this.entries = new Map();
  }

  /**
   * 记录一次失败，返回本次冷却到什么时候。
   *
   * @param {object} options
   * @param {number} [options.baseMs] 首次冷却时长
   * @param {number} [options.fixedMs] 直接指定本次冷却时长，不参与指数退避
   * @param {boolean} [options.noStrike] true 时不计入连续失败次数（并发撞车用）
   */
  strike(route, { code, message, baseMs, maxMs, fixedMs, noStrike = false, now = this.now() }) {
    const key = routeKey(route);
    const previous = this.entries.get(key);
    let strikes = (previous && previous.until > now ? previous.strikes : 0) + 1;
    if (noStrike) {
      // 并发撞车不该推高退避阶梯：槽位几秒就释放了，把它当成「连续失败」会让
      // 这条通道下次真的出问题时从更高的冷却开始，属于冤枉它。
      strikes = 1;
    }
    const duration = fixedMs !== undefined
      ? fixedMs
      : Math.min(baseMs * 2 ** (strikes - 1), maxMs);
    const until = now + duration;
    this.entries.set(key, { until, reason: message ?? '', code: code ?? '', strikes });
    return until;
  }

  /** 手动清掉一条（通道恢复时用）。 */
  clear(route) {
    this.entries.delete(routeKey(route));
  }

  clearAll() {
    this.entries.clear();
  }

  /** 剩余冷却毫秒；0 表示可用。 */
  remaining(route, now = this.now()) {
    const entry = this.entries.get(routeKey(route));
    if (entry === undefined) return 0;
    return Math.max(0, entry.until - now);
  }

  isCooling(route, now = this.now()) {
    return this.remaining(route, now) > 0;
  }

  /** 供工具/日志读的快照。 */
  snapshot(now = this.now()) {
    const out = [];
    for (const [key, entry] of this.entries) {
      const ms = Math.max(0, entry.until - now);
      if (ms > 0) out.push({ route: key, remainingMs: ms, code: entry.code, reason: entry.reason });
    }
    return out.sort((a, b) => a.remainingMs - b.remainingMs);
  }
}

/**
 * 从池里挑一条当前可用的路由。
 *
 * @param {object} input
 * @param {Array<{provider: string, model: string}>} input.pool 有序池
 * @param {import('./pool.js').Cooldowns} input.cooldowns 冷却表
 * @param {Array<{provider: string, model: string}>} [input.healthy] 只考虑这些（可选过滤）
 * @param {number} [input.now]
 * @returns {{route: {provider: string, model: string} | undefined, degraded: boolean}}
 */
export function pickRoute({ pool, cooldowns, healthy, now = Date.now() }) {
  const allowed = healthy === undefined ? pool : pool.filter((r) => healthy.some((h) => matchRoute(h, r)));
  const candidates = allowed.length > 0 ? allowed : pool;
  for (const route of candidates) {
    if (!cooldowns.isCooling(route, now)) return { route, degraded: false };
  }
  // 全在冷却：挑最早解冻的那条，别让这一轮直接死
  let best;
  let bestRemaining = Infinity;
  for (const route of candidates) {
    const remaining = cooldowns.remaining(route, now);
    if (remaining < bestRemaining || best === undefined) {
      bestRemaining = remaining;
      best = route;
    }
  }
  return { route: best, degraded: best !== undefined };
}
