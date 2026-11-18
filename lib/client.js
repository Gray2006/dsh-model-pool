// dsh-model-pool —— 侧边栏「额度池」页面（客户端 bundle）
//
// 这个文件是给浏览器跑的，不是给 Node 跑：它由 DSH 的客户端模块系统加载，
// 注册成一个侧边栏 tab。不要在这里 import 任何 node: 内置模块。
//
// 它不自己保存状态：勾选通过 HTTP 交给 host 半侧（/model-pool/state），
// 落在 %DSH_HOME%/model-pool-selection.json，于是重启后还在，agent 那边
// 用的也是同一份集合。

window.__ModuleLoader__.load({
  id: 'dsh-model-pool',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { useState, useEffect, useCallback } = React;

    const name = 'dsh-model-pool';
    // 必须声明：cordis 里访问未声明的服务会直接抛
    // `cannot get property "betterSidebar" without inject`，apply 一抛就没 tab 了。
    const inject = ['betterSidebar'];

    const STATE_ROUTE = '/model-pool/state';
    const CSS_ID = 'dsh-model-pool-style';

    const CSS = `
      .dshmp-root { display: flex; flex-direction: column; gap: 14px; padding: 14px; box-sizing: border-box; font-size: 13px; }
      .dshmp-head { display: flex; flex-direction: column; gap: 5px; }
      .dshmp-title { font-size: 15px; font-weight: 650; margin: 0; }
      .dshmp-muted { color: color-mix(in srgb, currentColor 62%, transparent); line-height: 1.55; }
      .dshmp-error { color: color-mix(in srgb, #ff4d4f 78%, currentColor); line-height: 1.55; }
      .dshmp-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 11px; border: 1px solid color-mix(in srgb, currentColor 13%, transparent); border-radius: 11px; }
      .dshmp-row.off { opacity: .62; }
      .dshmp-check { margin-top: 2px; flex: 0 0 auto; width: 15px; height: 15px; accent-color: #4c9aff; cursor: pointer; }
      .dshmp-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1 1 auto; }
      .dshmp-route { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
      .dshmp-badge { font-size: 11px; padding: 2px 7px; border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); flex: 0 0 auto; white-space: nowrap; }
      .dshmp-badge.ok { background: rgba(52,168,83,.13); color: color-mix(in srgb, #34a853 72%, currentColor); }
      .dshmp-badge.cool { background: rgba(251,188,4,.14); color: color-mix(in srgb, #b8860b 78%, currentColor); }
      .dshmp-badge.off { background: color-mix(in srgb, currentColor 7%, transparent); }
      .dshmp-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .dshmp-btn { min-height: 32px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); background: transparent; color: inherit; padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 12px; }
      .dshmp-btn:hover:not(:disabled) { background: color-mix(in srgb, currentColor 7%, transparent); }
      .dshmp-btn:disabled { opacity: .45; cursor: not-allowed; }
      .dshmp-next { padding: 9px 11px; border-radius: 10px; background: color-mix(in srgb, currentColor 4%, transparent); }
    `;

    function injectCss() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(CSS_ID)) return;
      const style = document.createElement('style');
      style.id = CSS_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    async function readState() {
      const response = await fetch(STATE_ROUTE, { cache: 'no-store' });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`额度池返回了非 JSON（HTTP ${response.status}）`);
      }
      if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`);
      return data;
    }

    async function writeToggle(route, enabled) {
      const response = await fetch(STATE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ route, enabled }),
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`额度池返回了非 JSON（HTTP ${response.status}）`);
      }
      if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`);
      return data;
    }

    /** 剩余冷却时分化的短写法。 */
    function fmt(ms) {
      const total = Math.max(0, Math.round(ms / 1000));
      if (total < 60) return `${total}s`;
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
    }

    const el = React.createElement;

    function PoolPanel() {
      const [state, setState] = useState({ loading: true, data: null, error: null });
      const [busy, setBusy] = useState('');
      const [tick, setTick] = useState(0);

      const load = useCallback(() => {
        let active = true;
        setState((old) => ({ ...old, loading: true }));
        readState()
          // receivedAt 记在本地：服务端给的是「还剩多少毫秒」，倒计时要靠这个基准往下走
          .then((data) => { if (active) setState({ loading: false, data: { ...data, receivedAt: Date.now() }, error: null }); })
          .catch((error) => { if (active) setState({ loading: false, data: null, error: String(error?.message ?? error) }); });
        return () => { active = false; };
      }, []);

      useEffect(() => load(), [load]);

      // 冷却倒计时每秒重画一次，不用重新请求
      useEffect(() => {
        const timer = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(timer);
      }, []);

      const data = state.data;

      const toggle = useCallback(async (route, enabled) => {
        setBusy(route);
        try {
          const next = await writeToggle(route, enabled);
          setState({ loading: false, data: next, error: null });
        } catch (error) {
          setState((old) => ({ ...old, loading: false, error: String(error?.message ?? error) }));
        } finally {
          setBusy('');
        }
      }, []);

      if (state.error && !data) {
        return el('div', { className: 'dshmp-root' },
          el('div', { className: 'dshmp-head' },
            el('h3', { className: 'dshmp-title' }, '额度池'),
            el('div', { className: 'dshmp-error' }, state.error),
            el('div', { className: 'dshmp-muted' }, '插件可能没装到当前 profile，或者刚要重启才生效。'),
          ),
          el('button', { className: 'dshmp-btn', onClick: load }, '重试'),
        );
      }

      if (!data) {
        return el('div', { className: 'dshmp-root' }, el('div', { className: 'dshmp-muted' }, '读取中…'));
      }

      const rows = data.pool.map((item) => {
        // tick 只是一个“现在”的版本号：它变了就重绘一次，剩余时间按收到快照的时刻往下减
        void tick;
        const elapsed = item.cooling ? Math.max(0, Date.now() - (data.receivedAt ?? Date.now())) : 0;
        const remaining = item.cooling ? Math.max(0, item.remainingMs - elapsed) : 0;
        const cooling = item.cooling && remaining > 0;
        const badge = !item.inScope
          ? el('span', { className: 'dshmp-badge off' }, '不在范围')
          : cooling
            ? el('span', { className: 'dshmp-badge cool' }, `冷却 ${fmt(remaining)}`)
            : el('span', { className: 'dshmp-badge ok' }, '可用');
        return el('div', { className: `dshmp-row${item.inScope ? '' : ' off'}`, key: item.route },
          el('input', {
            type: 'checkbox',
            className: 'dshmp-check',
            checked: item.inScope,
            disabled: busy === item.route,
            onChange: (event) => toggle(item.route, event.target.checked),
            'aria-label': `把 ${item.route} 纳入自动切换范围`,
          }),
          el('div', { className: 'dshmp-main' },
            el('div', { className: 'dshmp-route' }, item.route),
          ),
          badge,
        );
      });

      const inScopeCount = data.pool.filter((p) => p.inScope).length;

      return el('div', { className: 'dshmp-root' },
        el('div', { className: 'dshmp-head' },
          el('h3', { className: 'dshmp-title' }, '额度池'),
          el('div', { className: 'dshmp-muted' },
            `${inScopeCount}/${data.pool.length} 条在切换范围。勾上的才会被自动切过去；取消勾选的通道保持原样，不参与兜底。`),
        ),
        data.next
          ? el('div', { className: 'dshmp-next' },
              el('div', { className: 'dshmp-muted' }, data.degraded ? '下次请求（全池冷却，退化试最早解冻的一条）' : '下次请求'),
              el('div', { className: 'dshmp-route' }, data.next))
          : el('div', { className: 'dshmp-next' },
              el('div', { className: 'dshmp-muted' }, '下次请求：没有可用通道')),
        ...rows,
        state.error ? el('div', { className: 'dshmp-error' }, state.error) : null,
        el('div', { className: 'dshmp-foot' },
          el('div', { className: 'dshmp-muted' }, `冷却 ${Math.round(data.cooldownMs / 60000)} 分钟起，连错翻倍`),
          el('button', { className: 'dshmp-btn', onClick: load, disabled: state.loading }, state.loading ? '刷新中…' : '刷新'),
        ),
      );
    }

    /** 把侧边栏 tab 挂上去。inject 声明保证了服务在这时已经就绪。 */
    function apply(ctx) {
      injectCss();
      // 自检：确认这个 bundle 真的在浏览器里执行了，宿主日志里能看到
      try {
        fetch(STATE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ping: 'client-loaded', id: name }),
        }).catch(() => {});
      } catch { /* 上报失败不影响功能 */ }

      const sidebar = typeof ctx.get === 'function' ? ctx.get('betterSidebar') : undefined;
      if (!sidebar || typeof sidebar.registerTab !== 'function') {
        console.warn('[dsh-model-pool] betterSidebar 不可用，侧边栏页面不挂载');
        return;
      }
      ctx.effect(() => sidebar.registerTab({
        id: 'model-pool',
        title: () => '额度池',
        description: () => '选择哪些模型通道参与自动切换',
        order: 60,
        single: true,
        component: () => el(PoolPanel),
      }), 'dsh-model-pool: sidebar tab');
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
