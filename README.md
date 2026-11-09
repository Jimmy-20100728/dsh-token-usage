# dsh-token-usage

> DeepSeek Harness 插件：把 Token 账单变成能看的图 —— 本地解析、本地统计、不上传。

导入 **DeepSeek 官方导出 ZIP**（`amount-*.csv` + `cost-*.csv`）、**通用 CSV** 或 **通用 JSON**，
在会话界面新增的「Token 用量」标签页里查看费用趋势、模型 / API Key / 自定义分组对比、
缓存命中与节省、输入输出构成、异常用量检测；也可以在对话里直接让 Agent 调用 `token_analysis` 工具。

---

## 1. 它解决什么

官方控制台只给「当月花了多少」，看不出：

- 哪个 **API Key / 项目** 在烧钱（账单本身不按 Key 拆分，本插件按 token 与单价权重把月账单分摊到 Key）
- **缓存命中率** 是多少、命中到底省了多少钱
- 输入 / 输出 **Token 构成**，到底贵在输入还是输出
- 哪天突然 **用量突增**（中位数 + MAD 判定，比均值抗离群）

同一个 `analyze()` 同时供 UI 与对话工具使用，两边数字保证一致。

## 2. 安装

插件是纯 JavaScript（ESM），**无需构建、无第三方依赖**，只需要 Node 自带的 `zlib`。

```bash
# 方式 A：在本机 DSH 里用插件管理器安装包目录
#   plugin_manager install_bundle  target = <本仓库绝对路径>
# 方式 B：打包成 tgz / 目录后放进 profile 的 node_modules 再启用
npm pack            # 生成 dsh-token-usage-1.1.0.tgz
```

安装后插件清单为：

```
package.json            # dsh.bundle.patch → ./cordis.patch.yml；dsh.client 声明 Web 客户端
cordis.patch.yml        # 真正被读取的 bundle patch（- insert: dsh-token-usage）
patches/bundle.yaml     # 同一内容的镜像，便于阅读/兼容
icon.svg
lib/
  index.js              # apply(ctx)：注册 HTTP 路由 + token_analysis 工具
  routes.js             # /api/token-usage/* 路由（鉴权 + 参数校验）
  client.js             # Web 客户端：注册 conversation.view 标签页
  core/
    ingest.js           # 摄入管线：字节 → 展开 → 适配器 → 归一化 rows
    analyze.js          # 纯函数分析：趋势 / 维度 / 缓存 / 异常
    store.js            # 本地数据集仓库（datasets/<id>/{meta,rows,files}）
    csv.js              # RFC4180 风格 CSV 解析（引号 / 换行 / CRLF）
    zip.js              # 极简 ZIP 读取（store/deflate，无依赖）
    prices.js           # 内置价目表 + 币种换算（仅在缺账单时兜底）
    record.js           # 归一化记录结构
    adapters/           # 适配器层：deepseek-amount / deepseek-cost / generic-csv / generic-json
test/
  run.mjs               # core 层自测（含 ZIP）
  routes.mjs            # 路由层自测（假 req/res）
```

数据目录：`$DSH_HOME/token-usage`（默认 `~/.dsh/token-usage`），可用插件配置 `dataDir` 覆盖。

```
token-usage/
  datasets/ds_xxx/meta.json    # 数据集元信息：文件清单、统计、告警
  datasets/ds_xxx/rows.json    # 归一化后可直接分析的记录
  datasets/ds_xxx/files/*      # 原始上传文件（随时可重解析）
  groups.json                  # 自定义分组：{ keys: {Key → 分组}, models: {...} }
```

## 3. 使用

### 3.1 界面

会话顶部的视图标签里多出「**Token 用量**」：

1. 把 DeepSeek 导出的 ZIP（或 CSV / JSON）拖进页面，或点「导入文件」；
2. 同一数据集可**多次追加**（先拖 `amount-*.csv`，再拖 `cost-*.csv`，也可以两个一起放进 ZIP）；
3. 顶部切换 **按日 / 按周 / 按月**、**Token / 费用**、**模型 / API Key / 分组**；
4. 底部「自定义分组」给每个 Key 起业务名（如「项目甲」），保存后排行与趋势按组聚合。

仪表盘布局（1.1.0 起）：

- **KPI 条**：总 Token、总费用、缓存命中率、缓存节省、请求数、日均 Token；
- **趋势区**：堆叠柱状 / 折线两种形态，鼠标在图上移动有十字准线与数值浮层；
- **三栏分析区**：模型排行（Top 6，悬停高亮）、Token 构成（环形 / 饼图 / 条形）、统计参数
  （峰值区间、峰值用量、中位数、每请求 Token、千 Token 单价、节省占比、预估费用占比）；
- **异常与结论**：用量突增检测（中位数 + MAD）与中文解读并排；
- 卡片悬停轻微上浮聚焦，入场淡入，遵循 `prefers-reduced-motion`。

### 3.2 对话工具

```jsonc
// 分析已导入的最新数据集
{ "name": "token_analysis", "arguments": { "bucket": "week", "group_by": "key", "top": 10 } }

// 直接分析本机文件（不落库）
{ "name": "token_analysis", "arguments": { "path": "D:/账单/export.zip", "bucket": "day" } }

// 分析并入库，之后可在界面里继续看
{ "name": "token_analysis", "arguments": { "path": "D:/账单/amount-2026-08.csv", "persist": true } }
```

工具返回结构化数据（总量、区间、维度排行、异常、结论、最近 90 个趋势点），
并渲染成一段中文 markdown，模型与用户都能直接读。

### 3.3 HTTP 接口（客户端使用，也可脚本调用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/token-usage/state` | 数据集列表 + 分组 + 数据目录 |
| POST | `/api/token-usage/import` | 请求体是原始字节，文件名放 `x-file-name`（URL 编码），`x-dataset-id` 追加到已有数据集 |
| POST | `/api/token-usage/import-path` | `{ path, datasetId?, name? }`，服务器本地路径导入 |
| GET | `/api/token-usage/analysis?datasetId=&bucket=&from=&to=&top=` | 完整分析结果 |
| GET | `/api/token-usage/export?datasetId=` | 导出数据集 JSON（备份/迁移） |
| POST | `/api/token-usage/groups` | `{ groups: { keys, models } }` |
| POST | `/api/token-usage/rename` | `{ datasetId, name }` |
| POST | `/api/token-usage/delete` | `{ datasetId }` |

所有路由都过 Host 的连接鉴权（`connection.requestRejection`），与 DSH 自身 `/api` 同一栅栏；
没有该能力的环境退回「仅信任 loopback」。

## 4. 数据来源与费用口径

**DeepSeek 官方导出**

```
amount-2026-08.csv  →  user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount
                        type ∈ request_count | output_tokens | input_cache_hit_tokens |
                               input_cache_miss_tokens | (新版) function_call
cost-2026-08.csv    →  user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency
```

- 账单日直接取 `start_time_iso` 前 10 个字符（北京时间零点），**不做 UTC 换算**，否则会整天错位；
- 旧版导出首列是 `utc_date`，文件名是 `amount-2026-8.csv`，同样支持；
- `cost` 出现负号（退款/冲正）取绝对值统计。

**费用优先级**（`analyze.js` 注释里有完整说明）：

1. `billed` —— `cost-*.csv` 的权威账单，按 token / 单价权重分摊到各 Key；
2. `reported` —— 通用 CSV/JSON 自带的 `cost` 列；
3. `price` —— 官方 amount CSV 的 `price × amount`；
4. `estimated` —— 以上都没有时用内置价目表估算（界面会标注「估算」）。

缺 `cost-*.csv` 的月份会在数据提示里明确写出「费用为按单价推算」，不会假装精确。

**通用 CSV / JSON**：靠别名表识别表头（`date/日期`、`model/模型`、`api_key_name/key`、
`input_tokens`、`output_tokens`、`cost/费用`…），JSON 支持数组、`{data|records|rows|items|usage|list}`、
以及以日期为键的对象。只有总 token 没有缓存明细时，按「全部为未命中输入」估算并标注。

## 5. 扩展一个新数据源

只需在 `lib/core/adapters/` 新增一个对象并在 `adapters/index.js` 的 `ADAPTERS` 里登记（放在通用适配器之前）：

```js
export const myAdapter = {
  id: 'my-format',
  label: '某平台账单',
  match(headers) { return headers.includes('my_token_col'); },  // 仅 CSV 调用
  parse(text, meta) {
    return { records: [...], billed: [...], currency: 'CNY', warnings: [] };
  },
};
```

`records` 用 `newRecord(date, model, key)` 构造，`billed` 是 `{ date, model, cost, currency }`。
其余逻辑（分摊、聚合、图表、工具）完全复用。

## 6. 隐私

- 文件解析、统计、落盘全部在本机进程内完成；
- 浏览器只与本机 DSH 的 `/api/token-usage/*` 通信，**不向任何外部服务发送数据**；
- 不写遥测、不引 CDN、图表是自己画的 SVG（没有 ECharts / 没有远程字体）。

## 7. 自测

```bash
node test/run.mjs      # core：CSV/ZIP/适配器/分析/仓库
node test/routes.mjs   # 路由：导入 → 分析 → 分组 → 导出 → 删除
```

`test/run.mjs` 会在 `test/.tmp/fixtures/` 生成一份 10 天 × 2 模型 × 2 Key 的合成账单
（含 8/7 人为突增），若同目录下有 `export.zip` 则额外验证 ZIP 路径：

```powershell
Compress-Archive -Path "test\.tmp\fixtures\*" -DestinationPath "test\.tmp\export.zip" -Force
node test/run.mjs
```

## 8. 已知边界

- ZIP 只支持 store / deflate，ZIP64 会明确报错（官方导出远小于 4GB，够用）；
- 账单只精确到「日期 × 模型」，Key 级费用是权重分摊，不是账单真实拆分；
- 界面文案目前为中文，未做 i18n（`locale/` 可后续补）。

## 9. 更新日志

### 1.1.0

- **仪表盘改版**：KPI 六联卡 + 全宽趋势 + 三栏分析区（排行 / 构成 / 统计参数）+ 异常与结论并排，
  一屏可读，不再被底部输入框遮挡；
- **图表形态**：趋势支持堆叠柱状与折线；Token 构成支持环形 / 饼图 / 条形；
- **悬停聚焦**：卡片轻微上浮放大与光晕，趋势图内十字准线 + 数值浮层，排行条悬停高亮；
- **专业参数**：峰值区间、峰值用量、中位数、每请求 Token、千 Token 单价、节省占比、预估费用占比；
- **细节**：坐标轴日期字号收窄、入场淡入动效、遵循 `prefers-reduced-motion`；
- 折线更细（1.15px），端点更小，十字准线改用 `strokeLinecap: round` 避免断点毛刺。

### 1.0.0

- 首发：ZIP / CSV / JSON 导入、适配器层、费用四级口径、日周月趋势、模型 / Key / 分组对比、
  缓存命中与节省、输入输出构成、突增检测、`token_analysis` 工具、HTTP API、数据集与分组持久化。

