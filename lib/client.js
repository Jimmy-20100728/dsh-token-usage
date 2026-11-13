/**
 * dsh-token-usage —— Client 侧（浏览器）
 *
 * 形态：在会话视图区注册一个 `conversation.view` 标签页「Token 用量」。
 * 数据：同源 fetch `/api/token-usage/*`（Host 侧路由，数据只在本机流转，不上传外网）。
 * 渲染：只依赖 react，图表全部手写 SVG（无 ECharts / 无 externals），避免重型依赖。
 *
 * 注意：本文件是**手写编译后的 JS**（无 TS、无 JSX），直接由 DSH 的 ModuleLoader 加载。
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-usage',
  factory: (require) => {
    'use strict';

    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    // ────────────────────────────── 格式化工具 ──────────────────────────────
    const nf = new Intl.NumberFormat('zh-CN');
    const fmtInt = (v) => nf.format(Math.round(Number(v) || 0));
    const fmtTokens = (v) => {
      const n = Number(v) || 0;
      if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
      if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
      return fmtInt(n);
    };
    const fmtMoney = (v, currency) => {
      const n = Number(v) || 0;
      const digits = Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 3 : 4;
      return `${currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : ''}${n.toFixed(digits)}`;
    };
    const fmtPct = (v) => `${((Number(v) || 0) * 100).toFixed(1)}%`;

    // ────────────────────────────── 数据访问 ──────────────────────────────
    const API = '/api/token-usage';

    async function apiGet(path) {
      const res = await fetch(`${API}${path}`, { credentials: 'include' });
      const text = await res.text();
      if (!res.ok) throw new Error(parseError(text) || `HTTP ${res.status}`);
      return text ? JSON.parse(text) : null;
    }

    async function apiPost(path, body) {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(parseError(text) || `HTTP ${res.status}`);
      return text ? JSON.parse(text) : null;
    }

    function parseError(text) {
      try {
        const doc = JSON.parse(text);
        return doc && (doc.error || doc.message) ? String(doc.error || doc.message) : '';
      } catch {
        return (text || '').slice(0, 300);
      }
    }

    async function uploadFile(file, datasetId) {
      const headers = { 'content-type': 'application/octet-stream' };
      headers['x-file-name'] = encodeURIComponent(file.name);
      if (datasetId) headers['x-dataset-id'] = datasetId;
      const buf = await file.arrayBuffer();
      const res = await fetch(`${API}/import`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: buf,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(parseError(text) || `HTTP ${res.status}`);
      return text ? JSON.parse(text) : null;
    }

    // ────────────────────────────── 视觉常量 ──────────────────────────────
    const ACCENT = '#4f7cff';
    const COLORS = { hit: '#34c38f', miss: '#4f7cff', output: '#f5a524' };

    const CSS = `
.tu-root{height:100%;overflow:auto;padding:12px 16px 150px;font-size:12.5px;line-height:1.5;color:inherit;box-sizing:border-box;
  scrollbar-width:thin}
.tu-root *{box-sizing:border-box}
/* 侧边栏窄容器：单列堆叠，去掉给底部输入框留的白边 */
.tu-narrow{padding:12px 12px 24px}
.tu-narrow .tu-kpis{grid-template-columns:repeat(2,minmax(0,1fr))!important}
.tu-narrow .tu-row3,.tu-narrow .tu-row2{grid-template-columns:1fr!important}
.tu-narrow .tu-title{font-size:15px}
.tu-narrow .tu-actions{margin-left:0}
.tu-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.tu-title{font-size:16px;font-weight:650;letter-spacing:-.01em;margin:0;display:flex;align-items:center;gap:8px}
.tu-title-dot{width:7px;height:7px;border-radius:50%;background:${ACCENT};box-shadow:0 0 0 3px rgba(79,124,255,.18)}
.tu-sub{opacity:.55;font-size:11.5px;margin-top:2px;font-variant-numeric:tabular-nums}
.tu-spacer{flex:1 1 auto}
.tu-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.tu-btn{appearance:none;border:1px solid rgba(127,127,127,.26);background:rgba(127,127,127,.07);color:inherit;
  padding:5px 11px;border-radius:9px;font-size:12px;cursor:pointer;
  transition:background .16s,border-color .16s,transform .16s,box-shadow .16s}
.tu-btn:hover{background:rgba(127,127,127,.15);border-color:rgba(127,127,127,.4);transform:translateY(-1px)}
.tu-btn:active{transform:translateY(0)}
.tu-btn.primary{background:linear-gradient(180deg,${ACCENT},#3f68e0);border-color:rgba(79,124,255,.9);color:#fff;
  box-shadow:0 6px 16px -8px rgba(79,124,255,.8)}
.tu-btn.primary:hover{filter:brightness(1.06);box-shadow:0 8px 20px -8px rgba(79,124,255,.9)}
.tu-btn[disabled]{opacity:.45;cursor:not-allowed;transform:none}
.tu-btn.danger{color:#e5484d;border-color:rgba(229,72,77,.34)}
.tu-btn.danger:hover{background:rgba(229,72,77,.12)}
.tu-select{appearance:none;border:1px solid rgba(127,127,127,.26);background:rgba(127,127,127,.07);color:inherit;
  padding:5px 10px;border-radius:9px;font-size:12px;max-width:260px}
/* ── 卡片：玻璃底 + 悬停轻微放大聚焦 ── */
.tu-card{position:relative;border:1px solid rgba(127,127,127,.16);border-radius:14px;padding:11px 13px;
  background:linear-gradient(180deg,rgba(127,127,127,.10),rgba(127,127,127,.045));
  transition:transform .24s cubic-bezier(.2,.8,.2,1),box-shadow .24s,border-color .24s,background .24s;
  will-change:transform}
.tu-card::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;
  transition:opacity .24s;background:radial-gradient(120% 90% at 50% -10%,rgba(79,124,255,.16),transparent 62%)}
.tu-card:hover{transform:translateY(-2px) scale(1.008);z-index:3;
  border-color:rgba(79,124,255,.4);
  background:linear-gradient(180deg,rgba(127,127,127,.135),rgba(127,127,127,.06));
  box-shadow:0 16px 36px -20px rgba(12,18,40,.9),0 0 0 1px rgba(79,124,255,.12)}
.tu-card:hover::after{opacity:1}
.tu-card-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.tu-card-title{font-weight:600;font-size:12.5px;letter-spacing:.01em;display:flex;align-items:center;gap:6px}
.tu-card-title::before{content:'';width:3px;height:11px;border-radius:2px;background:${ACCENT};opacity:.85}
.tu-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-bottom:10px}
@media (max-width:1180px){.tu-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
.tu-kpi{position:relative;border:1px solid rgba(127,127,127,.16);border-radius:12px;padding:8px 11px;
  background:linear-gradient(180deg,rgba(127,127,127,.09),rgba(127,127,127,.04));
  transition:transform .2s cubic-bezier(.2,.8,.2,1),border-color .2s,box-shadow .2s}
.tu-kpi:hover{transform:translateY(-2px);border-color:rgba(79,124,255,.36);
  box-shadow:0 12px 24px -18px rgba(12,18,40,.9)}
.tu-kpi-label{font-size:10.5px;opacity:.56;letter-spacing:.04em;text-transform:uppercase;
  display:flex;align-items:center;gap:5px}
.tu-kpi-value{font-size:17px;font-weight:650;margin-top:2px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.tu-kpi-hint{font-size:10.5px;opacity:.5;margin-top:1px;font-variant-numeric:tabular-nums}
.tu-bar-toolbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:8px}
.tu-seg{display:inline-flex;background:rgba(127,127,127,.09);border:1px solid rgba(127,127,127,.14);
  border-radius:9px;padding:2px;gap:1px}
.tu-seg button{appearance:none;border:0;background:transparent;color:inherit;opacity:.62;font-size:11.5px;
  padding:4px 10px;border-radius:7px;cursor:pointer;transition:background .16s,opacity .16s,color .16s}
.tu-seg button:hover{opacity:.9;background:rgba(127,127,127,.12)}
.tu-seg button.on{background:rgba(127,127,127,.24);opacity:1;font-weight:600;box-shadow:0 1px 0 rgba(255,255,255,.06) inset}
.tu-row3{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(0,.92fr) minmax(0,1fr);gap:10px}
@media (max-width:1180px){.tu-row3{grid-template-columns:1fr 1fr}}
.tu-row2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin-top:10px}
@media (max-width:900px){.tu-row2{grid-template-columns:1fr}}
.tu-svg{width:100%;height:auto;display:block;overflow:visible}
.tu-axis{font-size:9px;fill:currentColor;opacity:.42;font-variant-numeric:tabular-nums;letter-spacing:.01em}
.tu-axis-y{font-size:9px;fill:currentColor;opacity:.34;font-variant-numeric:tabular-nums}
.tu-chart-wrap{position:relative}
.tu-tip{position:absolute;pointer-events:none;transform:translate(-50%,-100%);z-index:6;
  background:rgba(18,22,38,.94);color:#fff;border:1px solid rgba(255,255,255,.1);border-radius:9px;
  padding:7px 10px;font-size:11px;line-height:1.55;white-space:nowrap;
  box-shadow:0 14px 34px -14px rgba(0,0,0,.8);backdrop-filter:blur(8px)}
.tu-tip b{font-weight:650}
.tu-tip .tu-tip-row{display:flex;justify-content:space-between;gap:12px;opacity:.88}
.tu-tip .tu-tip-h{font-weight:650;margin-bottom:2px;font-variant-numeric:tabular-nums}
.tu-empty{border:1.5px dashed rgba(127,127,127,.34);border-radius:16px;padding:44px 26px;text-align:center;
  transition:border-color .18s,background .18s,transform .18s}
.tu-empty.drag{border-color:${ACCENT};background:rgba(79,124,255,.08);transform:scale(1.005)}
.tu-empty h3{margin:10px 0 6px;font-size:15px}
.tu-empty p{margin:4px 0;opacity:.62;font-size:12.5px}
.tu-empty ul{margin:14px auto 0;padding:0;list-style:none;display:inline-block;text-align:left;font-size:12px;opacity:.66}
.tu-empty li{padding:2px 0}
.tu-banner{border-radius:10px;padding:8px 12px;font-size:12px;margin-bottom:10px}
.tu-banner.err{background:rgba(229,72,77,.12);border:1px solid rgba(229,72,77,.3);color:#e5484d}
.tu-banner.info{background:rgba(79,124,255,.1);border:1px solid rgba(79,124,255,.26)}
.tu-rank{display:flex;flex-direction:column;gap:7px}
.tu-rank-row{display:grid;grid-template-columns:minmax(64px,1.1fr) 1.9fr auto;gap:8px;align-items:center;font-size:11.5px;
  padding:1px 2px;border-radius:6px;transition:background .16s}
.tu-rank-row:hover{background:rgba(127,127,127,.1)}
.tu-rank-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.86}
.tu-track{height:6px;border-radius:99px;background:rgba(127,127,127,.14);overflow:hidden}
.tu-fill{height:100%;border-radius:99px;background:linear-gradient(90deg,rgba(79,124,255,.75),${ACCENT});
  transition:width .4s cubic-bezier(.2,.8,.2,1),filter .16s}
.tu-rank-row:hover .tu-fill{filter:brightness(1.22)}
.tu-rank-val{font-variant-numeric:tabular-nums;opacity:.76;white-space:nowrap;font-size:11px}
.tu-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;opacity:.72}
.tu-dot{width:7px;height:7px;border-radius:2px;display:inline-block;margin-right:4px;vertical-align:middle}
.tu-anomaly{display:flex;gap:8px;align-items:baseline;padding:5px 2px;border-bottom:1px dashed rgba(127,127,127,.16);font-size:12px}
.tu-anomaly:last-child{border-bottom:0}
.tu-tag{font-size:10px;padding:1px 6px;border-radius:99px;background:rgba(245,165,36,.16);
  border:1px solid rgba(245,165,36,.38);white-space:nowrap}
.tu-kv{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px}
.tu-kv-item{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11.5px;
  padding:4px 0;border-bottom:1px dashed rgba(127,127,127,.13)}
.tu-kv-item:last-child{border-bottom:0}
.tu-kv-k{opacity:.58;white-space:nowrap}
.tu-kv-v{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
.tu-groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:7px}
.tu-group-row{display:flex;align-items:center;gap:8px;font-size:11.5px}
.tu-group-row span{flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.78}
.tu-group-row input{flex:0 0 120px;background:rgba(127,127,127,.1);border:1px solid rgba(127,127,127,.22);
  border-radius:7px;padding:3px 8px;color:inherit;font-size:11.5px}
.tu-note{font-size:11px;opacity:.48;margin-top:8px}
.tu-loading{padding:32px;text-align:center;opacity:.55;font-size:12px}
.tu-enter{animation:tuIn .34s cubic-bezier(.2,.8,.2,1) backwards}
@keyframes tuIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){
  .tu-card,.tu-kpi,.tu-fill,.tu-btn{transition:none}
  .tu-card:hover,.tu-kpi:hover,.tu-btn:hover{transform:none}
  .tu-enter{animation:none}
}
`;

    // ────────────────────────────── 图表：趋势 ──────────────────────────────

    /**
     * 趋势图。kind: 'bar' 堆叠柱 | 'line' 折线。
     * 纯 SVG，鼠标移动时显示十字准线 + 悬浮提示（自己算 index，不依赖第三方）。
     */
    function TrendChart({ series, metric, currency, kind }) {
      const [hover, setHover] = useState(-1);
      const W = 860;
      const H = metric === 'cost' ? 168 : 186;
      const padL = 8;
      const padR = 8;
      const padT = 12;
      const padB = 24;
      const innerW = W - padL - padR;
      const innerH = H - padT - padB;
      const n = Math.max(1, series.length);
      const step = innerW / n;
      const labelEvery = Math.max(1, Math.ceil(n / 10));

      const valueOf = (s) => (metric === 'cost' ? s.cost : s.tokens);
      const maxVal = Math.max(1, ...series.map(valueOf));
      const yOf = (v) => padT + innerH - (Number(v) || 0) / maxVal * innerH;
      const xOf = (i) => padL + step * i + step / 2;

      const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) =>
        h('line', {
          key: `g${f}`,
          x1: padL,
          x2: W - padR,
          y1: padT + innerH * f,
          y2: padT + innerH * f,
          stroke: 'currentColor',
          strokeOpacity: f === 1 ? 0.18 : 0.08,
          strokeWidth: 1,
        }),
      );
      const gridLabels = [0, 0.5, 1].map((f) =>
        h(
          'text',
          { key: `gl${f}`, x: padL, y: padT + innerH * f - 3, className: 'tu-axis-y' },
          metric === 'cost' ? fmtMoney(maxVal * (1 - f), currency) : fmtTokens(maxVal * (1 - f)),
        ),
      );

      // ── 柱状 ──
      const barW = Math.max(2, Math.min(26, step * 0.58));
      const bars =
        kind === 'bar'
          ? series.map((s, i) => {
              const x = padL + step * i + (step - barW) / 2;
              const on = hover === i;
              if (metric === 'cost') {
                const bh = (s.cost / maxVal) * innerH;
                return h('rect', {
                  key: s.bucket,
                  x,
                  y: padT + innerH - bh,
                  width: barW,
                  height: Math.max(bh, s.cost > 0 ? 1.5 : 0),
                  rx: Math.min(3, barW / 3),
                  fill: on ? ACCENT : 'rgba(79,124,255,.82)',
                  style: { transition: 'fill .15s' },
                });
              }
              let y = padT + innerH;
              return h(
                'g',
                { key: s.bucket },
                [
                  ['hit', s.hit, COLORS.hit],
                  ['miss', s.miss, COLORS.miss],
                  ['output', s.output, COLORS.output],
                ].map(([key, value, color]) => {
                  const bh = (value / maxVal) * innerH;
                  y -= bh;
                  return h('rect', {
                    key,
                    x,
                    y,
                    width: barW,
                    height: Math.max(bh, value > 0 ? 0.8 : 0),
                    fill: color,
                    fillOpacity: hover === -1 ? 0.92 : on ? 1 : 0.42,
                    style: { transition: 'fill-opacity .16s' },
                  });
                }),
              );
            })
          : null;

      // ── 折线 / 面积（按 hit → +miss → +output 堆叠） ──
      const stacks = series.map((s) => ({
        a: Number(s.hit) || 0,
        b: (Number(s.hit) || 0) + (Number(s.miss) || 0),
        c: (Number(s.hit) || 0) + (Number(s.miss) || 0) + (Number(s.output) || 0),
      }));
      const xs = series.map((_, i) => xOf(i));
      const lineOf = (vals) =>
        vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xs[i].toFixed(2)} ${yOf(v).toFixed(2)}`).join(' ');

      let curves = null;
      if (kind !== 'bar' && metric !== 'cost' && series.length > 0) {
        const lows = stacks.map((s) => s.a);
        const mids = stacks.map((s) => s.b);
        const tops = stacks.map((s) => s.c);
        curves = h(
          'g',
          null,
          h('path', { d: lineOf(lows), fill: 'none', stroke: COLORS.hit, strokeWidth: 1.15, strokeLinejoin: 'round', strokeLinecap: 'round' }),
          h('path', { d: lineOf(mids), fill: 'none', stroke: COLORS.miss, strokeWidth: 1.15, strokeLinejoin: 'round', strokeLinecap: 'round' }),
          h('path', { d: lineOf(tops), fill: 'none', stroke: COLORS.output, strokeWidth: 1.15, strokeLinejoin: 'round', strokeLinecap: 'round' }),
          hover >= 0
            ? h(
                'g',
                null,
                [
                  ['hit', lows[hover], COLORS.hit],
                  ['miss', mids[hover], COLORS.miss],
                  ['output', tops[hover], COLORS.output],
                ].map(([k, v, c]) =>
                  h('circle', { key: k, cx: xs[hover], cy: yOf(v), r: 2.8, fill: c, stroke: 'rgba(0,0,0,.2)', strokeWidth: 0.8 }),
                ),
              )
            : null,
        );
      } else if (kind !== 'bar' && series.length > 0) {
        // 费用折线
        curves = h(
          'g',
          null,
          h('path', {
            d: series.map((s, i) => `${i === 0 ? 'M' : 'L'} ${xs[i].toFixed(2)} ${yOf(s.cost).toFixed(2)}`).join(' '),
            fill: 'none',
            stroke: ACCENT,
            strokeWidth: 1.4,
            strokeLinejoin: 'round',
            strokeLinecap: 'round',
          }),
          hover >= 0
            ? h('circle', { cx: xs[hover], cy: yOf(series[hover].cost), r: 2.8, fill: ACCENT })
            : null,
        );
      }

      // ── 十字准线 ──
      const crosshair =
        hover >= 0
          ? h('line', {
              x1: xOf(hover),
              x2: xOf(hover),
              y1: padT,
              y2: padT + innerH,
              stroke: 'currentColor',
              strokeOpacity: 0.28,
              strokeDasharray: '3 3',
            })
          : null;

      const labels = series.map((s, i) => {
        if (i % labelEvery !== 0) return null;
        return h(
          'text',
          {
            key: `l${s.bucket}`,
            x: xOf(i),
            y: H - 6,
            textAnchor: 'middle',
            className: 'tu-axis',
            style: hover === i ? { opacity: 0.9 } : undefined,
          },
          s.bucket.length > 7 ? s.bucket.slice(5) : s.bucket,
        );
      });

      const onMove = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width) return;
        const rel = (event.clientX - rect.left) / rect.width;
        const idx = Math.max(0, Math.min(series.length - 1, Math.floor(rel * series.length)));
        setHover(idx);
      };

      const hovered = hover >= 0 ? series[hover] : null;
      const tipLeftPct = hover >= 0 ? (xOf(hover) / W) * 100 : 0;
      const tipTop = hovered ? Math.max(6, yOf(valueOf(hovered)) - 8) : 0;

      return h(
        'div',
        { className: 'tu-chart-wrap' },
        h(
          'svg',
          {
            viewBox: `0 0 ${W} ${H}`,
            className: 'tu-svg',
            preserveAspectRatio: 'none',
            role: 'img',
            onMouseMove: onMove,
            onMouseLeave: () => setHover(-1),
          },
          gridLines,
          gridLabels,
          crosshair,
          bars,
          curves,
          labels,
        ),
        hovered
          ? h(
              'div',
              {
                className: 'tu-tip',
                style: {
                  left: `${Math.min(92, Math.max(8, tipLeftPct))}%`,
                  top: `${(tipTop / H) * 100}%`,
                },
              },
              h('div', { className: 'tu-tip-h' }, hovered.bucket),
              metric === 'cost'
                ? h('div', { className: 'tu-tip-row' }, h('span', null, '费用'), h('b', null, fmtMoney(hovered.cost, currency)))
                : [
                    h('div', { key: 'hit', className: 'tu-tip-row' }, h('span', null, '输入·命中'), h('b', null, fmtTokens(hovered.hit))),
                    h('div', { key: 'miss', className: 'tu-tip-row' }, h('span', null, '输入·未命中'), h('b', null, fmtTokens(hovered.miss))),
                    h('div', { key: 'out', className: 'tu-tip-row' }, h('span', null, '输出'), h('b', null, fmtTokens(hovered.output))),
                    h('div', { key: 'sum', className: 'tu-tip-row' }, h('span', null, '合计'), h('b', null, fmtTokens(hovered.tokens))),
                  ],
              h(
                'div',
                { className: 'tu-tip-row', style: { marginTop: 2 } },
                h('span', null, '费用'),
                h('b', null, fmtMoney(hovered.cost, currency)),
              ),
            )
          : null,
      );
    }

    // ────────────────────────────── 图表：构成 ──────────────────────────────

    /** 构成图。variant: 'donut' 环形 | 'pie' 饼图 | 'bar' 条形。 */
    function Composition({ items, totals, variant, size = 118 }) {
      const total = items.reduce((a, b) => a + b.tokens, 0) || 1;

      if (variant === 'bar') {
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
          h(
            'div',
            { style: { display: 'flex', height: 12, borderRadius: 99, overflow: 'hidden', background: 'rgba(127,127,127,.14)' } },
            items.map((item) =>
              h('div', {
                key: item.key,
                title: `${item.label} ${fmtTokens(item.tokens)}`,
                style: {
                  width: `${(item.tokens / total) * 100}%`,
                  background: COLORS[item.key] || ACCENT,
                  transition: 'width .4s cubic-bezier(.2,.8,.2,1)',
                },
              }),
            ),
          ),
          items.map((item) =>
            h(
              'div',
              { key: item.key, className: 'tu-rank-row', style: { gridTemplateColumns: 'auto 1fr auto' } },
              h('span', { className: 'tu-dot', style: { background: COLORS[item.key] || ACCENT } }),
              h('span', { className: 'tu-rank-name' }, item.label),
              h('span', { className: 'tu-rank-val' }, `${fmtTokens(item.tokens)} · ${fmtPct(item.tokens / total)}`),
            ),
          ),
        );
      }

      const r = size / 2 - 11;
      const c = 2 * Math.PI * r;
      const ring = variant !== 'pie';
      let acc = 0;
      const arcs = items.map((item, i) => {
        const frac = item.tokens / total;
        const dash = `${Math.max(0.5, frac * c)} ${c}`;
        const offset = -acc * c;
        acc += frac;
        return h('circle', {
          key: i,
          cx: size / 2,
          cy: size / 2,
          r: ring ? r : r * 0.72,
          fill: 'none',
          stroke: COLORS[item.key] || ACCENT,
          strokeWidth: ring ? 12 : r * 0.72,
          strokeDasharray: dash,
          strokeDashoffset: offset,
          transform: `rotate(-90 ${size / 2} ${size / 2})`,
          style: { transition: 'stroke-opacity .16s' },
        });
      });

      return h(
        'div',
        { style: { display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' } },
        h(
          'div',
          { style: { position: 'relative', width: size, height: size, flex: '0 0 auto' } },
          h(
            'svg',
            { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img' },
            ring
              ? h('circle', {
                  cx: size / 2,
                  cy: size / 2,
                  r,
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeOpacity: 0.1,
                  strokeWidth: 12,
                })
              : null,
            arcs,
          ),
          ring
            ? h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'none',
                  },
                },
                h('div', { style: { fontSize: 13, fontWeight: 650, fontVariantNumeric: 'tabular-nums' } }, fmtTokens(total)),
                h('div', { style: { fontSize: 9.5, opacity: 0.5, letterSpacing: '.04em' } }, 'TOKENS'),
              )
            : null,
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 118, flex: '1 1 auto' } },
          items.map((item) =>
            h(
              'div',
              { key: item.key, style: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5 } },
              h('span', { className: 'tu-dot', style: { background: COLORS[item.key] || ACCENT } }),
              h('span', { style: { flex: 1, opacity: 0.78 } }, item.label),
              h('span', { style: { fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, fmtTokens(item.tokens)),
              h('span', { style: { opacity: 0.5, minWidth: 42, textAlign: 'right', fontSize: 11 } }, fmtPct(item.tokens / total)),
            ),
          ),
          totals
            ? h(
                'div',
                { style: { fontSize: 10.5, opacity: 0.45, marginTop: 2 } },
                `缓存命中占输入 ${fmtPct(totals.input ? totals.hit / totals.input : 0)}`,
              )
            : null,
        ),
      );
    }

    /** 排行列表（可切换柱条 / 迷你折线）。 */
    function RankList({ rows, currency, valueKey }) {
      const max = Math.max(1, ...rows.map((r) => Number(r[valueKey]) || 0));
      return h(
        'div',
        { className: 'tu-rank' },
        rows.map((row, i) =>
          h(
            'div',
            { className: 'tu-rank-row', key: `${row.name}-${i}` },
            h('div', { className: 'tu-rank-name', title: row.name }, row.name),
            h(
              'div',
              { className: 'tu-track' },
              h('div', { className: 'tu-fill', style: { width: `${((Number(row[valueKey]) || 0) / max) * 100}%` } }),
            ),
            h(
              'div',
              { className: 'tu-rank-val' },
              valueKey === 'cost' ? fmtMoney(row.cost, currency) : `${fmtTokens(row.tokens)} · ${fmtPct(row.share)}`,
            ),
          ),
        ),
      );
    }

    // ────────────────────────────── 主视图 ──────────────────────────────

    function TokenUsageView(props) {
      // 侧边栏挂载时容器很窄，走紧凑单列布局
      const narrow = !!(props && (props.host === 'sidebar' || props.narrow));
      const [state, setState] = useState({ loading: true, error: '', datasets: [], groups: { keys: {}, models: {} } });
      const [activeId, setActiveId] = useState('');
      const [data, setData] = useState(null);
      const [analysisLoading, setAnalysisLoading] = useState(false);
      const [bucket, setBucket] = useState('day');
      const [metric, setMetric] = useState('tokens');
      const [dimension, setDimension] = useState('model');
      const [chartKind, setChartKind] = useState('bar');
      const [compVariant, setCompVariant] = useState('donut');
      const [showGroups, setShowGroups] = useState(false);
      const [dragging, setDragging] = useState(false);
      const [importing, setImporting] = useState('');
      const [notice, setNotice] = useState('');
      const [groupDraft, setGroupDraft] = useState({});
      const fileRef = useRef(null);
      const dragDepth = useRef(0);

      const loadState = useCallback(async (preferId) => {
        try {
          const next = await apiGet('/state');
          const list = next.datasets || [];
          setState({ loading: false, error: '', datasets: list, groups: next.groups || { keys: {}, models: {} }, dataDir: next.dataDir });
          setActiveId((current) => {
            const wanted = preferId || current;
            if (wanted && list.some((d) => d.id === wanted)) return wanted;
            return list.length ? list[0].id : '';
          });
        } catch (err) {
          setState((s) => ({ ...s, loading: false, error: err.message }));
        }
      }, []);

      const loadAnalysis = useCallback(async (datasetId, opts) => {
        if (!datasetId) {
          setData(null);
          return;
        }
        setAnalysisLoading(true);
        try {
          const q = new URLSearchParams({
            datasetId,
            bucket: (opts && opts.bucket) || bucket,
            top: '12',
          });
          const result = await apiGet(`/analysis?${q.toString()}`);
          setData(result);
          setState((s) => ({ ...s, error: '' }));
        } catch (err) {
          setState((s) => ({ ...s, error: err.message }));
        } finally {
          setAnalysisLoading(false);
        }
      }, [bucket]);

      useEffect(() => {
        loadState();
      }, [loadState]);

      useEffect(() => {
        if (activeId) loadAnalysis(activeId);
        else setData(null);
      }, [activeId, bucket, loadAnalysis]);

      const datasets = state.datasets;
      const activeDataset = datasets.find((d) => d.id === activeId) || null;

      const handleFiles = useCallback(
        async (files) => {
          const list = Array.from(files || []).filter(Boolean);
          if (!list.length) return;
          let targetId = activeId;
          const messages = [];
          for (let i = 0; i < list.length; i += 1) {
            const file = list[i];
            setImporting(`正在导入 ${i + 1}/${list.length}：${file.name}`);
            try {
              const res = await uploadFile(file, targetId);
              targetId = res.datasetId;
              const warnings = res.warnings || [];
              const stats = res.stats || {};
              const dd = stats.dedupe || {};
              const dedupeNote = dd.active ? `，自动去重 ${dd.cells || 0} 条重叠记录` : '';
              messages.push(`${file.name} → ${res.parsed ? res.parsed.records : 0} 行${dedupeNote}${warnings.length ? `（${warnings.length} 条提示）` : ''}`);
            } catch (err) {
              setState((s) => ({ ...s, error: `${file.name}：${err.message}` }));
            }
          }
          setImporting('');
          setNotice(messages.join('；'));
          await loadState(targetId);
          if (targetId) await loadAnalysis(targetId);
        },
        [activeId, loadAnalysis, loadState],
      );

      const onDrop = useCallback(
        (event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (event.dataTransfer && event.dataTransfer.files) handleFiles(event.dataTransfer.files);
        },
        [handleFiles],
      );

      const onDragEnter = useCallback((event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }, []);
      const onDragLeave = useCallback((event) => {
        event.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }, []);

      const removeDataset = useCallback(async () => {
        if (!activeId) return;
        const name = activeDataset ? activeDataset.name : activeId;
        if (!window.confirm(`删除数据集「${name}」及其本地原始文件？此操作不可撤销。`)) return;
        try {
          await apiPost('/delete', { datasetId: activeId });
          setNotice(`已删除 ${name}`);
          setData(null);
          setActiveId('');
          await loadState('');
        } catch (err) {
          setState((s) => ({ ...s, error: err.message }));
        }
      }, [activeId, activeDataset, loadState]);

      const saveGroups = useCallback(async () => {
        try {
          const keys = { ...(state.groups.keys || {}), ...groupDraft };
          Object.keys(keys).forEach((k) => {
            if (!keys[k] || !String(keys[k]).trim()) delete keys[k];
          });
          const res = await apiPost('/groups', { groups: { ...state.groups, keys } });
          setState((s) => ({ ...s, groups: res.groups }));
          setGroupDraft({});
          setNotice('分组已保存');
          if (activeId) await loadAnalysis(activeId);
        } catch (err) {
          setState((s) => ({ ...s, error: err.message }));
        }
      }, [activeId, groupDraft, loadAnalysis, state.groups]);

      const allKeys = useMemo(() => {
        const fromStats = activeDataset && activeDataset.stats && activeDataset.stats.keys ? activeDataset.stats.keys : [];
        const fromData = data && data.byKey ? data.byKey.map((r) => r.name).filter((n) => n !== '(未标注 Key)') : [];
        return Array.from(new Set([...fromStats, ...fromData])).sort();
      }, [activeDataset, data]);

      const breakdown = useMemo(() => {
        if (!data) return [];
        if (dimension === 'key') return data.byKey || [];
        if (dimension === 'group') return data.byGroup || [];
        return data.byModel || [];
      }, [data, dimension]);

      const composition = (data && data.composition) || [];

      /** 跨文件重叠账期自动去重的提示（有重叠时才显示）。 */
      const dedupeNote = (() => {
        const d = activeDataset && activeDataset.stats && activeDataset.stats.dedupe;
        if (!d || !d.active) return '';
        const days = d.overlapDays || 0;
        return ` · 已去重 ${days} 个重叠账期`;
      })();

      // 专业参数：由 series / totals 现场推导（不额外请求后端）
      const stats = useMemo(() => {
        if (!data) return null;
        const t = data.totals || {};
        const values = (data.series || []).map((s) => (metric === 'cost' ? s.cost : s.tokens));
        const sorted = values.slice().sort((a, b) => a - b);
        const median = sorted.length
          ? sorted.length % 2
            ? sorted[(sorted.length - 1) / 2]
            : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : 0;
        let peakIdx = -1;
        values.forEach((v, i) => {
          if (peakIdx < 0 || v > values[peakIdx]) peakIdx = i;
        });
        return {
          peakValue: peakIdx >= 0 ? values[peakIdx] : 0,
          peakBucket: peakIdx >= 0 ? data.series[peakIdx].bucket : '—',
          median,
          tokensPerRequest: t.requests ? t.tokens / t.requests : 0,
          costPerKToken: t.tokens ? (t.cost / t.tokens) * 1000 : 0,
          savingsShare: t.cost + t.cacheSavings > 0 ? t.cacheSavings / (t.cost + t.cacheSavings) : 0,
          estimatedShare: (data.quality && data.quality.estimatedCostShare) || 0,
          buckets: (data.series || []).length,
        };
      }, [data, metric]);

      // ── 渲染 ────────────────────────────────────────────────────────────────
      const toolbar = h(
        'div',
        { className: 'tu-head' },
        h(
          'div',
          null,
          h('h2', { className: 'tu-title' }, h('span', { className: 'tu-title-dot' }), 'Token 用量'),
          h(
            'div',
            { className: 'tu-sub' },
            data
              ? `${data.range.from} ~ ${data.range.to} · ${data.range.days} 天有数据 · ${data.quality.recordCount} 条聚合记录${dedupeNote}`
              : '导入 DeepSeek 官方导出 ZIP / 通用 CSV / JSON，本地解析，不上传',
          ),
        ),
        h('div', { className: 'tu-spacer' }),
        h(
          'div',
          { className: 'tu-actions' },
          datasets.length > 0 &&
            h(
              'select',
              {
                className: 'tu-select',
                value: activeId,
                onChange: (e) => setActiveId(e.target.value),
                title: '选择数据集',
              },
              datasets.map((d) => h('option', { key: d.id, value: d.id }, `${d.name}（${d.rowCount} 行）`)),
            ),
          h(
            'button',
            { className: 'tu-btn primary', onClick: () => fileRef.current && fileRef.current.click() },
            '导入文件',
          ),
          activeId &&
            h('button', { className: 'tu-btn danger', onClick: removeDataset, title: '删除当前数据集' }, '删除'),
        ),
      );

      const hiddenInput = h('input', {
        ref: fileRef,
        type: 'file',
        multiple: true,
        accept: '.zip,.csv,.json,.txt',
        style: { display: 'none' },
        onChange: (e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        },
      });

      let body;
      if (state.loading) {
        body = h('div', { className: 'tu-loading' }, '正在读取本地数据集…');
      } else if (!datasets.length) {
        body = h(
          'div',
          { className: `tu-empty${dragging ? ' drag' : ''}` },
          h('div', { style: { fontSize: 28, lineHeight: 1, opacity: 0.8 } }, '⬇'),
          h('h3', null, '把账单文件拖到这里'),
          h('p', null, '或点击右上角「导入文件」选择文件'),
          h(
            'ul',
            null,
            h('li', null, '· DeepSeek 官方导出 ZIP（含 amount-*.csv + cost-*.csv）'),
            h('li', null, '· 通用 CSV（需含日期列与 token 列）'),
            h('li', null, '· 通用 JSON（数组或 { data: [...] }）'),
            h('li', null, '· 可多次导入，自动合并为同一数据集'),
          ),
          h(
            'div',
            { style: { marginTop: 16, fontSize: 11, opacity: 0.5 } },
            '数据只在本机解析与保存（浏览器 ↔ 本机 DSH 进程），不会上传到任何外部服务。',
          ),
        );
      } else {
        const totals = (data && data.totals) || null;
        const cur = data ? data.currency : 'CNY';

        const kpiRow = h(
          'div',
          { className: 'tu-kpis tu-enter' },
          kpi('总 Token', totals ? fmtTokens(totals.tokens) : '—', totals ? `输入 ${fmtTokens(totals.input)} · 输出 ${fmtTokens(totals.output)}` : ''),
          kpi('总费用', totals ? fmtMoney(totals.cost, cur) : '—', totals ? `日均 ${fmtMoney(totals.avgCostPerDay, cur)}` : ''),
          kpi('缓存命中率', totals ? fmtPct(totals.cacheHitRate) : '—', totals ? `命中 ${fmtTokens(totals.hit)}` : ''),
          kpi('缓存节省', totals ? fmtMoney(totals.cacheSavings, cur) : '—', totals ? (totals.savingsEstimated ? '按内置价目估算' : '按账单单价计算') : ''),
          kpi('请求数', totals ? fmtInt(totals.requests) : '—', totals ? `均价 ${fmtMoney(totals.avgCostPerRequest, cur)}` : ''),
          kpi('日均 Token', totals ? fmtTokens(totals.avgTokensPerDay) : '—', totals ? `覆盖 ${data.range.spanDays} 天` : ''),
        );

        const controls = h(
          'div',
          { className: 'tu-bar-toolbar' },
          h(
            'div',
            { className: 'tu-seg' },
            [['day', '按日'], ['week', '按周'], ['month', '按月']].map(([v, label]) =>
              h('button', { key: v, className: bucket === v ? 'on' : '', onClick: () => setBucket(v) }, label),
            ),
          ),
          h(
            'div',
            { className: 'tu-seg' },
            [['tokens', 'Token'], ['cost', '费用']].map(([v, label]) =>
              h('button', { key: v, className: metric === v ? 'on' : '', onClick: () => setMetric(v) }, label),
            ),
          ),
          h(
            'div',
            { className: 'tu-seg' },
            [['bar', '柱状'], ['line', '折线']].map(([v, label]) =>
              h('button', { key: v, className: chartKind === v ? 'on' : '', onClick: () => setChartKind(v) }, label),
            ),
          ),
          h('div', { className: 'tu-spacer' }),
          h(
            'div',
            { className: 'tu-seg' },
            [['model', '模型'], ['key', 'API Key'], ['group', '分组']].map(([v, label]) =>
              h('button', { key: v, className: dimension === v ? 'on' : '', onClick: () => setDimension(v) }, label),
            ),
          ),
        );

        const trendCard = h(
          'div',
          { className: 'tu-card tu-enter', style: { marginBottom: 10 } },
          h(
            'div',
            { className: 'tu-card-head' },
            h(
              'div',
              { className: 'tu-card-title' },
              metric === 'tokens' ? 'Token 趋势' : '费用趋势',
            ),
            h('div', { style: { flex: 1 } }),
            metric === 'tokens'
              ? h(
                  'div',
                  { className: 'tu-legend' },
                  legendItem('输入·命中', COLORS.hit),
                  legendItem('输入·未命中', COLORS.miss),
                  legendItem('输出', COLORS.output),
                )
              : null,
          ),
          data && data.series.length
            ? h(TrendChart, { series: data.series, metric, currency: cur, kind: chartKind })
            : h('div', { className: 'tu-loading' }, analysisLoading ? '正在计算…' : '当前区间没有数据'),
        );

        const rankCard = h(
          'div',
          { className: 'tu-card tu-enter', style: { animationDelay: '40ms' } },
          h(
            'div',
            { className: 'tu-card-head' },
            h('div', { className: 'tu-card-title' }, { model: '模型排行', key: 'API Key 排行', group: '分组排行' }[dimension]),
            h('div', { style: { flex: 1 } }),
            h('span', { style: { fontSize: 10.5, opacity: 0.45 } }, metric === 'cost' ? '按费用' : '按 Token'),
          ),
          breakdown.length
            ? h(RankList, { rows: breakdown.slice(0, 6), currency: cur, valueKey: metric === 'cost' ? 'cost' : 'tokens' })
            : h('div', { className: 'tu-loading' }, '暂无数据'),
        );

        const compositionCard = h(
          'div',
          { className: 'tu-card tu-enter', style: { animationDelay: '70ms' } },
          h(
            'div',
            { className: 'tu-card-head' },
            h('div', { className: 'tu-card-title' }, 'Token 构成'),
            h('div', { style: { flex: 1 } }),
            h(
              'div',
              { className: 'tu-seg', style: { transform: 'scale(.94)' } },
              [['donut', '环形'], ['pie', '饼图'], ['bar', '条形']].map(([v, label]) =>
                h('button', { key: v, className: compVariant === v ? 'on' : '', onClick: () => setCompVariant(v) }, label),
              ),
            ),
          ),
          composition.length
            ? h(Composition, { items: composition, totals, variant: compVariant })
            : h('div', { className: 'tu-loading' }, '暂无数据'),
        );

        const paramsCard = h(
          'div',
          { className: 'tu-card tu-enter', style: { animationDelay: '100ms' } },
          h('div', { className: 'tu-card-head' }, h('div', { className: 'tu-card-title' }, '统计参数')),
          stats
            ? h(
                'div',
                { className: 'tu-kv' },
                kvItem('峰值区间', stats.peakBucket),
                kvItem('峰值用量', metric === 'cost' ? fmtMoney(stats.peakValue, cur) : fmtTokens(stats.peakValue)),
                kvItem('中位数', metric === 'cost' ? fmtMoney(stats.median, cur) : fmtTokens(stats.median)),
                kvItem('每请求 Token', fmtTokens(stats.tokensPerRequest)),
                kvItem('千 Token 单价', fmtMoney(stats.costPerKToken, cur)),
                kvItem('节省占比', fmtPct(stats.savingsShare)),
                kvItem('预估费用占比', fmtPct(stats.estimatedShare)),
                kvItem('区间数 / 天数', `${stats.buckets} / ${data.range.spanDays}`),
                dedupeNote ? kvItem('重叠账期去重', `${(activeDataset.stats.dedupe.overlapDays || 0)} 天`) : null,
              )
            : h('div', { className: 'tu-loading' }, '暂无数据'),
        );

        const anomalyCard = h(
          'div',
          { className: 'tu-card tu-enter', style: { animationDelay: '130ms' } },
          h('div', { className: 'tu-card-head' }, h('div', { className: 'tu-card-title' }, '异常用量检测')),
          data && data.anomalies && data.anomalies.length
            ? h(
                'div',
                null,
                data.anomalies.slice(0, 4).map((a, i) =>
                  h(
                    'div',
                    { className: 'tu-anomaly', key: `${a.day}-${a.metric}-${i}` },
                    h('span', { className: 'tu-tag' }, a.metric === 'tokens' ? 'Token' : '费用'),
                    h('span', { style: { fontWeight: 600 } }, a.day),
                    h(
                      'span',
                      { style: { opacity: 0.8 } },
                      a.metric === 'tokens'
                        ? `${fmtTokens(a.value)}（日常 ${fmtTokens(a.median)}）`
                        : `${fmtMoney(a.value, cur)}（日常 ${fmtMoney(a.median, cur)}）`,
                    ),
                    h('div', { style: { flex: 1 } }),
                    h('span', { style: { opacity: 0.6, fontSize: 11 } }, `${a.ratio}×`),
                  ),
                ),
              )
            : h('div', { style: { opacity: 0.55, fontSize: 12, padding: '4px 0' } }, '未发现明显突增（中位数 + MAD，至少 4 天数据）'),
        );

        const insightCard = h(
          'div',
          { className: 'tu-card tu-enter', style: { animationDelay: '160ms' } },
          h('div', { className: 'tu-card-head' }, h('div', { className: 'tu-card-title' }, '结论')),
          data && data.insights && data.insights.length
            ? data.insights.map((text, i) =>
                h('div', { key: i, style: { fontSize: 12, padding: '2px 0', opacity: 0.85 } }, `· ${text}`),
              )
            : h('div', { style: { opacity: 0.55, fontSize: 12 } }, '暂无结论'),
          data && data.quality.warnings && data.quality.warnings.length
            ? h('div', { className: 'tu-note' }, `数据提示：${data.quality.warnings.slice(0, 2).join('；')}`)
            : null,
        );

        const groupCard = h(
          'div',
          { className: 'tu-card tu-enter', style: { marginTop: 10, animationDelay: '190ms' } },
          h(
            'div',
            { className: 'tu-card-head', style: { marginBottom: showGroups ? 8 : 0 } },
            h('div', { className: 'tu-card-title' }, '自定义分组'),
            h('span', { style: { fontSize: 10.5, opacity: 0.45 } }, `${allKeys.length} 个 Key`),
            h('div', { style: { flex: 1 } }),
            showGroups
              ? h('button', { className: 'tu-btn', onClick: saveGroups, disabled: !Object.keys(groupDraft).length }, '保存分组')
              : null,
            h('button', { className: 'tu-btn', onClick: () => setShowGroups((v) => !v) }, showGroups ? '收起' : '展开'),
          ),
          showGroups
            ? h(
                'div',
                null,
                h('div', { style: { opacity: 0.55, fontSize: 11, marginBottom: 7 } }, '给每个 API Key 指定业务分组（如“项目甲”），排行与趋势会按组聚合。'),
                allKeys.length
                  ? h(
                      'div',
                      { className: 'tu-groups' },
                      allKeys.map((key) =>
                        h(
                          'div',
                          { className: 'tu-group-row', key },
                          h('span', { title: key }, key),
                          h('input', {
                            placeholder: '分组名',
                            defaultValue: groupDraft[key] !== undefined ? groupDraft[key] : (state.groups.keys || {})[key] || '',
                            onChange: (e) => setGroupDraft((d) => ({ ...d, [key]: e.target.value })),
                          }),
                        ),
                      ),
                    )
                  : h('div', { style: { opacity: 0.55, fontSize: 12 } }, '当前数据集没有 Key 维度（可能是通用 CSV，未提供 Key 列）'),
              )
            : null,
        );

        body = h(
          'div',
          null,
          kpiRow,
          controls,
          trendCard,
          h('div', { className: 'tu-row3' }, rankCard, compositionCard, paramsCard),
          h('div', { className: 'tu-row2' }, anomalyCard, insightCard),
          groupCard,
          h(
            'div',
            { className: 'tu-note' },
            `原始文件：${(activeDataset && activeDataset.files ? activeDataset.files : []).join('、') || '—'}`,
          ),
        );
      }

      const banner = state.error
        ? h(
            'div',
            { className: 'tu-banner err' },
            state.error,
            h(
              'button',
              {
                className: 'tu-btn',
                style: { marginLeft: 10, padding: '2px 8px' },
                onClick: () => setState((s) => ({ ...s, error: '' })),
              },
              '关闭',
            ),
          )
        : importing
          ? h('div', { className: 'tu-banner info' }, importing)
          : notice
            ? h('div', { className: 'tu-banner info' }, notice)
            : null;

      return h(
        'div',
        {
          className: narrow ? 'tu-root tu-narrow' : 'tu-root',
          onDragEnter,
          onDragOver: (e) => e.preventDefault(),
          onDragLeave,
          onDrop,
        },
        h('style', null, CSS),
        toolbar,
        banner,
        body,
        hiddenInput,
        dragging ? h('div', { style: { position: 'fixed', inset: 0, pointerEvents: 'none', border: `2px dashed ${ACCENT}`, borderRadius: 14, margin: 6 } }) : null,
      );
    }

    function kvItem(label, value) {
      return h(
        'div',
        { className: 'tu-kv-item' },
        h('span', { className: 'tu-kv-k' }, label),
        h('span', { className: 'tu-kv-v' }, value),
      );
    }

    function kpi(label, value, hint) {
      return h(
        'div',
        { className: 'tu-kpi' },
        h('div', { className: 'tu-kpi-label' }, label),
        h('div', { className: 'tu-kpi-value' }, value),
        hint ? h('div', { className: 'tu-kpi-hint' }, hint) : null,
      );
    }

    function legendItem(label, color) {
      return h('span', null, h('span', { className: 'tu-dot', style: { background: color } }), label);
    }

    // ────────────────────────────── 插件注册 ──────────────────────────────
    const PLUGIN_ID = 'dsh-token-usage';

    /** 侧边栏 tab 类型标识（也是 body seat 的 key） */
    const SIDEBAR_ID = 'dsh-token-usage';
    const SIDEBAR_KIND = 'dsh-token-usage';
    /** 指南胶囊排序：排在 Files(10)、Context(20) 之后 */
    const GUIDE_ORDER = 30;

    /** 侧边栏指南胶囊与 chip 标题共用的小图标：三根柱子 */
    function TuIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 2, y: 8, width: 3, height: 6, rx: 1, fill: 'currentColor', opacity: 0.55 }),
        h('rect', { x: 6.5, y: 5, width: 3, height: 9, rx: 1, fill: 'currentColor', opacity: 0.8 }),
        h('rect', { x: 11, y: 2, width: 3, height: 12, rx: 1, fill: 'currentColor' }),
      );
    }

    /** 侧边栏已打开时 chip 上的标题（图标 + 文案） */
    function TuTabTitle() {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h(TuIcon),
        'Token 用量',
      );
    }

    function apply(ctx) {
      const slots = ctx.slots;
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        // 没有 slots 服务时不阻塞整个客户端
        console.warn('[token-usage] 当前客户端没有 slots 服务，可视化面板未注册');
        return;
      }

      /**
       * 只挂右侧边栏（会话顶部的标签栏不再出现入口）。
       * ctx.inject 是延迟注入：harness 没有 sidebarRightTabs 服务时回调不会执行，
       * 插件 fiber 也不会挂起，老版本 DSH 上只是没有侧栏，不会报错。
       */
      ctx.effect(
        () =>
          ctx.inject(['sidebarRightTabs'], (injected) => {
            const tabs = injected && injected.sidebarRightTabs;
            if (!tabs || typeof tabs.register !== 'function') return;
            const disposers = [];
            const own = (r) => {
              if (typeof r === 'function') disposers.push(r);
            };
            try {
              own(
                tabs.register({
                  id: SIDEBAR_ID,
                  kind: SIDEBAR_KIND,
                  title: () => 'Token 用量',
                  guide: [
                    {
                      order: GUIDE_ORDER,
                      title: () => 'Token 用量',
                      description: () => '导入账单 ZIP / CSV / JSON，看费用趋势、缓存命中与模型排行',
                      icon: TuIcon,
                    },
                  ],
                }),
              );
              own(
                slots.inject('sidebar.right.pane.tab', () =>
                  slots.register(
                    { name: 'sidebar.right.pane.tab', key: SIDEBAR_ID },
                    (props) => h(TokenUsageView, { ...props, host: 'sidebar' }),
                  ),
                ),
              );
              own(
                slots.inject('sidebar.right.pane.tab.title', () =>
                  slots.register({ name: 'sidebar.right.pane.tab.title', key: SIDEBAR_ID }, TuTabTitle),
                ),
              );
            } catch (err) {
              // 侧栏注册表冲突（kind/id 被占）时退化为仅日志，不影响会话界面
              console.warn('[token-usage] 侧边栏 tab 注册失败：', err && err.message);
              for (const d of disposers) {
                try {
                  d();
                } catch {}
              }
              return;
            }
            return () => {
              for (const d of disposers) {
                try {
                  d();
                } catch {}
              }
            };
          }),
        'dsh-token-usage: sidebar tab',
      );

      /**
       * 会话顶部标签栏的大视图（宽版布局）。
       * 侧边栏那份是窄屏形态；两份共用同一组件，靠 host prop 切换排版。
       */
      ctx.effect(
        () =>
          slots.inject('conversation.view', () =>
            slots.register(
              {
                name: 'conversation.view',
                id: SIDEBAR_ID,
                order: 40,
                label: () => 'Token 用量',
              },
              (props) => h(TokenUsageView, { ...props, host: 'tab' }),
            ),
          ),
        'dsh-token-usage: conversation view',
      );
    }

    return { name: PLUGIN_ID, inject: ['slots'], apply };
  },
});
