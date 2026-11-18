import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

/** 最小假 ctx：记录监听器，手动驱动 waterfall。 */
function makeCtx({ providers = [], tools = true, webServer = undefined } = {}) {
  const listeners = new Map();
  const registered = [];
  const effects = [];
  const routes = [];
  const services = {
    tools: tools
      ? {
          register(tool) {
            registered.push(tool);
            return () => {};
          },
        }
      : undefined,
    llm: { listProviders: () => providers.map((id) => ({ id, name: id })) },
    webServer: webServer,
  };
  const ctx = {
    on(name, listener, _options) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
      return () => {
        const list = listeners.get(name) ?? [];
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(setup, _label) {
      effects.push(setup);
    },
    // cordis 的 ctx.inject(deps, cb)：deps 全在就立刻跑 cb，并给它一个带该服务的子 ctx
    inject(deps, callback) {
      if (deps.some((dep) => services[dep] === undefined)) return undefined;
      const scoped = {
        get: (dep) => services[dep],
        effect(setup) { effects.push(setup); return setup?.(); },
      };
      for (const dep of deps) scoped[dep] = services[dep];
      return callback(scoped);
    },
    get(name) {
      return services[name];
    },
  };
  /** 跑一遍某事件的 waterfall，模拟宿主 next() 链。 */
  async function run(name, payload, base) {
    const list = [...(listeners.get(name) ?? [])].reverse();
    let index = 0;
    const step = async (current) => {
      if (index >= list.length) return base(current);
      const listener = list[index];
      index += 1;
      return listener(current, () => step(current));
    };
    return step(payload);
  }
  return { ctx, listeners, registered, effects, routes, run };
}

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pool-'));
  return path.join(dir, 'state.json');
}

/** 把 DSH_HOME 指到临时目录，避免测试写进真实的家目录。 */
function withTmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pool-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  return {
    dir,
    restore() {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    },
  };
}

const A = { provider: 'open-design', model: 'deepseek-v4.1-flash' };
const B = { provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash' };

test('池里全可用时，agent/request 原样放行（不抢手选默认）', async () => {
  const { ctx, run } = makeCtx();
  apply(ctx, { pool: [B], persist: false });
  const result = await run('agent/request', { turn: 1, step: 1 }, () => ({ ...A }));
  assert.deepEqual(result, A);
});

test('当前路由在冷却 → agent/request 换成池里可用的那条', async () => {
  const stateFile = tmpState();
  const { ctx, run } = makeCtx();
  apply(ctx, { pool: [A, B], statePath: stateFile, cooldownMs: 60_000, maxCooldownMs: 60_000 });

  // 制造一次额度失败，让 A 进冷却
  const action = await run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code: 'QUOTA', message: '余额不足' } }, () => undefined);
  assert.deepEqual(action, { kind: 'retry' });

  const routed = await run('agent/request', { turn: 1, step: 2 }, () => ({ ...A }));
  assert.deepEqual(routed, B, '换到 command-code');
});

test('换 provider 时丢弃继承的 reasoningEffort 与 maxTokens', async () => {
  const { ctx, run } = makeCtx();
  apply(ctx, { pool: [A, B], persist: false, cooldownMs: 60_000 });
  await run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code: 'QUOTA', message: '余额不足' } }, () => undefined);

  const routed = await run('agent/request', { turn: 1, step: 2 }, () => ({ ...A, reasoningEffort: 'high', maxTokens: 32768, temperature: 0.2 }));
  assert.equal(routed.provider, B.provider);
  assert.equal(routed.model, B.model);
  assert.equal(routed.reasoningEffort, undefined, '上一条通道的强度词汇不能带过去');
  assert.equal(routed.maxTokens, undefined, '上一条通道的输出上限可能超目标模型，不能带过去');
  assert.equal(routed.temperature, 0.2, '其余字段保留');
});

test('池条目自带 reasoningEffort / maxTokens 时才带上', async () => {
  const { ctx, run } = makeCtx();
  apply(ctx, { pool: [A, { ...B, reasoningEffort: 'low', maxTokens: 4096 }], persist: false, cooldownMs: 60_000 });
  await run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code: 'QUOTA', message: '' } }, () => undefined);

  const routed = await run('agent/request', { turn: 1, step: 2 }, () => ({ ...A, reasoningEffort: 'high', maxTokens: 32768 }));
  assert.equal(routed.provider, B.provider);
  assert.equal(routed.reasoningEffort, 'low');
  assert.equal(routed.maxTokens, 4096);
});

test('抖动类失败不换通道，只交给宿主重试', async () => {
  const { ctx, run } = makeCtx();
  apply(ctx, { pool: [A, B], persist: false });

  for (const code of ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
    const action = await run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code, message: '' } }, () => undefined);
    assert.equal(action, undefined, code);
  }
  // A 没被拉黑
  const routed = await run('agent/request', { turn: 1, step: 2 }, () => ({ ...A }));
  assert.deepEqual(routed, A);
});

test('上下文超限不换通道（换谁都一样）', async () => {
  const { ctx, run } = makeCtx();
  apply(ctx, { pool: [A, B], persist: false });
  const action = await run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' } }, () => undefined);
  assert.equal(action, undefined);
});

test('同一步换满上限后放弃，不无限重跑', async () => {
  const { ctx, run } = makeCtx();
  apply(ctx, { pool: [A, B], persist: false, cooldownMs: 60_000, maxFailoversPerStep: 1 });

  const first = await run('agent/request-error', { turn: 2, step: 3, provider: A.provider, failure: { code: 'QUOTA', message: '' } }, () => undefined);
  assert.deepEqual(first, { kind: 'retry' });

  // 同一步第二次失败：已达上限，交还宿主（抛错终结这轮）
  const second = await run('agent/request-error', { turn: 2, step: 3, provider: B.provider, failure: { code: 'QUOTA', message: '' } }, () => 'passthrough');
  assert.equal(second, 'passthrough');
});

test('全池冷却后退化为最早解冻的那条，不会直接死', async () => {
  const { ctx, run } = makeCtx();
  apply(ctx, { pool: [A, B], persist: false, cooldownMs: 60_000, maxCooldownMs: 60_000 });
  await run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code: 'QUOTA', message: '' } }, () => undefined);
  await run('agent/request-error', { turn: 2, step: 1, provider: B.provider, failure: { code: 'AUTH', message: '' } }, () => undefined);

  // 当前路由本身也在冷却：全池都冷却，仍然挑最早解冻的那条硬着头皮试
  const routed = await run('agent/request', { turn: 3, step: 1 }, () => ({ ...A }));
  assert.ok([A.provider, B.provider].includes(routed.provider), '仍从池里挑一条试');
});

test('当前路由没病就不动：不在池里的路由原样放行', async () => {
  const { ctx, run } = makeCtx();
  apply(ctx, { pool: [A, B], persist: false, cooldownMs: 60_000 });
  await run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code: 'QUOTA', message: '' } }, () => undefined);
  // 用户手选了池外的 zhipu：它没在冷却，不该被抢
  const routed = await run('agent/request', { turn: 2, step: 1 }, () => ({ provider: 'zhipu', model: 'glm-4.7-flash' }));
  assert.deepEqual(routed, { provider: 'zhipu', model: 'glm-4.7-flash' });
});

test('没有适配器的 provider 不进候选', async () => {
  const { ctx, run } = makeCtx({ providers: ['command-code'] });
  apply(ctx, { pool: [A, B], persist: false, cooldownMs: 60_000 });
  await run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code: 'QUOTA', message: '' } }, () => undefined);
  const routed = await run('agent/request', { turn: 1, step: 2 }, () => ({ ...A }));
  assert.equal(routed.provider, 'command-code');
});

test('冷却表落盘并在「重启」后恢复', async () => {
  const stateFile = tmpState();
  const first = makeCtx();
  apply(first.ctx, { pool: [A, B], statePath: stateFile, cooldownMs: 60_000, maxCooldownMs: 60_000 });
  await first.run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code: 'QUOTA', message: '余额不足' } }, () => undefined);

  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.entries.length, 1);
  assert.equal(raw.entries[0].route, `${A.provider}/${A.model}`);

  // 新实例读同一份状态
  const second = makeCtx();
  apply(second.ctx, { pool: [A, B], statePath: stateFile, cooldownMs: 60_000 });
  const routed = await second.run('agent/request', { turn: 1, step: 1 }, () => ({ ...A }));
  assert.deepEqual(routed, B, '重启后仍记得 A 在冷却');
});

test('三个工具注册成功，模型池状态可读、可重置', async () => {
  const stateFile = tmpState();
  const { ctx, registered, run } = makeCtx();
  apply(ctx, { pool: [A, B], statePath: stateFile, cooldownMs: 60_000 });

  assert.equal(registered.length, 3);
  const status = registered.find((t) => t.name === 'model_pool_status');
  const reset = registered.find((t) => t.name === 'model_pool_reset');
  const toggle = registered.find((t) => t.name === 'model_pool_toggle');
  assert.ok(status && reset && toggle);

  await run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code: 'QUOTA', message: '余额不足' } }, () => undefined);

  const before = await status.execute({});
  assert.match(before.text, /open-design\/deepseek-v4\.1-flash — 冷却中/);
  assert.match(before.text, /下次请求：command-code/);
  assert.match(before.text, /余额不足/);

  const cleared = await reset.execute({ route: `${A.provider}/${A.model}` });
  assert.match(cleared.text, /已解除/);
  const after = await status.execute({});
  assert.match(after.text, /下次请求：open-design/);

  const missing = await reset.execute({ route: 'nope/none' });
  assert.match(missing.text, /池里没有/);
});

test('pool 为空时什么都不做', async () => {
  const { ctx, run } = makeCtx();
  apply(ctx, { pool: [], persist: false });
  const routed = await run('agent/request', { turn: 1, step: 1 }, () => ({ provider: 'x', model: 'y' }));
  assert.deepEqual(routed, { provider: 'x', model: 'y' });
  const action = await run('agent/request-error', { turn: 1, step: 1, provider: 'x', failure: { code: 'QUOTA', message: '' } }, () => 'passthrough');
  assert.equal(action, 'passthrough');
});

test('enabled=false 时全部放行', async () => {  const { ctx, run } = makeCtx();
  apply(ctx, { enabled: false, pool: [A, B], persist: false, cooldownMs: 60_000 });
  const action = await run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code: 'QUOTA', message: '' } }, () => 'passthrough');
  assert.equal(action, 'passthrough');
  const routed = await run('agent/request', { turn: 1, step: 1 }, () => ({ ...A }));
  assert.deepEqual(routed, A);
});

test('移出切换范围的通道不会被选中，落盘后重启仍生效', async () => {
  const home = withTmpHome();
  try {
    const stateFile = path.join(home.dir, 'state.json');
    const first = makeCtx();
    apply(first.ctx, { pool: [A, B], statePath: stateFile, cooldownMs: 60_000, maxCooldownMs: 60_000 });

    const toggle = first.registered.find((t) => t.name === 'model_pool_toggle');
    const off = await toggle.execute({ route: `${B.provider}/${B.model}`, enabled: false });
    assert.match(off.text, /移出自动切换范围/);

    // A 进冷却，B 也被移出 → 没有别的可选，只能留在 A（不换）
    await first.run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code: 'QUOTA', message: '' } }, () => undefined);
    const routed = await first.run('agent/request', { turn: 1, step: 2 }, () => ({ ...A }));
    assert.deepEqual(routed, A, 'B 被移出后不该被选');

    // 重启（新实例读同一个 home）后 B 仍在范围外
    const second = makeCtx();
    apply(second.ctx, { pool: [A, B], statePath: stateFile, cooldownMs: 60_000, maxCooldownMs: 60_000 });
    const status = second.registered.find((t) => t.name === 'model_pool_status');
    const text = (await status.execute({})).text;
    assert.match(text, /command-code\/deepseek\/deepseek-v4\.1-flash — 不在切换范围/);
  } finally {
    home.restore();
  }
});

test('把通道加回范围后立刻参与选路', async () => {
  const home = withTmpHome();
  try {
    const { ctx, registered, run } = makeCtx();
    apply(ctx, { pool: [A, B], persist: false, cooldownMs: 60_000, maxCooldownMs: 60_000 });
    const toggle = registered.find((t) => t.name === 'model_pool_toggle');

    await toggle.execute({ route: `${B.provider}/${B.model}`, enabled: false });
    await toggle.execute({ route: `${B.provider}/${B.model}`, enabled: true });

    await run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code: 'QUOTA', message: '' } }, () => undefined);
    const routed = await run('agent/request', { turn: 1, step: 2 }, () => ({ ...A }));
    assert.deepEqual(routed, B, '加回范围后应被选中');
  } finally {
    home.restore();
  }
});

test('全部移出时退回整池，不会把模型全掐死', async () => {
  const home = withTmpHome();
  try {
    const { ctx, registered, run } = makeCtx();
    apply(ctx, { pool: [A, B], persist: false, cooldownMs: 60_000, maxCooldownMs: 60_000 });
    const toggle = registered.find((t) => t.name === 'model_pool_toggle');
    await toggle.execute({ route: `${A.provider}/${A.model}`, enabled: false });
    await toggle.execute({ route: `${B.provider}/${B.model}`, enabled: false });

    await run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code: 'QUOTA', message: '' } }, () => undefined);
    const routed = await run('agent/request', { turn: 1, step: 2 }, () => ({ ...A }));
    assert.deepEqual(routed, B, '一条都没勾也要退回整池');
  } finally {
    home.restore();
  }
});

test('HTTP 状态快照带上 inScope 与冷却信息', async () => {
  const home = withTmpHome();
  try {
    const routes = [];
    const webServer = { register(route) { routes.push(route); return () => {}; } };
    const { ctx } = makeCtx({ webServer });
    apply(ctx, { pool: [A, B], persist: false, cooldownMs: 60_000 });
    assert.equal(routes.length, 1, 'webServer 就绪后应挂上路由');
    assert.equal(routes[0].path, '/model-pool/state');

    const respond = () => {
      const captured = { status: 0, body: undefined };
      return {
        captured,
        writeHead(status) { captured.status = status; },
        end(text) { captured.body = text; },
      };
    };

    const res = respond();
    await routes[0].handler({ method: 'GET', headers: {} }, res);
    const body = JSON.parse(res.captured.body);
    assert.equal(res.captured.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.pool.map((p) => p.inScope), [true, true]);
    assert.equal(body.next, `${A.provider}/${A.model}`);

    // 跨源写请求被拒
    const denied = respond();
    await routes[0].handler(
      { method: 'POST', headers: { origin: 'https://evil.example', host: 'localhost:1' }, async *[Symbol.asyncIterator]() {} },
      denied,
    );
    assert.equal(denied.captured.status, 403);
  } finally {
    home.restore();
  }
});

test('webServer 还没就绪时不影响自动切换，就绪后补挂路由', async () => {
  const home = withTmpHome();
  try {
    const { ctx, run, registered } = makeCtx({ webServer: undefined });
    apply(ctx, { pool: [A, B], persist: false, cooldownMs: 60_000, maxCooldownMs: 60_000 });
    // 没有 webServer 也应该照常工作
    assert.equal(registered.length, 3);
    await run('agent/request-error', { turn: 1, step: 1, provider: A.provider, failure: { code: 'QUOTA', message: '' } }, () => undefined);
    const routed = await run('agent/request', { turn: 1, step: 2 }, () => ({ ...A }));
    assert.deepEqual(routed, B);
  } finally {
    home.restore();
  }
});

test('POST 能改勾选，并立即反映在快照里', async () => {
  const home = withTmpHome();
  try {
    const routes = [];
    const webServer = { register(route) { routes.push(route); return () => {}; } };
    const { ctx } = makeCtx({ webServer });
    apply(ctx, { pool: [A, B], persist: false, cooldownMs: 60_000 });

    const respond = () => {
      const captured = { status: 0, body: undefined };
      return { captured, writeHead(s) { captured.status = s; }, end(t) { captured.body = t; } };
    };
    const bodyOf = (obj) => ({
      method: 'POST',
      headers: { origin: 'http://localhost:1', host: 'localhost:1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(obj)); },
    });

    const res = respond();
    await routes[0].handler(bodyOf({ route: `${B.provider}/${B.model}`, enabled: false }), res);
    assert.equal(res.captured.status, 200);
    const body = JSON.parse(res.captured.body);
    assert.deepEqual(body.pool.map((p) => p.inScope), [true, false]);

    const unknown = respond();
    await routes[0].handler(bodyOf({ route: 'nope/none', enabled: false }), unknown);
    assert.equal(unknown.captured.status, 404);
  } finally {
    home.restore();
  }
});

