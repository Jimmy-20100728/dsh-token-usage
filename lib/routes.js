/**
 * HTTP 路由层：只做「鉴权栅栏 + 参数校验 + 调 core」，不含业务计算。
 *
 * 全部挂在 `/api/token-usage` 一个 prefix 路由下（手动分发子路径），
 * 好处：只需注册一次，不会和其他插件的路由撞名（DSH 对同名路由会抛错）。
 *
 * 鉴权：优先复用 Host 的 connection.requestRejection(req)（浏览器 cookie 认证 +
 * Host/Origin 栅栏，与 DSH 自己的 /api 一致）；老版本没有该能力时退回 loopback 判断。
 */
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { analyze } from './core/analyze.js';
import { ingestFiles } from './core/ingest.js';

export const ROUTE_PREFIX = '/api/token-usage';
const MAX_BODY_BYTES = 256 * 1024 * 1024; // 单个上传上限 256MB

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** 复用 Host 的连接鉴权；返回 undefined 表示放行，否则返回 HTTP 状态码。 */
function rejectionFor(ctx, req) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection;
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      // 必须绑定 this：requestRejection 是类方法，内部读 this.trustedHosts / browserAuth
      return connection.requestRejection(req);
    } catch {
      return 403;
    }
  }
  // 老版本兜底：仅信任本机回环
  const remote = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return undefined;
  return 403;
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`请求体超过上限（${Math.round(limit / 1024 / 1024)}MB）`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req, limit) {
  const body = await readBody(req, limit);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (err) {
    throw new Error(`请求体不是合法 JSON：${err.message}`);
  }
}

function decodeHeader(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

function summarize(meta) {
  return {
    id: meta.id,
    name: meta.name,
    currency: meta.currency,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    fileCount: (meta.files || []).length,
    files: (meta.files || []).map((f) => f.name),
    rowCount: meta.stats ? meta.stats.rowCount : 0,
    stats: meta.stats || null,
    warnings: meta.warnings || [],
  };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function createHandler({ ctx, store, logger }) {
  return async function handler(req, res) {
    const rejection = rejectionFor(ctx, req);
    if (rejection !== undefined) {
      sendText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden');
      return;
    }

    let pathname = '/';
    let search = new URLSearchParams();
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      pathname = url.pathname.slice(ROUTE_PREFIX.length) || '/';
      search = url.searchParams;
    } catch {
      sendJson(res, 400, { error: '请求 URL 无法解析' });
      return;
    }

    try {
      // ── 状态：数据集列表 + 分组 ────────────────────────────────────────────
      if (pathname === '/state' && req.method === 'GET') {
        const [metas, groups] = await Promise.all([store.list(), store.groups()]);
        sendJson(res, 200, {
          datasets: metas.map(summarize),
          groups,
          dataDir: store.root,
        });
        return;
      }

      // ── 导入：请求体是原始文件字节，文件名放在 x-file-name 头 ──────────────
      if (pathname === '/import' && req.method === 'POST') {
        const fileName = decodeHeader(req.headers['x-file-name']) || 'upload.csv';
        const datasetId = decodeHeader(req.headers['x-dataset-id']);
        const buffer = await readBody(req);
        if (!buffer.length) throw new Error('没有收到文件内容');

        let meta = datasetId ? await store.getMeta(datasetId) : null;
        let created = false;
        if (!meta) {
          meta = await store.create(defaultDatasetName(fileName));
          created = true;
        }
        const { meta: updated, rows } = await store.addFiles(meta.id, [{ name: fileName, buffer }]);
        logger.info?.(
          `[token-usage] 导入 ${fileName} → 数据集 ${updated.id}（${rows.records.length} 行）`,
        );
        sendJson(res, 200, {
          datasetId: updated.id,
          created,
          name: updated.name,
          files: updated.files,
          stats: updated.stats,
          warnings: updated.warnings,
          parsed: {
            records: rows.records.length,
            billed: rows.billed.length,
            adapters: (rows.files || []).map((f) => ({ name: f.name, adapter: f.adapter, rows: f.rows, error: f.error })),
          },
        });
        return;
      }

      // ── 按服务器本地路径导入（工具 / 命令行更方便）────────────────────────
      if (pathname === '/import-path' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const filePath = String(body.path || '');
        if (!filePath) throw new Error('缺少 path');
        const info = await stat(filePath).catch(() => null);
        if (!info || !info.isFile()) throw new Error(`文件不存在：${filePath}`);
        const buffer = await readFile(filePath);
        let meta = body.datasetId ? await store.getMeta(String(body.datasetId)) : null;
        const created = !meta;
        if (!meta) meta = await store.create(String(body.name || defaultDatasetName(basename(filePath))));
        const { meta: updated, rows } = await store.addFiles(meta.id, [{ name: basename(filePath), buffer }]);
        sendJson(res, 200, {
          datasetId: updated.id,
          created,
          name: updated.name,
          stats: updated.stats,
          warnings: updated.warnings,
          parsed: { records: rows.records.length, billed: rows.billed.length },
        });
        return;
      }

      // ── 分析 ───────────────────────────────────────────────────────────────
      if (pathname === '/analysis' && req.method === 'GET') {
        const datasetKey = search.get('datasetId') || search.get('dataset') || '';
        const meta = await store.find(datasetKey);
        if (!meta) throw new Error(datasetKey ? `找不到数据集：${datasetKey}` : '还没有任何数据集，请先导入文件');
        const full = await store.get(meta.id);
        if (!full) throw new Error('数据集内容缺失，请重新导入');
        const groups = await store.groups();
        const result = analyze(full.rows, {
          datasetId: meta.id,
          bucket: search.get('bucket') || 'day',
          from: search.get('from') || '',
          to: search.get('to') || '',
          top: Number(search.get('top') || 10),
          groups,
          anomalyThreshold: Number(search.get('anomalyThreshold') || 0),
        });
        result.dataset = summarize(full.meta);
        result.groups = groups;
        sendJson(res, 200, result);
        return;
      }

      // ── 导出（备份/迁移，纯本地 JSON）──────────────────────────────────────
      if (pathname === '/export' && req.method === 'GET') {
        const meta = await store.find(search.get('datasetId') || '');
        if (!meta) throw new Error('找不到数据集');
        const full = await store.get(meta.id);
        if (!full) throw new Error('数据集内容缺失');
        const body = JSON.stringify({ exportedAt: new Date().toISOString(), meta: full.meta, rows: full.rows }, null, 2);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="token-usage-${meta.id}.json"`,
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      // ── 分组保存 ───────────────────────────────────────────────────────────
      if (pathname === '/groups' && req.method === 'POST') {
        const body = await readJsonBody(req, 1024 * 1024);
        const groups = await store.saveGroups(body.groups || body);
        sendJson(res, 200, { ok: true, groups });
        return;
      }

      // ── 重命名 / 删除 ──────────────────────────────────────────────────────
      if (pathname === '/rename' && req.method === 'POST') {
        const body = await readJsonBody(req, 64 * 1024);
        const meta = await store.getMeta(String(body.datasetId || ''));
        if (!meta) throw new Error('找不到数据集');
        const updated = await store.updateMeta(meta.id, { name: String(body.name || meta.name).slice(0, 80) });
        sendJson(res, 200, { ok: true, dataset: summarize(updated) });
        return;
      }

      if (pathname === '/delete' && req.method === 'POST') {
        const body = await readJsonBody(req, 64 * 1024);
        const ok = await store.remove(String(body.datasetId || ''));
        if (!ok) throw new Error('找不到数据集');
        sendJson(res, 200, { ok: true });
        return;
      }

      // ── 健康检查（便于排查路由是否挂上）──────────────────────────────────
      if (pathname === '/' && req.method === 'GET') {
        sendJson(res, 200, { plugin: 'dsh-token-usage', ok: true, dataDir: store.root });
        return;
      }

      sendJson(res, 404, { error: `未知接口：${pathname}` });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logger.warn?.(`[token-usage] ${pathname} 失败: ${message}`);
      sendJson(res, 400, { error: message });
    }
  };
}

function defaultDatasetName(fileName) {
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const base = basename(String(fileName || '导入')).replace(/\.[^.]+$/, '');
  return `${base || '导入'} · ${stamp}`;
}

/**
 * 注册路由；返回 disposer（无 webServer 时返回空函数）。
 */
export function registerRoutes(ctx, { store, logger }) {
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    logger?.warn?.('[token-usage] 当前环境没有 webServer 服务，可视化面板不可用（工具仍可用）');
    return () => {};
  }
  const registered = webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: createHandler({ ctx, store, logger }),
  });
  if (typeof registered === 'function') return registered;
  if (registered && typeof registered.then === 'function') {
    return () => { Promise.resolve(registered).then((fn) => typeof fn === 'function' && fn()).catch(() => {}); };
  }
  return () => {};
}

/** 供工具调用：直接分析一个本地文件，不落库。 */
export async function analyzeFile(filePath, options = {}) {
  const buffer = await readFile(filePath);
  const rows = ingestFiles([{ name: basename(filePath), buffer }]);
  return analyze(rows, options);
}
