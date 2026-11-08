/**
 * 数据集存储（本地磁盘，零数据库）。
 *
 * 目录布局（默认在 $DSH_HOME/token-usage 下，可用 config.dataDir 覆盖）：
 *   datasets/<id>/meta.json   数据集元信息（文件清单、统计、告警）
 *   datasets/<id>/rows.json   解析后的归一化记录（analyze 的输入）
 *   datasets/<id>/files/*     原始上传文件（保留 ZIP/CSV，便于随时重解析）
 *   groups.json               自定义分组映射 { keys: {...}, models: {...} }
 *
 * 为什么不直接常驻内存：DSH 会重启，用户希望历史账单“打开就在”；
 * 数据始终只在本机磁盘，不经过任何网络。
 */
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ingestFiles } from './ingest.js';

const DATASETS_DIR = 'datasets';

function nowIso() {
  return new Date().toISOString();
}

function genId() {
  return `ds_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 文件名净化：去掉目录成分与危险字符，保留中文。 */
export function safeName(name) {
  const base = basename(String(name || 'file'))
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return base || 'file';
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value), 'utf8');
}

export function createStore(dataDir) {
  const root = join(dataDir, DATASETS_DIR);
  /** 每个数据集一把锁：串行化“写文件 + 重新解析”，避免并发导入互相覆盖。 */
  const locks = new Map();

  async function withLock(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(id, run.catch(() => {}));
    return run;
  }

  async function readMeta(id) {
    return readJson(join(root, id, 'meta.json'));
  }

  const store = {
    root,

    async ensure() {
      await mkdir(root, { recursive: true });
    },

    /** 列出所有数据集（按更新时间倒序）。 */
    async list() {
      await store.ensure();
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const metas = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const meta = await readMeta(entry.name);
        if (meta) metas.push(meta);
      }
      metas.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      return metas;
    },

    async getMeta(id) {
      if (!id) return null;
      return readMeta(safeName(id));
    },

    /** 读数据集全量数据（meta + rows）。 */
    async get(id) {
      const meta = await store.getMeta(id);
      if (!meta) return null;
      const rows = await readJson(join(root, meta.id, 'rows.json'));
      if (!rows) return null;
      return { meta, rows };
    },

    async create(name) {
      await store.ensure();
      const id = genId();
      const meta = {
        id,
        name: String(name || '未命名数据集').slice(0, 80),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        currency: 'CNY',
        files: [],
        stats: { rowCount: 0, models: [], keys: [], from: '', to: '', totals: null },
        warnings: [],
      };
      await mkdir(join(root, id, 'files'), { recursive: true });
      await writeJson(join(root, id, 'meta.json'), meta);
      return meta;
    },

    async remove(id) {
      const meta = await store.getMeta(id);
      if (!meta) return false;
      await rm(join(root, meta.id), { recursive: true, force: true });
      return true;
    },

    /**
     * 追加原始文件并重新解析整个数据集。
     * @param {{name:string, buffer:Buffer}[]} files
     */
    async addFiles(id, files) {
      const meta = await store.getMeta(id);
      if (!meta) throw new Error('数据集不存在');
      if (!files || !files.length) throw new Error('没有收到文件');
      return withLock(meta.id, async () => {
        const dir = join(root, meta.id, 'files');
        await mkdir(dir, { recursive: true });
        const saved = [];
        for (const file of files) {
          const name = safeName(file.name);
          // 同名文件视为“重新上传同一份导出”，直接覆盖，避免重复计数
          const target = join(dir, name);
          if (await exists(target)) await unlink(target).catch(() => {});
          await writeFile(target, file.buffer);
          saved.push({ name, size: file.buffer.length });
        }
        return store.reingest(meta.id, saved);
      });
    },

    /** 重新读取 files/ 下所有原始文件并重建 rows.json。 */
    async reingest(id, lastSaved = []) {
      const meta = await store.getMeta(id);
      if (!meta) throw new Error('数据集不存在');
      const dir = join(root, meta.id, 'files');
      const names = (await readdir(dir).catch(() => [])).filter((n) => !n.startsWith('.'));
      if (!names.length) throw new Error('数据集里还没有文件');

      const files = [];
      const fileMeta = [];
      for (const name of names) {
        const buffer = await readFile(join(dir, name));
        files.push({ name, buffer });
        fileMeta.push({ name, size: buffer.length });
      }

      const rows = ingestFiles(files);
      await writeJson(join(root, meta.id, 'rows.json'), rows);

      const updated = {
        ...meta,
        updatedAt: nowIso(),
        currency: rows.currency,
        files: fileMeta,
        stats: rows.stats,
        warnings: rows.warnings || [],
        lastAdded: lastSaved.map((f) => f.name),
        sourceKinds: [...new Set((rows.files || []).map((f) => f.adapter).filter(Boolean))],
      };
      await writeJson(join(root, meta.id, 'meta.json'), updated);
      return { meta: updated, rows };
    },

    /** 局部更新元信息（重命名等）。 */
    async updateMeta(id, patch) {
      const meta = await store.getMeta(id);
      if (!meta) throw new Error('数据集不存在');
      const updated = { ...meta, ...patch, updatedAt: nowIso() };
      await writeJson(join(root, meta.id, 'meta.json'), updated);
      return updated;
    },

    async groups() {
      const raw = await readJson(join(dataDir, 'groups.json'), null);
      return {
        keys: raw && typeof raw.keys === 'object' && raw.keys ? raw.keys : {},
        models: raw && typeof raw.models === 'object' && raw.models ? raw.models : {},
      };
    },

    async saveGroups(groups) {
      await store.ensure();
      const value = {
        keys: groups && typeof groups.keys === 'object' ? groups.keys : {},
        models: groups && typeof groups.models === 'object' ? groups.models : {},
        updatedAt: nowIso(),
      };
      await writeJson(join(dataDir, 'groups.json'), value);
      return value;
    },

    /** 最近一次更新的数据集（工具默认目标）。 */
    async latest() {
      const list = await store.list();
      return list[0] || null;
    },

    /** 按 id 或名称查找。 */
    async find(key) {
      if (!key) return store.latest();
      const direct = await store.getMeta(key);
      if (direct) return direct;
      const list = await store.list();
      return list.find((m) => m.name === key) || list.find((m) => m.name.includes(key)) || null;
    },
  };

  return store;
}
