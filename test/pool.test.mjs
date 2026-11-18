import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Cooldowns,
  classifyFailure,
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
