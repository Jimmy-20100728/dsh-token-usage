/**
 * dsh-token-usage —— Client 侧（浏览器）
 *
 * 形态：在会话视图区注册一个 `conversation.view` 标签页「Token 用量」。
 * 数据：同源 fetch `/api/token-usage/*`（Host 侧路由，数据只在本机流转，不上传外网）。
 * 渲染：只依赖 react，图表是手写 SVG（无 ECharts / 无 externals），避免重型依赖。
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
        return doc && doc.error ? String(doc.error) : '';
      } catch {
        return text && text.length < 300 ? text : '';
      }
    }

    async function uploadFile(file, datasetId) {
      const buffer = await file.arrayBuffer();
      const headers = {
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name),
      };
      if (datasetId) headers['x-dataset-id'] = encodeURIComponent(datasetId);
      const res = await fetch(`${API}/import`, { method: 'POST', credentials: 'include', headers, body: buffer });
      const text = await res.text();
      if (!res.ok) throw new Error(parseError(text) || `导入失败：HTTP ${res.status}`);
      return JSON.parse(text);
    }

    // ────────────────────────────── 样式 ──────────────────────────────
    const ACCENT = '#4f7cff';
    const COLORS = { hit: '#34c38f', miss: '#4f7cff', output: '#f5a524' };

    const CSS = `
.tu-root{height:100%;overflow:auto;padding:18px 20px 48px;font-size:13px;line-height:1.55;color:inherit;box-sizing:border-box}
.tu-root *{box-sizing:border-box}
.tu-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.tu-title{font-size:17px;font-weight:650;letter-spacing:.2px;margin:0}
.tu-sub{opacity:.62;font-size:12px;margin-top:2px}
.tu-spacer{flex:1 1 auto}
.tu-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tu-btn{appearance:none;border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.08);color:inherit;
  padding:6px 12px;border-radius:8px;font-size:12.5px;cursor:pointer;transition:background .15s,border-color .15s}
.tu-btn:hover{background:rgba(127,127,127,.16);border-color:rgba(127,127,127,.42)}
.tu-btn.primary{background:${ACCENT};border-color:${ACCENT};color:#fff}
.tu-btn.primary:hover{filter:brightness(1.08)}
.tu-btn[disabled]{opacity:.5;cursor:not-allowed}
.tu-btn.danger{color:#e5484d;border-color:rgba(229,72,77,.4)}
.tu-select{appearance:none;border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.08);color:inherit;
  padding:6px 10px;border-radius:8px;font-size:12.5px;max-width:280px}
.tu-card{background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.16);border-radius:12px;padding:14px 16px}
.tu-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.tu-kpi{background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.16);border-radius:12px;padding:11px 13px}
.tu-kpi-label{font-size:11.5px;opacity:.62;display:flex;align-items:center;gap:6px}
.tu-kpi-value{font-size:20px;font-weight:650;margin-top:4px;font-variant-numeric:tabular-nums}
.tu-kpi-hint{font-size:11px;opacity:.55;margin-top:2px}
.tu-bar-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.tu-seg{display:inline-flex;background:rgba(127,127,127,.1);border-radius:9px;padding:2px;gap:2px}
.tu-seg button{appearance:none;border:0;background:transparent;color:inherit;opacity:.7;font-size:12px;
  padding:5px 11px;border-radius:7px;cursor:pointer}
.tu-seg button.on{background:rgba(127,127,127,.24);opacity:1;font-weight:600}
.tu-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:12px}
@media (max-width:900px){.tu-grid{grid-template-columns:1fr}}
.tu-svg{width:100%;height:auto;display:block;overflow:visible}
.tu-axis{font-size:10px;fill:currentColor;opacity:.5}
.tu-empty{border:1.5px dashed rgba(127,127,127,.4);border-radius:16px;padding:46px 26px;text-align:center;transition:border-color .15s,background .15s}
.tu-empty.drag{border-color:${ACCENT};background:rgba(79,124,255,.08)}
.tu-empty h3{margin:10px 0 6px;font-size:15px}
.tu-empty p{margin:4px 0;opacity:.66;font-size:12.5px}
.tu-empty ul{margin:14px auto 0;padding:0;list-style:none;display:inline-block;text-align:left;font-size:12px;opacity:.7}
.tu-empty li{padding:2px 0}
.tu-banner{border-radius:10px;padding:9px 12px;font-size:12.5px;margin-bottom:12px}
.tu-banner.err{background:rgba(229,72,77,.12);border:1px solid rgba(229,72,77,.3);color:#e5484d}
.tu-banner.info{background:rgba(79,124,255,.1);border:1px solid rgba(79,124,255,.28)}
.tu-rank{display:flex;flex-direction:column;gap:9px}
.tu-rank-row{display:grid;grid-template-columns:minmax(70px,1fr) 2.2fr auto;gap:10px;align-items:center;font-size:12px}
.tu-rank-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.86}
.tu-track{height:7px;border-radius:99px;background:rgba(127,127,127,.16);overflow:hidden}
.tu-fill{height:100%;border-radius:99px;background:${ACCENT}}
.tu-rank-val{font-variant-numeric:tabular-nums;opacity:.8;white-space:nowrap}
.tu-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;opacity:.75;margin-top:8px}
.tu-dot{width:8px;height:8px;border-radius:3px;display:inline-block;margin-right:5px}
.tu-anomaly{display:flex;gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px dashed rgba(127,127,127,.18);font-size:12.5px}
.tu-anomaly:last-child{border-bottom:0}
.tu-tag{font-size:10.5px;padding:1px 7px;border-radius:99px;background:rgba(245,165,36,.18);border:1px solid rgba(245,165,36,.4)}
.tu-groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px}
.tu-group-row{display:flex;align-items:center;gap:8px;font-size:12px}
.tu-group-row span{flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.8}
.tu-group-row input{flex:0 0 130px;background:rgba(127,127,127,.1);border:1px solid rgba(127,127,127,.24);
  border-radius:7px;padding:4px 8px;color:inherit;font-size:12px}
.tu-note{font-size:11.5px;opacity:.55;margin-top:10px}
.tu-loading{padding:40px;text-align:center;opacity:.6}
.tu-scroll{overflow:auto;max-height:340px}
`;

    // ────────────────────────────── 小图表 ──────────────────────────────

    /** 堆叠柱状趋势图（token）或单色柱状图（费用）。纯 SVG，无依赖。 */
    function TrendChart({ series, metric, currency }) {
      const W = 760;
      const H = metric === 'cost' ? 190 : 220;
      const padL = 10;
      const padR = 10;
      const padT = 14;
      const padB = 26;
      const innerW = W - padL - padR;
      const innerH = H - padT - padB;
      const n = Math.max(1, series.length);
      const maxVal = Math.max(
        1,
        ...series.map((s) => (metric === 'cost' ? s.cost : s.tokens)),
      );
      const step = innerW / n;
      const barW = Math.max(2, Math.min(30, step * 0.62));
      const labelEvery = Math.max(1, Math.ceil(n / 9));

      const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) =>
        h('line', {
          key: `g${f}`,
          x1: padL,
          x2: W - padR,
          y1: padT + innerH * f,
          y2: padT + innerH * f,
          stroke: 'currentColor',
          strokeOpacity: 0.1,
          strokeWidth: 1,
        }),
      );

      const bars = series.map((s, i) => {
        const x = padL + step * i + (step - barW) / 2;
        const title =
          metric === 'cost'
            ? `${s.bucket} · ${fmtMoney(s.cost, currency)}`
            : `${s.bucket}\n输入(命中) ${fmtInt(s.hit)}\n输入(未命中) ${fmtInt(s.miss)}\n输出 ${fmtInt(s.output)}\n合计 ${fmtInt(s.tokens)}`;

        if (metric === 'cost') {
          const bh = (s.cost / maxVal) * innerH;
          return h(
            'g',
            { key: s.bucket },
            h('rect', {
              x,
              y: padT + innerH - bh,
              width: barW,
              height: Math.max(bh, s.cost > 0 ? 1.5 : 0),
              fill: ACCENT,
              rx: Math.min(3, barW / 3),
            }),
            h('title', null, title),
          );
        }

        const parts = [
          ['hit', s.hit, COLORS.hit],
          ['miss', s.miss, COLORS.miss],
          ['output', s.output, COLORS.output],
        ];
        let y = padT + innerH;
        const rects = parts.map(([key, value, color]) => {
          const bh = (value / maxVal) * innerH;
          y -= bh;
          return h('rect', {
            key,
            x,
            y,
            width: barW,
            height: Math.max(bh, value > 0 ? 0.8 : 0),
            fill: color,
          });
        });
        return h('g', { key: s.bucket }, rects, h('title', null, title));
      });

      const labels = series.map((s, i) => {
        if (i % labelEvery !== 0) return null;
        return h(
          'text',
          {
            key: `l${s.bucket}`,
            x: padL + step * i + step / 2,
            y: H - 8,
            textAnchor: 'middle',
            className: 'tu-axis',
          },
          s.bucket.length > 7 ? s.bucket.slice(5) : s.bucket,
        );
      });

      return h(
        'div',
        null,
        h(
          'svg',
          { viewBox: `0 0 ${W} ${H}`, className: 'tu-svg', preserveAspectRatio: 'none', role: 'img' },
          gridLines,
          bars,
          labels,
        ),
        h(
          'div',
          { className: 'tu-note' },
          `峰值 ${metric === 'cost' ? fmtMoney(maxVal, currency) : fmtTokens(maxVal)} · 共 ${series.length} 个数据点`,
        ),
      );
    }

    /** 环形图：输入命中 / 未命中 / 输出 构成。 */
    function Donut({ items, size = 128 }) {
      const total = items.reduce((a, b) => a + b.tokens, 0) || 1;
      const r = size / 2 - 13;
      const c = 2 * Math.PI * r;
      let acc = 0;
      const arcs = items.map((item, i) => {
        const frac = item.tokens / total;
        const dash = `${Math.max(0, frac * c)} ${c}`;
        const offset = -acc * c;
        acc += frac;
        return h('circle', {
          key: i,
          cx: size / 2,
          cy: size / 2,
          r,
          fill: 'none',
          stroke: COLORS[item.key] || ACCENT,
          strokeWidth: 13,
          strokeDasharray: dash,
          strokeDashoffset: offset,
          transform: `rotate(-90 ${size / 2} ${size / 2})`,
        });
      });
      return h(
        'svg',
        { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img' },
        h('circle', {
          cx: size / 2,
          cy: size / 2,
          r,
          fill: 'none',
          stroke: 'currentColor',
          strokeOpacity: 0.12,
          strokeWidth: 13,
        }),
        arcs,
      );
    }

    function RankList({ rows, currency, valueKey, totalLabel }) {
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
              valueKey === 'cost'
                ? fmtMoney(row.cost, currency)
                : `${fmtTokens(row.tokens)} · ${fmtPct(row.share)}`,
            ),
          ),
        ),
        h('div', { className: 'tu-note' }, totalLabel || ''),
      );
    }

    // ────────────────────────────── 主视图 ──────────────────────────────

    function TokenUsageView() {
      const [state, setState] = useState({ loading: true, error: '', datasets: [], groups: { keys: {}, models: {} } });
      const [activeId, setActiveId] = useState('');
      const [data, setData] = useState(null);
      const [analysisLoading, setAnalysisLoading] = useState(false);
      const [bucket, setBucket] = useState('day');
      const [metric, setMetric] = useState('tokens');
      const [dimension, setDimension] = useState('model');
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
              messages.push(`${file.name} → ${res.parsed ? res.parsed.records : 0} 行${warnings.length ? `（${warnings.length} 条提示）` : ''}`);
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

      // ── 渲染 ────────────────────────────────────────────────────────────────
      const toolbar = h(
        'div',
        { className: 'tu-head' },
        h(
          'div',
          null,
          h('h2', { className: 'tu-title' }, 'Token 用量'),
          h(
            'div',
            { className: 'tu-sub' },
            data
              ? `${data.range.from} ~ ${data.range.to} · ${data.range.days} 天有数据 · ${data.quality.recordCount} 条聚合记录`
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
          h('div', { style: { fontSize: 30, lineHeight: 1 } }, '⬇'),
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
            { style: { marginTop: 18, fontSize: 11.5, opacity: 0.55 } },
            '数据只在本机解析与保存（浏览器 ↔ 本机 DSH 进程），不会上传到任何外部服务。',
          ),
        );
      } else {
        const totals = (data && data.totals) || null;
        const kpiRow = h(
          'div',
          { className: 'tu-kpis' },
          kpi('总 Token', totals ? fmtTokens(totals.tokens) : '—', totals ? `输入 ${fmtTokens(totals.input)} · 输出 ${fmtTokens(totals.output)}` : ''),
          kpi('总费用', totals ? fmtMoney(totals.cost, data.currency) : '—', totals ? `日均 ${fmtMoney(totals.avgCostPerDay, data.currency)}` : ''),
          kpi('缓存命中率', totals ? fmtPct(totals.cacheHitRate) : '—', totals ? `命中 ${fmtTokens(totals.hit)} token` : ''),
          kpi(
            '缓存节省',
            totals ? fmtMoney(totals.cacheSavings, data.currency) : '—',
            totals ? (totals.savingsEstimated ? '按内置价目估算' : '按账单单价计算') : '',
          ),
          kpi('请求数', totals ? fmtInt(totals.requests) : '—', totals ? `单次均价 ${fmtMoney(totals.avgCostPerRequest, data.currency)}` : ''),
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
          { className: 'tu-card' },
          h(
            'div',
            { className: 'tu-bar-toolbar', style: { marginBottom: 4 } },
            h('div', { style: { fontWeight: 600 } }, metric === 'tokens' ? 'Token 趋势（按输入/输出构成堆叠）' : '费用趋势'),
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
            ? h(TrendChart, { series: data.series, metric, currency: data.currency })
            : h('div', { className: 'tu-loading' }, analysisLoading ? '正在计算…' : '当前区间没有数据'),
        );

        const rankCard = h(
          'div',
          { className: 'tu-card' },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, { model: '模型排行', key: 'API Key 排行', group: '分组排行' }[dimension]),
          breakdown.length
            ? h(RankList, {
                rows: breakdown,
                currency: data ? data.currency : 'CNY',
                valueKey: metric === 'cost' ? 'cost' : 'tokens',
                totalLabel: dimension === 'key' ? '各 Key 按 token 占比，费用为账单按权重分摊' : '',
              })
            : h('div', { className: 'tu-loading' }, '暂无数据'),
        );

        const compositionCard = h(
          'div',
          { className: 'tu-card' },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, 'Token 构成'),
          h(
            'div',
            { style: { display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' } },
            h(Donut, { items: composition }),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 130 } },
              composition.map((item) =>
                h(
                  'div',
                  { key: item.key, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } },
                  h('span', { className: 'tu-dot', style: { background: COLORS[item.key] } }),
                  h('span', { style: { flex: 1 } }, item.label),
                  h('span', { style: { fontWeight: 600 } }, fmtTokens(item.tokens)),
                  h('span', { style: { opacity: 0.55, minWidth: 44, textAlign: 'right' } }, fmtPct(
                    totals && totals.tokens ? item.tokens / totals.tokens : 0,
                  )),
                ),
              ),
            ),
          ),
        );

        const anomalyCard = h(
          'div',
          { className: 'tu-card' },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '异常用量检测'),
          data && data.anomalies && data.anomalies.length
            ? h(
                'div',
                null,
                data.anomalies.map((a, i) =>
                  h(
                    'div',
                    { className: 'tu-anomaly', key: `${a.day}-${a.metric}-${i}` },
                    h('span', { className: 'tu-tag' }, a.metric === 'tokens' ? 'Token' : '费用'),
                    h('span', { style: { fontWeight: 600 } }, a.day),
                    h('span', null, a.metric === 'tokens' ? `${fmtTokens(a.value)}（日常 ${fmtTokens(a.median)}）` : `${fmtMoney(a.value, data.currency)}（日常 ${fmtMoney(a.median, data.currency)}）`),
                    h('div', { style: { flex: 1 } }),
                    h('span', { style: { opacity: 0.7 } }, `${a.ratio}× · z=${a.z}`),
                  ),
                ),
              )
            : h('div', { style: { opacity: 0.6, fontSize: 12.5, padding: '6px 0' } }, '未发现明显突增（中位数 + MAD 判定，至少需要 4 天数据）'),
        );

        const groupCard = h(
          'div',
          { className: 'tu-card' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 } },
            h('div', { style: { fontWeight: 600 } }, '自定义分组'),
            h('div', { style: { flex: 1 } }),
            h('button', { className: 'tu-btn', onClick: saveGroups, disabled: !Object.keys(groupDraft).length }, '保存分组'),
          ),
          h('div', { style: { opacity: 0.6, fontSize: 11.5, marginBottom: 8 } }, '给每个 API Key 指定一个业务分组（如“项目甲”），排行与趋势会按组聚合。'),
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
            : h('div', { style: { opacity: 0.6, fontSize: 12.5 } }, '当前数据集没有 Key 维度（可能是通用 CSV，未提供 Key 列）'),
        );

        const insightCard =
          data && data.insights && data.insights.length
            ? h(
                'div',
                { className: 'tu-card' },
                h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '结论'),
                data.insights.map((text, i) =>
                  h('div', { key: i, style: { fontSize: 12.5, padding: '3px 0', opacity: 0.85 } }, `· ${text}`),
                ),
                data.quality.warnings && data.quality.warnings.length
                  ? h(
                      'div',
                      { className: 'tu-note' },
                      `数据提示：${data.quality.warnings.slice(0, 3).join('；')}`,
                    )
                  : null,
              )
            : null;

        body = h(
          'div',
          null,
          kpiRow,
          controls,
          h('div', { style: { marginBottom: 12 } }, trendCard),
          h('div', { className: 'tu-grid' }, rankCard, compositionCard),
          h('div', { className: 'tu-grid', style: { marginTop: 12 } }, anomalyCard, insightCard || compositionCard),
          h('div', { style: { marginTop: 12 } }, groupCard),
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
          className: 'tu-root',
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

    function apply(ctx) {
      const slots = ctx.slots;
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        // 没有 slots 服务时不阻塞整个客户端
        console.warn('[token-usage] 当前客户端没有 slots 服务，可视化面板未注册');
        return;
      }
      ctx.effect(
        () =>
          slots.inject('conversation.view', () =>
            slots.register(
              { name: 'conversation.view', id: 'token-usage', order: 40, label: 'Token 用量' },
              (props) => h(TokenUsageView, props),
            ),
          ),
        'dsh-token-usage: conversation view',
      );
    }

    return { name: PLUGIN_ID, inject: ['slots'], apply };
  },
});
