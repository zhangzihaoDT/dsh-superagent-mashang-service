# dsh-data-prep

数据准备插件。它把「项目里有哪些数据集、数据有多新、口径定义是哪一份」集中到一处，
并据此为分析插件**复用或创建只读快照**。分析插件只声明需求，不再各自找数据、各自刷新。

```text
Agent 调用 order_config_ratio
  → 查询插件声明：order_data、config_attribute、business_definition、metrics、config_semantics
  → 数据准备插件复用或创建满足要求的只读快照
  → 查询插件在该快照上计算
  → 返回结果、口径、覆盖率与快照 ID
```

## 数据源配置

DSH profile 配置数据源、数据集 ID 和定义文件。通用项目可直接用 `config.datasets` 登记 CSV 和 Parquet；Mashang 部署选择 `registry: mashang`，从业务仓库的注册表发现数据集，`config.datasets` 可覆盖或补充。定义文件通过 `config.definitions` 显式登记，快照保存副本和哈希。

## 两种协作面

### 模型工具 `data_prepare`

| action | 行为 |
| --- | --- |
| `status` | 只读列出全部数据集、文件更新时间、新鲜度、口径定义、已声明需求与最近快照。`probe=true` 时额外读取业务截止时间（较慢）。 |
| `prepare` | 按 `profile`（如 `order_config_ratio`）或 `datasets` 复用/创建快照，返回快照 ID、目录、覆盖率、各表行数与截止时间、下一步分析调用。 |
| `verify` | 校验指定快照的文件、只读权限与哈希。 |

```json
{"action": "prepare", "profile": "order_config_ratio"}
{"action": "prepare", "datasets": ["order_data"], "max_age_hours": 6}
{"action": "verify", "snapshot_id": "8f2c…"}
```

`prepare` 成功时返回 `next`，例如
`{"tool": "order_config_ratio", "arguments": {"snapshot_dir": "<快照目录>"}}`；
模型把该目录传给分析插件，或者分析插件通过下面的服务自己取。

例如临时分析线索同比时，worker 调用 `data_prepare`，传入 `datasets: ["assign_data"]`，并读取工具返回的文件路径。模型工具和分析插件共用 `dataPreparation`。Superagent 在 worker 的工单生命周期内授权这些工具，生产刷新统一由 `business_job` 执行。

### Host 服务 `dataPreparation`

分析插件在 `apply` 中声明需求，并在每次分析前取快照：

```js
export const inject = ['tools']

export function apply(ctx) {
  const data = ctx.get('dataPreparation')
  if (data) {
    ctx.effect(() => data.declare('order_config_ratio', {
      datasets: ['order_data', 'config_attribute'],
      definitions: ['business_definition', 'metrics', 'config_semantics'],
      consumer: 'order_config_ratio',
    }))
  }

  ctx.tools.register(defineTool({
    // …
    async execute(args, exec) {
      const prepared = await data.ensure('order_config_ratio')
      if (prepared.status === 'incomplete') throw new Error(prepared.warnings.join('；'))
      // prepared.snapshot.directory、prepared.snapshot_id、prepared.coverage、
      // prepared.freshness、prepared.refresh_plan
      return await compute(prepared.snapshot.directory, args, exec)
    },
  }))
}
```

服务方法：

- `catalog({ probe?, snapshots?, definitionRoot? })`：与 `status` 相同。
- `ensure(requirements, options?)`：`requirements` 可以是 profile 名或
  `{ datasets, definitions, maxAgeHours }`；`options` 支持 `snapshotId`、`definitionRoot`、`cwd`。
  数据缺失返回 `status: 'incomplete'`；运行错误抛异常。
- `verify(snapshotId)`：校验快照。
- `list(limit)`：最近快照。
- `declare(name, requirements)`：声明需求，返回注销函数；`requirements()` 返回合并后的全部需求。

## 复用规则

候选快照按创建时间从新到旧检查，必须覆盖全部所需数据集（和已记录的口径定义），
并通过文件存在、只读权限、大小与 SHA-256 校验。满足以下条件时复用：

1. 源数据集自从快照后没有变化（文件大小与 mtime 一致），并且
2. 当前口径定义与快照记录一致。

因此：数据没变就不重复复制；数据变了就复制新版；刷新任务绑定的
`analysisSnapshot`（`state/business-jobs/*.json`）也会被复用为
`mode: "link"` 的快照，避免重复拷贝。数据缺失时返回 `incomplete`，不会伪造快照。

## 快照格式

`<stateDir>/data-prep/snapshots/<uuid>/`

```json
{
  "manifest_version": 1,
  "version": "<uuid>",
  "id": "<uuid>",
  "created_at": "2026-11-17T…",
  "origin": "data_prep",
  "mode": "copy",
  "directory": "…",
  "business_root": "…",
  "definition_root": "…",
  "requirements": { "profile": "order_config_ratio", "datasets": ["…"], "definitions": ["…"], "max_age_hours": 24 },
  "datasets": {
    "order_data": {
      "path": "…/order_data.parquet", "rows": 551347, "size_bytes": 40070930,
      "data_asof": "2026-11-16T22:15:00", "data_asof_column": "lock_time",
      "sha256": "…", "read_only": true, "fresh": true, "max_age_hours": 24
    }
  },
  "definitions": { "metrics": { "path": "…/definitions/shared/schema/metrics.json", "sha256": "…" } },
  "coverage": { "complete": true, "percent": 100 },
  "warnings": []
}
```

`version` / `datasets[id].path` / `rows` / `size_bytes` / `file_mtime` /
`data_asof` / `data_asof_column` 与既有 `jobs.snapshot` 清单一致，因此
`order-config-ratio` 的 `query.py` 可以直接把快照目录当作 `snapshot_dir` 读取。

## 生产刷新边界

本插件**不执行生产数据刷新**。它只读业务仓库的数据与口径文件，创建只读副本。
过期时 `prepare`/`ensure` 返回 `refresh_plan`，其中列出覆盖这些数据集的已登记 Job
和可直接使用的 `business_job operation=refresh_snapshot` 计划；生产写入仍由
已授权的人类请求经 `business_job` 执行（见 `docs/013-business-jobs.md`）。
刷新成功后再调用一次 `prepare`，会优先复用刷新任务绑定的只读快照。

默认 `registeredJobs` 是已登记到 `business_job` 的三个 Job：
`data-refresh-daily`、`data-refresh-config-attribute`、`data-refresh-lock-attribution`。
其他数据集（试驾、交付库存、门店数据）会出现在 `uncovered_datasets`，按业务仓库的
`make allupdate` 或各自入口更新。

## 配置

```yaml
- id: data-prep
  config:
    businessRoot: /path/to/mashang-service   # 数据源根目录
    registry: mashang                        # 可选适配器；通用项目可直接配置 datasets
    stateDir: /path/to/state/superagent      # 默认 $DSH_HOME/state/$DSH_PROFILE
    python: /path/to/.venv/bin/python        # 默认业务仓库 .venv/bin/python，否则 python3
    maxAgeHours: 24
    freshness:                               # 逐数据集新鲜度阈值（小时）；覆盖 maxAgeHours
      test_drive_data: 168
      lock_attribution: 168
      delivery_inventory: 168
      store_info: 168
      store_daily_leads: 168
    reuseAnalysisSnapshots: true             # 复用 business-jobs 的 analysisSnapshot
    registeredJobs: [data-refresh-daily, data-refresh-config-attribute, data-refresh-lock-attribution]
    datasets: []                             # 覆盖/补充 registry（{id, path, label, required, date_columns, max_age_hours}）
    definitions:
      - {id: business_definition, path: shared/schema/business_definition.json}
      - {id: metrics, path: shared/schema/metrics.json}
      - {id: config_semantics, path: shared/schema/config_semantics.json}
    requirements:                            # 预置需求 profile；分析插件也可以运行时 declare
      order_config_ratio:
        datasets: [order_data, config_attribute]
        definitions: [business_definition, metrics, config_semantics]
        consumer: order_config_ratio
```

## 安装

从本目录安装 bundle（profile 级，所有 Session 生效）：

```text
plugin_manager action=install_bundle target=<此目录的绝对路径>
```

## 自检

`node dev/verify.mjs [--state <dir>]` 在最小 Context 上挂载插件，依次执行
`status → declare → prepare → 复用 → verify → ensure → query.py 读取快照 → 固定快照`，
并断言只读权限、哈希、覆盖率与 `query.py` 报出的快照 ID。它默认写入临时状态目录；
传 `--state $DSH_HOME/state/$DSH_PROFILE` 可在真实状态目录上验证复用路径。

`node dev/verify-query.mjs [--state <dir>]` 同时挂载本插件与
`dsh-order-config-ratio`，运行真实查询，断言查询插件已 `declare` 需求、拿到同一个
快照 ID，并在第二次查询时复用该快照。
