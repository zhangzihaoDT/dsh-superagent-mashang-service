# dsh-order-config-ratio

通用「订单配置占比查询」Host 插件。模型一次调用即可完成：

1. **解析**：按 `shared/schema/business_definition.json` 解析车型/代际，按
   `shared/schema/metrics.json` 解析指标，按 `shared/schema/config_semantics.json`
   与 `config_attribute` 解析配置维度。
2. **快照**：向数据准备插件（`dataPreparation` 服务）声明
   `order_data`、`config_attribute` 与车型/指标口径，由它复用或创建只读快照；
   数据准备插件不可用时回退到当前工单的 `analysisSnapshot`。可选 `refresh=true`
   先执行 `data_refresh_daily` + `data_refresh_config_attribute`，再用
   `jobs.snapshot` 绑定新快照。返回每张表的文件更新时间、业务截止时间、行数与新鲜度。
3. **一次关联**：`order_data ⋈ config_attribute`，按 `order_number` 去重，
   配置行按订单归并，完成聚合与覆盖率/重复/冲突/分母闭合检查。
4. **交付**：占比、分母、已知分母、缺失数、过滤规则、快照与定义来源、
   质量检查与告警。

## 接口

```json
{
  "vehicle": "LS8 NEO",
  "metric": "locked_orders",
  "dimension": "seat_count",
  "refresh": false
}
```

可选参数：`start_date`、`end_date`、`time_window`、`order_type`、
`exclude_test_orders`、`city`、`snapshot_dir`。

`dimension` 支持：

- `seat_count` / `座位数` / `座椅` / `五六座`
- `power_type` / `动力类型`
- `product_version` / `版本`
- `order_type` / `订单类型`
- 配置属性名：`内饰`、`外饰`、`轮毂`、`方向盘`、`已选`、`激光雷达`、
  `21.5英寸二排观影屏`、`智控地暖系统` 等

## 输出

工具返回结构化 JSON（canonical output），模型看到的是
`result.markdown` 摘要。关键字段：

- `result.denominator` / `known_denominator` / `missing` / `coverage`
- `result.groups[]`：`value`、`count`、`share`（已知占比）、`share_of_total`
- `result.order_type_breakdown`
- `filters.rules[]`
- `data.snapshot` + `data.datasets`（各表更新时间/业务截止/行数/新鲜度）
- `data_prep`：本次使用的数据准备快照（`snapshot_id`、`directory`、`reused`、
  `coverage`、`freshness`）；数据准备未参与时是 `error` 说明
- `quality.checks[]`、`quality.duplicates`、`quality.conflicts`
- `warnings[]`、`refresh`

## 与数据准备插件协作

`apply` 时通过 `ctx.inject(['dataPreparation'], …)` 声明需求；每次查询前调用
`dataPreparation.ensure('order_config_ratio', { definitionRoot, cwd })`，把返回的
`snapshot.directory` 作为 `snapshot_dir` 交给 `query.py`。`refresh=true` 或显式
`snapshot_dir` 时跳过数据准备，保留原有的受控刷新与显式快照行为。
插件缺失或准备失败时只记录 `data_prep.error` 并回退，不会阻断查询。

## 示例

```bash
node -e "import('./index.js')"   # 语法检查
python3 query.py --request '{"vehicle":"LS8 NEO","metric":"locked_orders","dimension":"seat_count"}'
```

当前工单示例结果：LS8 NEO 锁单 2,599 单，五座 2,236（86.03%），
六座 363（13.97%），缺失 0，覆盖 100%。数据来自 analysisSnapshot
`65971e5c-b143-480d-bd1e-a696d6537abd`；order_data 截至 2026-11-15
23:20（lock_time），config_attribute 更新于 2026-11-16 17:06；两表由同一快照绑定，
各自更新时间在 `data.datasets` 中分别返回。
