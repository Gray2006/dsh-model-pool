import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Cooldowns,
  classifyFailure,
  isConcurrencyFailure,
  pickRoute,
  routeKey,
  sameRoute,
  shouldFailover,
} from '../lib/pool.js';

const a = { provider: 'open-design', model: 'deepseek-v4.1-flash' };
const b = { provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash' };
const c = { provider: 'zhipu', model: 'glm-4.7-flash' };

test('routeKey 与 sameRoute', () => {
  assert.equal(routeKey(a), 'open-design/deepseek-v4.1-flash');
  assert.equal(routeKey(b), 'command-code/deepseek/deepseek-v4.1-flash');
  assert.ok(sameRoute(a, { ...a }));
  assert.ok(!sameRoute(a, b));
  assert.ok(!sameRoute(a, undefined));
});

test('额度类失败摘通道：稳定码', () => {
  for (const code of ['QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'NO_ADAPTER']) {
    assert.equal(classifyFailure(code, ''), 'bench', code);
    assert.equal(shouldFailover(code, ''), true, code);
  }
});

test('抖动类失败不摘通道', () => {
  for (const code of ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']) {
    assert.equal(classifyFailure(code, ''), 'soft', code);
    assert.equal(shouldFailover(code, ''), false, code);
  }
});

test('并发撞车要切换，但不能和普通限流混为一谈', () => {
  // 宿主把 429 和 concurrency 一律归成 RATE_LIMIT。普通限流罚的是整条通道，
  // 但并发槽位是按通道各算的 —— 另一条有自己的额度，换过去立刻能跑。
  const cases = [
    '429: concurrent request limit exceeded',
    'Maximum concurrent requests reached',
    'Too many concurrent connections',
    '已达最大并发数',
    '当前同时请求过多',
  ];
  for (const text of cases) {
    assert.equal(classifyFailure('RATE_LIMIT', text), 'bench', text);
    assert.equal(shouldFailover('RATE_LIMIT', text), true, text);
    assert.equal(isConcurrencyFailure('RATE_LIMIT', text), true, text);
  }

  // 普通限流不能因为这条规则而误伤
  for (const text of ['Too many requests per minute', 'rate limit exceeded']) {
    assert.equal(classifyFailure('RATE_LIMIT', text), 'soft', text);
    assert.equal(isConcurrencyFailure('RATE_LIMIT', text), false, text);
  }
});

test('并发撞车用固定短冷却，且不推高连续失败次数', () => {
  const cd = new Cooldowns({ now: () => 1_000_000 });
  const route = { provider: 'p', model: 'm' };

  // 普通失败：第一次 baseMs，第二次翻倍
  const first = cd.strike(route, { code: 'QUOTA', baseMs: 60_000, maxMs: 600_000 });
  assert.equal(first - 1_000_000, 60_000);
  const second = cd.strike(route, { code: 'QUOTA', baseMs: 60_000, maxMs: 600_000 });
  assert.equal(second - 1_000_000, 120_000);

  // 并发撞车：固定时长，不看 strikes
  const cd2 = new Cooldowns({ now: () => 1_000_000 });
  const c1 = cd2.strike(route, { code: 'RATE_LIMIT', fixedMs: 20_000, noStrike: true });
  assert.equal(c1 - 1_000_000, 20_000);
  // 连着撞也不翻倍
  const c2 = cd2.strike(route, { code: 'RATE_LIMIT', fixedMs: 20_000, noStrike: true });
  assert.equal(c2 - 1_000_000, 20_000);
  assert.equal(cd2.entries.get('p/m').strikes, 1);
});

test('套餐额度耗尽被包成 429 rate_limit_error 时也要摘', () => {
  // 真实案例：供应商把「套餐周额度用完」报成 rate_limit_error，
  // 只看 code 会当成抖动放行，于是整轮直接死在那里、不切换。
  const real = '429: {"message":"You\'ve reached your weekly usage limit for your plan. '
    + 'Your limit resets at 2026-11-19T04:28:23.290Z. Please wait for the window to reset '
    + 'or upgrade your plan to continue.","type":"rate_limit_error"}';
  assert.equal(classifyFailure('RATE_LIMIT', real), 'bench');
  assert.equal(shouldFailover('RATE_LIMIT', real), true);

  for (const text of [
    'usage limit reached',
    'You have exceeded your monthly usage limit',
    'You have hit your daily usage limit',
  ]) {
    assert.equal(classifyFailure('RATE_LIMIT', text), 'bench', text);
  }
});

test('真限流与上游抖动仍然放行（别误伤）', () => {
  for (const text of [
    'Too many requests per minute',
    'rate limit exceeded, please slow down',
    'upstream connect error or disconnect/reset before headers',
  ]) {
    assert.equal(classifyFailure('RATE_LIMIT', text), 'soft', text);
  }
});

test('上下文超限与图片超限不换通道（换谁都一样）', () => {
  assert.equal(shouldFailover('CONTEXT_WINDOW_EXCEEDED', ''), false);
  assert.equal(shouldFailover('IMAGE_OFFLOAD_REQUIRED', ''), false);
});

test('中文余额不足兜底识别（适配器没归成 QUOTA 时）', () => {
  assert.equal(classifyFailure('', '账户余额不足，请充值'), 'bench');
  assert.equal(classifyFailure('SERVER', '当前额度已用尽'), 'bench');
  assert.equal(classifyFailure(undefined, 'insufficient balance'), 'bench');
  assert.equal(classifyFailure(undefined, 'Invalid API key'), 'bench');
  assert.equal(classifyFailure(undefined, 'socket hang up'), 'soft');
  assert.equal(classifyFailure(undefined, ''), 'soft');
});

test('冷却指数退避并封顶', () => {
  let now = 1_000_000;
  const cooldowns = new Cooldowns({ now: () => now });
  const base = 1000;
  const max = 3000;

  assert.equal(cooldowns.isCooling(a), false);
  const first = cooldowns.strike(a, { code: 'QUOTA', baseMs: base, maxMs: max });
  assert.equal(first, now + 1000);
  assert.equal(cooldowns.isCooling(a), true);

  // 未解冻时再失败：翻倍
  const second = cooldowns.strike(a, { code: 'QUOTA', baseMs: base, maxMs: max });
  assert.equal(second, now + 2000);
  // 继续翻倍到封顶
  const third = cooldowns.strike(a, { code: 'QUOTA', baseMs: base, maxMs: max });
  assert.equal(third, now + 3000);
  const fourth = cooldowns.strike(a, { code: 'QUOTA', baseMs: base, maxMs: max });
  assert.equal(fourth, now + 3000, '不超过 maxCooldownMs');

  // 解冻后 strikes 归零
  now = fourth + 1;
  assert.equal(cooldowns.isCooling(a), false);
  const fifth = cooldowns.strike(a, { code: 'QUOTA', baseMs: base, maxMs: max });
  assert.equal(fifth, now + 1000, '冷却结束后重新从 base 开始');
});

test('pickRoute 按优先级跳过冷却中的通道', () => {
  let now = 1000;
  const cooldowns = new Cooldowns({ now: () => now });
  const pool = [a, b, c];
  assert.deepEqual(pickRoute({ pool, cooldowns, now }).route, a);

  cooldowns.strike(a, { code: 'QUOTA', baseMs: 60_000, maxMs: 60_000 });
  assert.deepEqual(pickRoute({ pool, cooldowns, now }).route, b);

  cooldowns.strike(b, { code: 'AUTH', baseMs: 60_000, maxMs: 60_000 });
  assert.deepEqual(pickRoute({ pool, cooldowns, now }).route, c);

  // 全池冷却：退化成最早解冻的那条，且标记 degraded
  cooldowns.strike(c, { code: 'QUOTA', baseMs: 60_000, maxMs: 60_000 });
  const degraded = pickRoute({ pool, cooldowns, now });
  assert.equal(degraded.degraded, true);
  assert.deepEqual(degraded.route, a, '最早解冻的是 a');
});

test('pickRoute 尊重 healthy 过滤；过滤后为空则退回整池', () => {
  const now = 1000;
  const cooldowns = new Cooldowns({ now: () => now });
  const pool = [a, b];
  const healthy = [{ provider: 'zhipu' }];
  // 池里没有 zhipu：过滤结果为空，退回整池，至少还能试
  assert.deepEqual(pickRoute({ pool, cooldowns, healthy, now }).route, a);
  // 有匹配时只从匹配里选
  assert.deepEqual(pickRoute({ pool, cooldowns, healthy: [{ provider: 'command-code' }], now }).route, b);
});

test('clear 与 clearAll 立刻恢复', () => {
  let now = 1000;
  const cooldowns = new Cooldowns({ now: () => now });
  cooldowns.strike(a, { code: 'QUOTA', baseMs: 60_000, maxMs: 60_000 });
  assert.equal(cooldowns.isCooling(a), true);
  cooldowns.clear(a);
  assert.equal(cooldowns.isCooling(a), false);

  cooldowns.strike(a, { code: 'QUOTA', baseMs: 60_000, maxMs: 60_000 });
  cooldowns.strike(b, { code: 'QUOTA', baseMs: 60_000, maxMs: 60_000 });
  cooldowns.clearAll();
  assert.equal(cooldowns.snapshot().length, 0);
});

test('snapshot 只列还在冷却的，按解冻先后排序', () => {
  const now = 1000;
  const cooldowns = new Cooldowns({ now: () => now });
  cooldowns.strike(a, { code: 'QUOTA', message: '余额不足', baseMs: 5000, maxMs: 60_000 });
  cooldowns.strike(b, { code: 'AUTH', message: 'invalid key', baseMs: 60_000, maxMs: 60_000 });
  const snapshot = cooldowns.snapshot(now);
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0].route, routeKey(a));
  assert.equal(snapshot[0].remainingMs, 5000);
  assert.equal(snapshot[0].reason, '余额不足');
  assert.equal(snapshot[1].route, routeKey(b));

  // 过期的条目不再出现
  assert.equal(cooldowns.snapshot(now + 6000).length, 1);
});
