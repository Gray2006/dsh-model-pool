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
      .dshmp-main { display: flex; flex-direction: row; align-items: center; gap: 6px; min-width: 0; flex: 1 1 auto; }
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
      .dshmp-group { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-top: 6px; padding: 0 2px; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: color-mix(in srgb, currentColor 55%, transparent); }
      .dshmp-group-n { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .dshmp-tools { display: flex; gap: 8px; }
      .dshmp-btnrow { display: flex; gap: 8px; }
      .dshmp-pin { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: color-mix(in srgb, currentColor 9%, transparent); color: color-mix(in srgb, currentColor 60%, transparent); }
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

    /** 往宿主发一条 POST，统一解析响应。 */
    async function postJson(payload) {
      const response = await fetch(STATE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
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

    async function writeToggle(route, enabled) {
      return postJson({ route, enabled });
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
          setState({ loading: false, data: { ...next, receivedAt: Date.now() }, error: null });
        } catch (error) {
          setState((old) => ({ ...old, loading: false, error: String(error?.message ?? error) }));
        } finally {
          setBusy('');
        }
      }, []);

      /** 全选 / 全不选。 */
      const toggleAll = useCallback(async (all) => {
        setBusy('__all__');
        try {
          const next = await postJson({ all });
          setState({ loading: false, data: { ...next, receivedAt: Date.now() }, error: null });
        } catch (error) {
          setState((old) => ({ ...old, loading: false, error: String(error?.message ?? error) }));
        } finally {
          setBusy('');
        }
      }, []);

      /** 重新扫描全部模型：新配了 provider 不用重启。 */
      const rescan = useCallback(async () => {
        setState((old) => ({ ...old, loading: true }));
        try {
          const next = await postJson({ rescan: true });
          setState({ loading: false, data: { ...next, receivedAt: Date.now() }, error: null });
        } catch (error) {
          setState((old) => ({ ...old, loading: false, error: String(error?.message ?? error) }));
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

      // 按 provider 分组：扫出来的模型可能几十个，平铺没法看
      const groups = new Map();
      for (const item of data.pool) {
        if (!groups.has(item.provider)) groups.set(item.provider, []);
        groups.get(item.provider).push(item);
      }

      const rows = [];
      for (const [provider, items] of groups) {
        const on = items.filter((i) => i.inScope).length;
        rows.push(el('div', { className: 'dshmp-group', key: `g:${provider}` },
          el('span', {}, provider),
          el('span', { className: 'dshmp-group-n' }, `${on}/${items.length}`),
        ));
        for (const item of items) {
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
          rows.push(el('div', { className: `dshmp-row${item.inScope ? '' : ' off'}`, key: item.route },
            el('input', {
              type: 'checkbox',
              className: 'dshmp-check',
              checked: item.inScope,
              disabled: busy === item.route,
              onChange: (event) => toggle(item.route, event.target.checked),
              'aria-label': `把 ${item.route} 纳入自动切换范围`,
            }),
            el('div', { className: 'dshmp-main' },
              el('div', { className: 'dshmp-route' }, item.model),
              item.pinned ? el('span', { className: 'dshmp-pin', title: '写在 config.pool 里，排在最前' }, '置顶') : null,
            ),
            badge,
          ));
        }
      }

      const inScopeCount = data.pool.filter((p) => p.inScope).length;
      const total = data.pool.length;

      return el('div', { className: 'dshmp-root' },
        el('div', { className: 'dshmp-head' },
          el('h3', { className: 'dshmp-title' }, '额度池'),
          el('div', { className: 'dshmp-muted' },
            total === 0
              ? '没扫到可用模型。检查 provider 是否配好 key，然后点「重新扫描」。'
              : `${inScopeCount}/${total} 条在切换范围。勾上的才会被自动切过去；取消勾选的通道保持原样，不参与兜底。`),
        ),
        data.next
          ? el('div', { className: 'dshmp-next' },
              el('div', { className: 'dshmp-muted' }, data.degraded ? '下次请求（全池冷却，退化试最早解冻的一条）' : '下次请求'),
              el('div', { className: 'dshmp-route' }, data.next))
          : el('div', { className: 'dshmp-next' },
              el('div', { className: 'dshmp-muted' }, '下次请求：没有可用通道')),
        el('div', { className: 'dshmp-tools' },
          el('button', {
            className: 'dshmp-btn',
            onClick: () => toggleAll(true),
            disabled: state.loading || total === 0,
          }, '全选'),
          el('button', {
            className: 'dshmp-btn',
            onClick: () => toggleAll(false),
            disabled: state.loading || total === 0,
          }, '全不选'),
        ),
        ...rows,
        state.error ? el('div', { className: 'dshmp-error' }, state.error) : null,
        el('div', { className: 'dshmp-foot' },
          el('div', { className: 'dshmp-muted' },
            `${data.scannedAt ? '已扫描' : '未扫描'}${data.scanFailed > 0 ? ` · ${data.scanFailed} 个 provider 列不出来` : ''} · 冷却 ${Math.round(data.cooldownMs / 60000)} 分钟起`),
          el('div', { className: 'dshmp-btnrow' },
            el('button', { className: 'dshmp-btn', onClick: rescan, disabled: state.loading }, state.loading ? '扫描中…' : '重新扫描'),
            el('button', { className: 'dshmp-btn', onClick: load, disabled: state.loading }, '刷新'),
          ),
        ),
        data.scanError ? el('div', { className: 'dshmp-error' }, `扫描出错：${data.scanError}`) : null,
      );
    }

    /** 把侧边栏 tab 挂上去。inject 声明保证了服务在这时已经就绪。 */
    function apply(ctx) {
      injectCss();

      // 诊断：每一步都回报，出问题能一次定位到断在哪
      const report = (stage, extra) => {
        try {
          fetch(STATE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ping: stage, id: name, ...extra }),
          }).catch(() => {});
        } catch { /* 上报失败不影响功能 */ }
      };

      report('client-loaded');

      let sidebar;
      try {
        sidebar = typeof ctx.get === 'function' ? ctx.get('betterSidebar') : undefined;
      } catch (error) {
        report('get-threw', { error: String(error && error.message || error) });
        return;
      }

      if (!sidebar) { report('no-service'); return; }
      if (typeof sidebar.registerTab !== 'function') { report('no-registerTab'); return; }

      try {
        ctx.effect(() => sidebar.registerTab({
          id: 'model-pool',
          title: () => '额度池',
          description: () => '选择哪些模型通道参与自动切换',
          order: 60,
          single: true,
          component: () => el(PoolPanel),
        }), 'dsh-model-pool: sidebar tab');
        report('tab-registered');

        // registerTab 只是登记类型，页签条上不会自己冒出来——要 openTab 才真正落到布局里。
        // 但 openTab 在拿不到 sessionId 时会静默返回（apply 阶段会话还没绑定），
        // 所以要等会话就绪再开。只在第一次装上时开，之后用户关掉就不再打扰。
        const OPENED_KEY = 'dsh-model-pool:auto-opened';
        let alreadyOpened = false;
        try { alreadyOpened = window.localStorage.getItem(OPENED_KEY) === '1'; } catch { /* 隐私模式 */ }

        if (!alreadyOpened && typeof sidebar.openTab === 'function') {
          let attempts = 0;
          const tryOpen = () => {
            attempts += 1;
            // openTab 没有返回值，而且在 targetSessionId 为 undefined 时会静默返回。
            // 所以先自己确认会话绑上了没有：没绑上就继续等，别当成已开过。
            let sessionId;
            try {
              sessionId = sidebar.getSnapshot?.()?.sessionId;
            } catch { /* 拿不到就当没绑上 */ }
            if (sessionId === undefined) {
              if (attempts >= 60) { report('open-gave-up'); return; }
              const timer = setTimeout(tryOpen, 1000);
              try { ctx.effect(() => () => clearTimeout(timer), 'dsh-model-pool: open timer'); } catch { /* 忽略 */ }
              return;
            }
            try {
              sidebar.openTab({ type: 'model-pool' });
              try { window.localStorage.setItem(OPENED_KEY, '1'); } catch { /* 忽略 */ }
              report('tab-opened', { attempts });
            } catch (error) {
              report('open-threw', { error: String(error && error.message || error) });
            }
          };
          setTimeout(tryOpen, 1500);
        }
      } catch (error) {
        report('register-threw', { error: String(error && error.message || error) });
      }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
