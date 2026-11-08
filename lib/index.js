/**
 * dsh-token-usage —— DSH 插件入口。
 *
 * 职责很小：解析配置 → 建数据集存储 → 挂 HTTP 路由（给 Web UI 用）→ 注册对话工具。
 * 真正的解析/统计逻辑在 lib/core/ 下，路由在 lib/routes.js。
 *
 * 导出约定（DSH 插件规范）：
 *   export const name   插件名
 *   export const inject 依赖的 Host 服务
 *   export function apply(ctx, config) 入口，所有资源通过 ctx.effect 注册并返回清理函数
 */
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { createStore } from './core/store.js';
import { analyze } from './core/analyze.js';
import { ingestFiles } from './core/ingest.js';
import { registerRoutes } from './routes.js';

export const name = 'dsh-token-usage';
export const inject = ['tools', 'webServer'];

const TOOL_NAME = 'token_analysis';

/** 数据目录：默认跟着 DSH_HOME，可用插件配置 dataDir 改。 */
function resolveDataDir(config) {
  if (config && typeof config.dataDir === 'string' && config.dataDir.trim()) return config.dataDir.trim();
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'token-usage');
}

function makeLogger(ctx) {
  const logger = ctx.logger ? ctx.logger(name) : null;
  return {
    info: (...args) => (logger && logger.info ? logger.info(...args) : console.log(...args)),
    warn: (...args) => (logger && logger.warn ? logger.warn(...args) : console.warn(...args)),
    error: (...args) => (logger && logger.error ? logger.error(...args) : console.error(...args)),
  };
}

const num = (v) => (Number.isFinite(v) ? v : 0);
const fmtInt = (v) => Math.round(num(v)).toLocaleString('en-US');
const fmtMoney = (v, currency) => `${num(v).toFixed(num(v) >= 100 ? 2 : 4)} ${currency || ''}`.trim();
const pct = (v) => `${(num(v) * 100).toFixed(1)}%`;

/** 工具返回值的文本渲染（对话里直接可读）。 */
function renderAnalysis(value) {
  if (!value || value.ok !== true) {
    return [{ type: 'text', text: value && value.summary ? value.summary : '没有可分析的数据。' }];
  }
  const lines = [];
  lines.push(`**Token 用量分析** · ${value.dataset ? value.dataset.name : ''}`);
  lines.push(`区间 ${value.range.from} ~ ${value.range.to}（${value.range.days} 天有数据）`);
  lines.push('');
  lines.push(
    `总 Token **${fmtInt(value.totals.tokens)}**｜费用 **${fmtMoney(value.totals.cost, value.currency)}**｜` +
      `请求 ${fmtInt(value.totals.requests)}｜缓存命中率 ${pct(value.totals.cacheHitRate)}`,
  );
  lines.push(
    `缓存节省 ${fmtMoney(value.totals.cacheSavings, value.currency)}${value.totals.savingsEstimated ? '（估算）' : ''}｜` +
      `日均 Token ${fmtInt(value.totals.avgTokensPerDay)}｜日均费用 ${fmtMoney(value.totals.avgCostPerDay, value.currency)}`,
  );

  const dimTitle = { model: '按模型', key: '按 API Key', group: '按自定义分组' }[value.dimension] || '按模型';
  if (Array.isArray(value.breakdown) && value.breakdown.length) {
    lines.push('');
    lines.push(`${dimTitle}：`);
    for (const row of value.breakdown) {
      lines.push(
        `- ${row.name}：${fmtInt(row.tokens)} token（${pct(row.share)}），${fmtMoney(row.cost, value.currency)}，命中率 ${pct(row.cacheHitRate)}`,
      );
    }
  }

  if (Array.isArray(value.anomalies) && value.anomalies.length) {
    lines.push('');
    lines.push('异常用量：');
    for (const a of value.anomalies) {
      const metric = a.metric === 'tokens' ? 'Token' : '费用';
      lines.push(`- ${a.day} ${metric}为平时的 ${a.ratio} 倍（${metric === 'Token' ? fmtInt(a.value) : a.value}，z=${a.z}）`);
    }
  }

  if (Array.isArray(value.insights) && value.insights.length) {
    lines.push('');
    for (const tip of value.insights) lines.push(`> ${tip}`);
  }

  if (value.quality && value.quality.warnings && value.quality.warnings.length) {
    lines.push('');
    lines.push('数据提示：');
    for (const w of value.quality.warnings.slice(0, 5)) lines.push(`- ${w}`);
  }

  lines.push('');
  lines.push('在 Web 界面的「Token 用量」标签页可以看到完整图表与分组编辑。');
  return [{ type: 'text', text: lines.join('\n') }];
}

/** 把完整分析压成工具返回值（结构稳定，避免把整个 series 塞给模型）。 */
function toolValue(result) {
  const dimension = result._dimension || 'model';
  const breakdownKey = dimension === 'key' ? 'byKey' : dimension === 'group' ? 'byGroup' : 'byModel';
  return {
    ok: true,
    summary: `总 Token ${fmtInt(result.totals.tokens)}，费用 ${fmtMoney(result.totals.cost, result.currency)}，缓存命中率 ${pct(result.totals.cacheHitRate)}。`,
    dataset: result.dataset ? { id: result.dataset.id, name: result.dataset.name } : undefined,
    currency: result.currency,
    range: result.range,
    bucket: result.bucket,
    dimension,
    totals: result.totals,
    breakdown: result[breakdownKey],
    anomalies: result.anomalies,
    insights: result.insights,
    quality: result.quality,
    series: result.series.slice(-90),
  };
}

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx);
  const dataDir = resolveDataDir(config);
  const store = createStore(dataDir);

  // 数据集目录按需创建；失败不阻塞插件加载（工具会再次报错提示）
  void mkdir(dataDir, { recursive: true }).catch((err) => {
    logger.warn(`[token-usage] 无法创建数据目录 ${dataDir}: ${err.message}`);
  });

  // ── 1. HTTP 路由（Web UI 的数据通道）───────────────────────────────────────
  ctx.effect(() => registerRoutes(ctx, { store, logger }), 'dsh-token-usage: routes');

  // ── 2. 对话工具 ────────────────────────────────────────────────────────────
  const tool = {
    name: TOOL_NAME,
    description:
      '分析 Token 使用与费用（本地数据，不上传）。数据来源：DeepSeek 官方导出 ZIP（amount-*.csv + cost-*.csv）、' +
      '通用 CSV、通用 JSON。可按日/周/月查看趋势，对比模型 / API Key / 自定义分组，计算缓存命中率与节省，' +
      '并检测某日用量突增。未指定 path 时分析已导入的最新数据集。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: '可选：直接分析本机文件路径（.zip / .csv / .json）。不传则用已导入的数据集。',
        },
        dataset: {
          type: 'string',
          description: '数据集 id 或名称（默认最新导入的那个）。',
        },
        bucket: {
          type: 'string',
          enum: ['day', 'week', 'month'],
          description: '趋势粒度，默认 day。',
        },
        from: { type: 'string', description: '起始日期 YYYY-MM-DD（含）。' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD（含）。' },
        group_by: {
          type: 'string',
          enum: ['model', 'key', 'group'],
          description: '主要对比维度，默认 model。',
        },
        top: { type: 'number', description: '排行返回条数，默认 8。' },
        persist: {
          type: 'boolean',
          description: '配合 path：把该文件保存进数据集，后续可在界面里继续分析。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          range: { type: 'object' },
          totals: { type: 'object' },
          breakdown: { type: 'array', items: { type: 'object' } },
          anomalies: { type: 'array', items: { type: 'object' } },
          insights: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderAnalysis(value),
    },
    presentCall(args) {
      return { card: 'generic', title: 'Token 用量分析', kind: 'read' };
    },
    async execute(args) {
      const options = {
        bucket: args.bucket || 'day',
        from: args.from || '',
        to: args.to || '',
        top: Number(args.top) || 8,
        anomalyThreshold: 0,
      };
      const dimension = args.group_by || 'model';
      options._dimension = dimension;

      // 分支 A：直接分析本机文件
      if (args.path) {
        const buffer = await readFile(args.path);
        const rows = ingestFiles([{ name: basename(args.path), buffer }]);
        if (args.persist) {
          const meta = await store.create(basename(args.path));
          const saved = await store.addFiles(meta.id, [{ name: basename(args.path), buffer }]);
          options.datasetId = saved.meta.id;
          const groups = await store.groups();
          const result = analyze(saved.rows, { ...options, groups });
          result.dataset = { id: saved.meta.id, name: saved.meta.name };
          result._dimension = dimension;
          return toolValue(result);
        }
        const groups = await store.groups();
        const result = analyze(rows, { ...options, groups });
        result.dataset = { id: '', name: basename(args.path) };
        result._dimension = dimension;
        return toolValue(result);
      }

      // 分支 B：已导入的数据集
      const meta = await store.find(args.dataset || '');
      if (!meta) {
        return {
          ok: false,
          summary:
            '还没有任何 Token 用量数据。请在 DSH Web 界面打开「Token 用量」标签页拖入 DeepSeek 官方导出 ZIP / CSV / JSON，' +
            '或再次调用本工具并传 path 指向本地文件。',
        };
      }
      const full = await store.get(meta.id);
      if (!full) throw new Error(`数据集 ${meta.id} 内容缺失，请重新导入`);
      const groups = await store.groups();
      const result = analyze(full.rows, { ...options, groups, datasetId: meta.id });
      result.dataset = { id: meta.id, name: meta.name };
      result._dimension = dimension;
      return toolValue(result);
    },
  };

  ctx.effect(() => {
    try {
      const dispose = ctx.tools.register(tool);
      logger.info(`[token-usage] 已注册工具 ${TOOL_NAME}，数据目录 ${dataDir}`);
      return typeof dispose === 'function' ? dispose : () => {};
    } catch (err) {
      logger.error(`[token-usage] 注册工具失败: ${err && err.message ? err.message : err}`);
      return () => {};
    }
  }, 'dsh-token-usage: tool');
}
