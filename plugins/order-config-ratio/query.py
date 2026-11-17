#!/usr/bin/env python3
"""Order configuration share query backend.

The model-facing plugin passes one JSON request on the command line.  This
module resolves the vehicle / metric / dimension from the repository's
authoritative definitions, binds a read-only data snapshot, joins
``order_data`` with ``config_attribute``, deduplicates at order level,
aggregates the share, and returns denominator, missing count, quality checks,
filter rules and provenance in one JSON document.

It is deliberately self-contained: the DSH plugin can point it at any
mashang-service checkout (or a superagent analysis snapshot) without changing
that checkout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import pyarrow.dataset as ds
import pyarrow.parquet as pq

TZ = ZoneInfo("Asia/Shanghai")
MAX_AGE_HOURS_DEFAULT = 24.0
UNKNOWN_SEAT = "未标座位"
UNKNOWN_POWER = "未知"
UNCLASSIFIED_VERSION = "未分类"


class QueryError(Exception):
    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise QueryError("MISSING_FILE", f"缺少定义文件：{path}") from exc
    except json.JSONDecodeError as exc:
        raise QueryError("INVALID_JSON", f"定义文件不是合法 JSON：{path}") from exc


def norm_text(value: Any) -> str:
    text = "" if value is None else str(value)
    return re.sub(r"[\s\-_/（）()]+", "", text).lower()


def display_ts(value: Any) -> str | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    try:
        stamp = pd.Timestamp(value)
    except Exception:
        return None
    if pd.isna(stamp):
        return None
    if stamp.tzinfo is not None:
        stamp = stamp.tz_convert(TZ).tz_localize(None)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S")


def parse_ts(value: Any) -> pd.Timestamp | None:
    if value is None or value == "":
        return None
    try:
        stamp = pd.Timestamp(value)
    except Exception:
        return None
    if pd.isna(stamp):
        return None
    if stamp.tzinfo is not None:
        stamp = stamp.tz_convert(TZ).tz_localize(None)
    return stamp


def now_local() -> pd.Timestamp:
    return pd.Timestamp.now(tz=TZ).tz_localize(None)


def fmt_int(value: Any) -> str:
    try:
        return f"{int(value):,}"
    except Exception:
        return str(value)


def pct(value: Any) -> str:
    try:
        return f"{float(value) * 100:.2f}%"
    except Exception:
        return "0.00%"


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def is_inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except Exception:
        return False


def find_json_object(text: str) -> dict | None:
    """Return the last top-level JSON object printed by a subprocess."""
    text = (text or "").strip()
    if not text:
        return None
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else None
    except Exception:
        pass
    starts = [index for index, char in enumerate(text) if char == "{"]
    for start in reversed(starts):
        decoder = json.JSONDecoder()
        try:
            value, _ = decoder.raw_decode(text[start:])
            if isinstance(value, dict):
                return value
        except Exception:
            continue
    return None


# ---------------------------------------------------------------------------
# Snapshot discovery and metadata
# ---------------------------------------------------------------------------


def parquet_rows(path: Path) -> int | None:
    try:
        return int(pq.ParquetFile(path).metadata.num_rows)
    except Exception:
        return None


def file_meta(path: Path) -> dict:
    stat = path.stat()
    mtime = pd.Timestamp(stat.st_mtime, unit="s", tz=TZ).tz_localize(None)
    return {
        "path": str(path.resolve()),
        "size_bytes": int(stat.st_size),
        "file_mtime": display_ts(mtime),
        "rows": parquet_rows(path),
        "read_only": (stat.st_mode & 0o222) == 0,
    }


def dataset_info(dataset_id: str, path: Path, supplied: dict | None = None) -> dict:
    supplied = supplied or {}
    info = file_meta(path)
    info["id"] = dataset_id
    info["rows"] = supplied.get("rows", info["rows"])
    info["size_bytes"] = supplied.get("size_bytes", info["size_bytes"])
    info["file_mtime"] = display_ts(supplied.get("file_mtime")) or info["file_mtime"]
    info["data_asof"] = display_ts(supplied.get("data_asof"))
    info["data_asof_column"] = supplied.get("data_asof_column")
    if dataset_id == "config_attribute":
        info["date_note"] = "配置表无业务日期列，以文件更新时间判断新鲜度"
    return info


def load_snapshot_dir(directory: Path, mode: str, source: dict | None = None) -> dict:
    directory = directory.resolve()
    manifest_path = directory / "snapshot.json"
    manifest = load_json(manifest_path) if manifest_path.exists() else (source or {})
    datasets = manifest.get("datasets") or {}
    available: dict[str, dict] = {}
    for dataset_id, filename in (
        ("order_data", "order_data.parquet"),
        ("config_attribute", "config_attribute.parquet"),
    ):
        supplied = datasets.get(dataset_id) or {}
        path = Path(supplied.get("path") or directory / filename)
        if not path.is_absolute():
            path = directory / path
        if path.exists() and path.is_file():
            available[dataset_id] = dataset_info(dataset_id, path, supplied)
    if "order_data" not in available:
        raise QueryError("SNAPSHOT_MISSING", f"快照目录中没有可读的 order_data.parquet：{directory}")
    return {
        "mode": mode,
        "version": manifest.get("version") or (source or {}).get("version"),
        "directory": str(directory),
        "manifest": str(manifest_path) if manifest_path.exists() else None,
        "ticket_id": (source or {}).get("ticket_id"),
        "selected_because": (source or {}).get("selected_because") or "显式指定的快照目录",
        "datasets": available,
        "definitions": manifest.get("definitions") or {},
    }


def discover_snapshot(
    cwd: Path,
    state_dir: Path | None,
    explicit_dir: Path | None,
) -> dict:
    if explicit_dir is not None:
        return load_snapshot_dir(explicit_dir, "explicit_snapshot")

    # superagent: prepare record -> ticket id -> business job record -> analysisSnapshot
    if state_dir is not None and state_dir.exists():
        prepare_dir = state_dir / "prepare"
        matches: list[tuple[Path, dict]] = []
        if prepare_dir.exists():
            for path in prepare_dir.glob("*.json"):
                try:
                    record = load_json(path)
                except Exception:
                    continue
                ticket = record.get("ticket") or {}
                ticket_dir = ticket.get("directory")
                if not ticket_dir:
                    continue
                ticket_path = Path(ticket_dir)
                try:
                    cwd_resolved = cwd.resolve()
                    ticket_resolved = ticket_path.resolve()
                except Exception:
                    continue
                if cwd_resolved == ticket_resolved or is_inside(cwd_resolved, ticket_resolved):
                    matches.append((ticket_resolved, ticket))
        if matches:
            matches.sort(key=lambda item: len(str(item[0])), reverse=True)
            ticket = matches[0][1]
            ticket_id = str(ticket.get("id") or "")
            if ticket_id:
                record_path = state_dir / "business-jobs" / f"{sha256_text(ticket_id)[:24]}.json"
                if record_path.exists():
                    try:
                        record = load_json(record_path)
                    except Exception:
                        record = {}
                    snapshot = record.get("analysisSnapshot") or {}
                    directory = snapshot.get("directory")
                    if directory and Path(directory).is_dir():
                        return load_snapshot_dir(
                            Path(directory),
                            "analysis_snapshot",
                            {
                                **snapshot,
                                "ticket_id": ticket_id,
                                "selected_because": (
                                    "当前工单最新 analysisSnapshot；两表由该快照绑定，"
                                    "各自更新时间见 datasets"
                                ),
                            },
                        )

    # Prepared worktree: the ticket's own read-only dataset copy.
    if (cwd / "dataset" / "order_data.parquet").exists():
        info = dataset_info("order_data", cwd / "dataset" / "order_data.parquet")
        datasets = {"order_data": info}
        config_path = cwd / "dataset" / "config_attribute.parquet"
        if config_path.exists():
            datasets["config_attribute"] = dataset_info("config_attribute", config_path)
        return {
            "mode": "prepared_worktree",
            "version": None,
            "directory": str(cwd),
            "manifest": None,
            "ticket_id": None,
            "selected_because": "未发现 analysisSnapshot，使用当前工单准备阶段绑定的只读 dataset 副本",
            "datasets": datasets,
        }
    return {}


def live_snapshot(root: Path, reason: str) -> dict:
    order_path = root / "dataset" / "order_data.parquet"
    if not order_path.exists():
        raise QueryError("DATA_MISSING", f"找不到 order_data.parquet：{order_path}")
    datasets = {"order_data": dataset_info("order_data", order_path)}
    config_path = root / "dataset" / "config_attribute.parquet"
    if config_path.exists():
        datasets["config_attribute"] = dataset_info("config_attribute", config_path)
    return {
        "mode": "live_dataset",
        "version": None,
        "directory": str((root / "dataset").resolve()),
        "manifest": None,
        "ticket_id": None,
        "selected_because": reason,
        "datasets": datasets,
    }


# ---------------------------------------------------------------------------
# Vehicle / metric / dimension resolution
# ---------------------------------------------------------------------------


def resolve_vehicle(vehicle: str, bdef: dict) -> dict:
    if not vehicle or not str(vehicle).strip():
        raise QueryError("MISSING_VEHICLE", "vehicle 不能为空，例如 'LS8 NEO'、'LS8'、'CM3'")

    generation_rules = bdef.get("series_group_logic") or {}
    generation_keys = [key for key in generation_rules if key != "其他"]
    family_map = bdef.get("model_series_mapping") or {}
    periods = bdef.get("time_periods") or {}

    raw = str(vehicle).strip()
    compact = norm_text(raw)
    compact = compact.removeprefix("智己")

    key_map: dict[str, str] = {}
    for key in generation_keys:
        key_map[norm_text(key)] = key
    # Friendly spellings that are not literal generation ids.
    key_map.update(
        {
            "ls8neo": "LS8Neo",
            "ls8ne": "LS8Neo",
            "neo": "LS8Neo",
            "ls8纯电": "LS8Neo",
            "ls8纯电版": "LS8Neo",
            "ls8neo纯电": "LS8Neo",
            "ls8neo纯电版": "LS8Neo",
            "ls9hyper": "LS9",
        }
    )

    # A bare generation id (LS8, CM3, ...) is a generation, not a family.
    # A bare family id is only a family when it is not also a generation id
    # (LS6/L6 have no generation id of their own; LS8 does).
    family_requested = any(token in raw for token in ("全系", "家族", "family"))
    family_key = None

    if compact in key_map and not family_requested:
        keys = [key_map[compact]]
        family = next(
            (name for name, groups in family_map.items() if keys[0] in groups),
            keys[0],
        )
    else:
        for family_name, groups in family_map.items():
            if compact == norm_text(family_name) or (
                family_requested and norm_text(family_name) in compact
            ):
                family_key = family_name
                break
        if family_key:
            keys = list(family_map[family_key])
            family = family_key
        elif compact in key_map:
            keys = [key_map[compact]]
            family = next(
                (name for name, groups in family_map.items() if keys[0] in groups),
                keys[0],
            )
        else:
            # "CM3 LS6", "LS8 NEO 93" etc.: longest generation token wins.
            hits = [
                (len(token), key)
                for token, key in key_map.items()
                if len(token) >= 2 and token in compact
            ]
            if not hits:
                raise QueryError(
                    "UNKNOWN_VEHICLE",
                    f"无法解析车型/代际 '{raw}'。",
                    available=sorted(set(generation_keys) | set(family_map)),
                )
            hits.sort(reverse=True)
            keys = [hits[0][1]]
            family = next(
                (name for name, groups in family_map.items() if keys[0] in groups),
                keys[0],
            )

    # De-duplicate.  Family order is authoritative for a family request;
    # generation order is only used for explicit multi-generation keys.
    order = {key: index for index, key in enumerate(generation_keys)}
    keys = list(dict.fromkeys(keys))
    if family_key is None:
        keys = sorted(keys, key=lambda key: order.get(key, 999))
    display = raw
    if len(keys) == 1:
        meta = periods.get(keys[0]) or {}
        launch = meta.get("end")
        presale = meta.get("start")
        basis = "上市日" if launch else ("预售起点（上市日未确认）" if presale else "数据内最早时间")
        display = f"{keys[0]}"
        if norm_text(raw) in {"ls8neo", "neo", "ls8ne", "ls8纯电", "ls8纯电版", "ls8neo纯电", "ls8neo纯电版"}:
            display = "LS8 NEO"
    else:
        starts = []
        launches = []
        for key in keys:
            meta = periods.get(key) or {}
            if meta.get("start"):
                starts.append(str(meta["start"]))
            if meta.get("end"):
                launches.append(str(meta["end"]))
        launch = min(launches) if launches else None
        presale = min(starts) if starts else None
        basis = "家族内最早上市日" if launch else ("家族内最早预售起点" if presale else "数据内最早时间")

    return {
        "input": raw,
        "generation_keys": keys,
        "family": family,
        "series_values": sorted({family, *keys}),
        "display": display,
        "launch": launch,
        "presale_start": presale,
        "time_basis": basis,
        "scope": "generation" if len(keys) == 1 else "family",
        "rule": (
            f"series_group_logic[{keys[0]}]"
            if len(keys) == 1
            else f"model_series_mapping[{family}] → {keys}"
        ),
    }


METRIC_EN_ALIASES = {
    "locked_orders": "锁单量",
    "locked": "锁单量",
    "locks": "锁单量",
    "lock_orders": "锁单量",
    "lock_count": "锁单量",
    "locked_order": "锁单量",
    "delivered_orders": "交付数",
    "delivery": "交付数",
    "deliveries": "交付数",
    "delivered": "交付数",
    "delivery_count": "交付数",
    "invoiced_orders": "开票数",
    "invoice": "开票数",
    "invoices": "开票数",
    "invoice_count": "开票数",
    "intention_orders": "小订数",
    "intentions": "小订数",
    "intention": "小订数",
    "deposit_orders": "大定数",
    "deposits": "大定数",
    "deposit": "大定数",
    "orders": "订单计数",
    "order_count": "订单计数",
}


def resolve_metric(metric: str, metrics: dict) -> dict:
    if not metric or not str(metric).strip():
        raise QueryError("MISSING_METRIC", "metric 不能为空，例如 'locked_orders' 或 '锁单量'")
    raw = str(metric).strip()
    compact = re.sub(r"[\s\-]+", "_", raw.lower())

    aliases: dict[str, str] = {}
    for name, spec in metrics.items():
        aliases[norm_text(name)] = name
        for alias in spec.get("aliases") or []:
            aliases[norm_text(alias)] = name
    for alias, name in METRIC_EN_ALIASES.items():
        aliases[norm_text(alias)] = name

    target = aliases.get(norm_text(raw)) or aliases.get(norm_text(compact))
    if target is None:
        # Last chance: longest alias contained in the request.
        hits = [
            (len(alias), name)
            for alias, name in aliases.items()
            if len(alias) >= 2 and alias in norm_text(raw)
        ]
        if hits:
            hits.sort(reverse=True)
            target = hits[0][1]
    if target is None:
        supported = sorted(
            name
            for name, spec in metrics.items()
            if spec.get("dataset") == "order_data" and spec.get("type") in {"business", "raw"}
        )
        raise QueryError(
            "UNKNOWN_METRIC",
            f"无法解析指标 '{raw}'。",
            available=supported,
        )

    spec = metrics[target]
    if spec.get("dataset") != "order_data":
        raise QueryError(
            "UNSUPPORTED_METRIC",
            f"指标 '{target}' 不属于 order_data，当前能力只支持订单主表指标。",
            metric=target,
        )
    if spec.get("type") not in {"business", "raw"}:
        raise QueryError(
            "UNSUPPORTED_METRIC",
            f"指标 '{target}' 由专用 operator 计算，当前配置占比能力不支持；请使用内置订单指标。",
            metric=target,
        )
    if not spec.get("time_field"):
        raise QueryError("UNSUPPORTED_METRIC", f"指标 '{target}' 缺少时间字段定义。", metric=target)
    if spec.get("agg") != "count" or spec.get("field") != "order_number":
        raise QueryError(
            "UNSUPPORTED_METRIC",
            f"配置占比需要计数型指标（COUNT DISTINCT order_number）；'{target}' 的聚合方式是 {spec.get('agg')}。",
            metric=target,
        )

    return {
        "input": raw,
        "key": target,
        "field": spec.get("field"),
        "agg": spec.get("agg"),
        "time_field": spec.get("time_field"),
        "aliases": spec.get("aliases") or [],
        "extra_filters": spec.get("extra_filters") or [],
        "definition": f"{target} = COUNTD(order_number) WHERE {spec.get('time_field')} IS NOT NULL",
    }


DIMENSION_ALIASES = {
    "seat_count": (
        "seat_count",
        "seatcount",
        "seat",
        "seats",
        "座位数",
        "座位",
        "座椅",
        "座椅数",
        "座椅布局",
        "五六座",
        "五座六座",
        "大五座大六座",
        "五座/六座",
    ),
    "power_type": (
        "power_type",
        "powertype",
        "energy_type",
        "energytype",
        "energy",
        "动力类型",
        "能源类型",
        "动力",
        "增程纯电",
        "纯电增程",
    ),
    "product_version": (
        "product_version",
        "productversion",
        "version",
        "trim",
        "版本",
        "车型版本",
        "版型",
    ),
    "order_type": (
        "order_type",
        "ordertype",
        "订单类型",
        "用户车试驾车",
    ),
}

ATTRIBUTE_ALIASES = {
    "内饰": ("内饰", "内饰颜色", "内饰风格", "颜色内饰"),
    "外饰": ("外饰", "外饰颜色", "外观", "外观颜色", "车身颜色", "颜色外观"),
    "轮毂": ("轮毂", "轮辋", "轮圈", "车轮"),
    "方向盘": ("方向盘", "方向盘样式"),
    "激光雷达": ("激光雷达", "雷达"),
    "已选": ("已选", "选装包", "配置包", "已选配置"),
    "智控地暖系统": ("地暖", "智控地暖", "地暖系统"),
    "21.5英寸二排观影屏": ("二排屏", "后排屏", "观影屏", "二排观影屏", "后排娱乐屏"),
    "智能冷暖双用冰箱": ("冰箱", "车载冰箱"),
    "拖挂系统": ("拖挂", "拖车钩", "拖钩"),
}


def resolve_dimension(dimension: str, available_attributes: list[str], semantics: dict, family: str) -> dict:
    raw = (dimension or "seat_count").strip()
    normalized = norm_text(raw)

    if normalized.startswith("config:"):
        attr = raw.split(":", 1)[1].strip()
        return _config_dimension(attr, available_attributes, semantics, family)

    for key, aliases in DIMENSION_ALIASES.items():
        if normalized in {norm_text(alias) for alias in aliases}:
            if key == "seat_count":
                return {
                    "input": raw,
                    "key": "seat_count",
                    "label": "座位数",
                    "kind": "seat_count",
                    "config_attribute": "座椅",
                    "definition": (
                        "优先读取 config_attribute.Attribute == '座椅'（value_code Five/Six）；"
                        "缺失时回退 business_definition.seat_count_logic 的 product_name 五座/六座规则"
                    ),
                }
            if key == "power_type":
                return {
                    "input": raw,
                    "key": "power_type",
                    "label": "动力类型",
                    "kind": "power_type",
                    "definition": "business_definition.product_version_series[series][version].power_type",
                }
            if key == "product_version":
                return {
                    "input": raw,
                    "key": "product_version",
                    "label": "产品版本",
                    "kind": "product_version",
                    "definition": "business_definition.product_version_logic[generation]",
                }
            return {
                "input": raw,
                "key": "order_type",
                "label": "订单类型",
                "kind": "order_type",
                "definition": "order_data.order_type",
            }

    # Exact attribute name.
    for attr in available_attributes:
        if norm_text(attr) == normalized:
            return _config_dimension(attr, available_attributes, semantics, family)

    # Curated attribute aliases.
    for attr, aliases in ATTRIBUTE_ALIASES.items():
        if any(norm_text(alias) == normalized for alias in aliases):
            actual = next((name for name in available_attributes if norm_text(name) == norm_text(attr)), None)
            if actual:
                return _config_dimension(actual, available_attributes, semantics, family)

    # Fuzzy attribute match (contains), unique only.
    candidates = [
        attr
        for attr in available_attributes
        if len(normalized) >= 2
        and (normalized in norm_text(attr) or norm_text(attr) in normalized)
    ]
    if len(candidates) == 1:
        return _config_dimension(candidates[0], available_attributes, semantics, family)
    if len(candidates) > 1:
        raise QueryError(
            "AMBIGUOUS_DIMENSION",
            f"维度 '{raw}' 匹配到多个配置属性，请指定更精确的名称。",
            candidates=candidates,
        )

    raise QueryError(
        "UNKNOWN_DIMENSION",
        f"无法解析配置维度 '{raw}'。",
        available_dimensions=[
            "seat_count",
            "power_type",
            "product_version",
            "order_type",
            *available_attributes[:30],
        ],
    )


def _config_dimension(attr: str, available_attributes: list[str], semantics: dict, family: str) -> dict:
    actual = next((name for name in available_attributes if norm_text(name) == norm_text(attr)), None)
    if actual is None:
        raise QueryError(
            "UNKNOWN_CONFIG_ATTRIBUTE",
            f"当前订单范围内没有配置属性 '{attr}'。",
            available=available_attributes[:30],
        )
    series_semantics = (semantics.get("series") or {}).get(family) or {}
    spec = (series_semantics.get("attributes") or {}).get(actual) or {}
    return {
        "input": attr,
        "key": f"config:{actual}",
        "label": actual,
        "kind": "config_attribute",
        "config_attribute": actual,
        "semantic": spec.get("semantic"),
        "definition": (
            "shared/schema/config_semantics.json"
            if spec
            else "config_attribute 原始值（该车系/属性未登记 config_semantics，按 value_code/value 归一）"
        ),
    }


# ---------------------------------------------------------------------------
# Data loading and order aggregation
# ---------------------------------------------------------------------------


def _ensure_definition_paths(definition_root: Path) -> None:
    for path in (
        str(definition_root / "workspace"),
        str(definition_root / "shared"),
        str(definition_root),
    ):
        if path not in sys.path:
            sys.path.insert(0, path)


def import_product_attributes(definition_root: Path):
    _ensure_definition_paths(definition_root)
    try:
        from operators.product_attributes import resolve_product_attributes  # type: ignore

        return resolve_product_attributes
    except Exception as exc:  # pragma: no cover - environment failure path
        raise QueryError(
            "DEFINITION_IMPORT_FAILED",
            f"无法加载 shared/operators/product_attributes.py：{exc}",
            definition_root=str(definition_root),
        ) from exc


def import_series_group(definition_root: Path):
    _ensure_definition_paths(definition_root)
    try:
        from operators.series_group_logic import apply_series_group_logic  # type: ignore

        return apply_series_group_logic
    except Exception as exc:  # pragma: no cover - environment failure path
        raise QueryError(
            "DEFINITION_IMPORT_FAILED",
            f"无法加载 shared/operators/series_group_logic.py：{exc}",
            definition_root=str(definition_root),
        ) from exc


def read_orders(path: Path, columns: list[str], series_values: list[str]) -> pd.DataFrame:
    dataset = ds.dataset(str(path), format="parquet")
    available = set(dataset.schema.names)
    columns = [column for column in dict.fromkeys(columns) if column in available]
    expression = None
    if series_values and "series" in available:
        expression = ds.field("series").isin(series_values)
    try:
        table = dataset.to_table(columns=columns, filter=expression)
    except Exception:
        table = dataset.to_table(columns=columns)
    frame = table.to_pandas()
    if "order_number" not in frame.columns:
        raise QueryError("SCHEMA_MISMATCH", f"order_data 缺少 order_number 列：{path}")
    frame["order_number"] = frame["order_number"].astype("string")
    for column in ("series", "product_name", "order_type", "license_city"):
        if column in frame.columns:
            frame[column] = frame[column].astype("string")
    return frame


def apply_filter(frame: pd.DataFrame, field: str, op: str, value: Any, warnings: list[str]) -> pd.DataFrame:
    if field not in frame.columns:
        warnings.append(f"过滤字段 {field} 不在 order_data 中，已忽略该过滤条件")
        return frame
    op = (op or "").strip()
    if op == "!=" and value is None:
        return frame[frame[field].notna()]
    if op == "==" and value is None:
        return frame[frame[field].isna()]
    if op == "!=":
        return frame[frame[field].astype("string") != str(value)]
    if op == "==":
        return frame[frame[field].astype("string") == str(value)]
    if op == ">":
        return frame[pd.to_numeric(frame[field], errors="coerce") > float(value)]
    if op == ">=":
        return frame[pd.to_numeric(frame[field], errors="coerce") >= float(value)]
    if op == "<":
        return frame[pd.to_numeric(frame[field], errors="coerce") < float(value)]
    if op == "<=":
        return frame[pd.to_numeric(frame[field], errors="coerce") <= float(value)]
    if op == "contains":
        return frame[frame[field].astype("string").str.contains(str(value), na=False, regex=False)]
    warnings.append(f"未知过滤操作 {op}（字段 {field}），已忽略")
    return frame


def read_config(path: Path | None, order_ids: list[str], warnings: list[str]) -> pd.DataFrame:
    if path is None:
        warnings.append("当前快照没有 config_attribute.parquet，座位维度只能回退 product_name")
        return pd.DataFrame(columns=["Order Number", "Attribute", "value", "value_code"])
    dataset = ds.dataset(str(path), format="parquet")
    columns = [column for column in ("Order Number", "Attribute", "value", "value_code") if column in dataset.schema.names]
    expression = None
    has_filter = "Order Number" in dataset.schema.names and bool(order_ids)
    if has_filter:
        expression = ds.field("Order Number").isin(order_ids)
    try:
        table = dataset.to_table(columns=columns, filter=expression)
    except Exception as exc:
        has_filter = False
        warnings.append(f"按订单裁剪 config_attribute 失败，退回全表读取：{exc}")
        table = dataset.to_table(columns=columns)
    frame = table.to_pandas()
    if "Order Number" not in frame.columns:
        raise QueryError("SCHEMA_MISMATCH", f"config_attribute 缺少 Order Number 列：{path}")
    frame["Order Number"] = frame["Order Number"].astype("string")
    if "Attribute" in frame.columns:
        frame["Attribute"] = frame["Attribute"].astype("string")
    if "value" in frame.columns:
        frame["value"] = frame["value"].astype("string")
    if "value_code" in frame.columns:
        frame["value_code"] = frame["value_code"].astype("string")
    if not has_filter:
        frame = frame[frame["Order Number"].isin(set(order_ids))]
    return frame


def seat_from_values(code: Any, value: Any) -> str | None:
    code_text = "" if code is None or pd.isna(code) else str(code).strip().lower()
    value_text = "" if value is None or pd.isna(value) else str(value).strip()
    if code_text in {"five", "5", "f"}:
        return "五座"
    if code_text in {"six", "6", "s"}:
        return "六座"
    if re.search(r"五座|5座|大五座", value_text):
        return "五座"
    if re.search(r"六座|6座|大六座", value_text):
        return "六座"
    return None


def build_seat_map(config: pd.DataFrame, warnings: list[str]) -> tuple[dict[str, str], dict]:
    if config.empty or "Attribute" not in config.columns:
        return {}, {"rows": 0, "orders": 0, "conflicts": 0, "conflict_orders": []}
    rows = config[config["Attribute"] == "座椅"].copy()
    if rows.empty:
        warnings.append("config_attribute 中没有 '座椅' 属性，座位维度回退 product_name")
        return {}, {"rows": 0, "orders": 0, "conflicts": 0, "conflict_orders": []}
    rows["_seat"] = [seat_from_values(code, value) for code, value in zip(rows["value_code"], rows["value"])]
    rows = rows[rows["_seat"].notna()]
    grouped = rows.groupby("Order Number")["_seat"].agg(lambda values: sorted(set(values)))
    mapping: dict[str, str] = {}
    conflicts: list[str] = []
    for order_id, values in grouped.items():
        if len(values) == 1:
            mapping[str(order_id)] = values[0]
        elif len(values) > 1:
            conflicts.append(str(order_id))
    return mapping, {
        "rows": int(len(rows)),
        "orders": int(len(grouped)),
        "conflicts": len(conflicts),
        "conflict_orders": conflicts[:10],
    }


def canonical_config_value(
    attribute: str,
    spec: dict,
    code: Any,
    value: Any,
    warnings: list[str],
) -> tuple[str | None, bool | None]:
    """Return (label, included) for one config row.

    ``included`` is meaningful for boolean attributes only.  ``label`` is None
    for noise rows that must not enter a share.
    """
    code_text = "" if code is None or pd.isna(code) else str(code).strip()
    value_text = "" if value is None or pd.isna(value) else str(value).strip()
    semantic = (spec or {}).get("semantic")

    if semantic == "noise":
        return None, None

    codes = (spec or {}).get("codes") or {}
    if codes:
        if code_text in codes:
            code_spec = codes[code_text] or {}
            label = code_spec.get("display") or value_text or code_text
            included = bool(code_spec.get("included", True))
            if semantic == "boolean":
                return ("含" if included else "不含"), included
            return label, included
        # value_code missing / unknown: reverse-map by display or alias.
        for candidate_code, code_spec in codes.items():
            aliases = [code_spec.get("display") or ""] + list(code_spec.get("aliases") or [])
            if value_text and value_text in aliases:
                included = bool(code_spec.get("included", True))
                if semantic == "boolean":
                    return ("含" if included else "不含"), included
                return code_spec.get("display") or value_text, included

    if attribute == "座椅":
        seat = seat_from_values(code_text, value_text)
        return seat, None

    lowered = code_text.lower()
    if lowered in {"y", "yes", "true", "1"} or value_text == "是":
        return "含", True
    if lowered in {"n", "no", "false", "0"} or value_text in {"否", "无", "未选", "不选"}:
        return "不含", False

    label = value_text or code_text
    return (label or None), None


def build_config_dimension_map(
    config: pd.DataFrame,
    attribute: str,
    spec: dict,
    warnings: list[str],
) -> tuple[dict[str, str], dict]:
    rows = config[config["Attribute"] == attribute].copy() if not config.empty else pd.DataFrame()
    if rows.empty:
        return {}, {"rows": 0, "orders": 0, "conflicts": 0, "conflict_orders": []}

    # Without a generation-specific semantics entry, canonicalize by value_code
    # within the queried orders (most common display), never by another
    # generation's display name.
    display_by_code: dict[str, str] = {}
    if not spec:
        coded = rows.dropna(subset=["value_code"]).copy()
        coded["value_code"] = coded["value_code"].astype(str).str.strip()
        coded = coded[coded["value_code"].ne("") & coded["value"].notna()]
        if not coded.empty:
            display_by_code = (
                coded.groupby(["Attribute", "value_code"])["value"]
                .agg(lambda values: values.value_counts().idxmax())
                .to_dict()
            )

    labels: list[str | None] = []
    included: list[bool | None] = []
    for code, value in zip(rows.get("value_code", []), rows.get("value", [])):
        if not spec:
            code_text = "" if code is None or pd.isna(code) else str(code).strip()
            value_text = "" if value is None or pd.isna(value) else str(value).strip()
            lowered = code_text.lower()
            if lowered in {"y", "yes", "true", "1"} or value_text == "是":
                labels.append("含")
                included.append(True)
                continue
            if lowered in {"n", "no", "false", "0"} or value_text in {"否", "无", "未选", "不选"}:
                labels.append("不含")
                included.append(False)
                continue
            label = display_by_code.get((attribute, code_text), value_text or code_text)
            labels.append(label or None)
            included.append(None)
            continue
        label, flag = canonical_config_value(attribute, spec, code, value, warnings)
        labels.append(label)
        included.append(flag)

    rows["_label"] = labels
    rows["_included"] = included
    rows = rows[rows["_label"].notna()]
    rows["_label"] = rows["_label"].astype("string")
    mapping: dict[str, str] = {}
    conflicts: list[str] = []
    for order_id, group in rows.groupby("Order Number"):
        if group["_included"].notna().any() and (spec or {}).get("semantic") == "boolean":
            mapping[str(order_id)] = "含" if bool(group["_included"].fillna(False).any()) else "不含"
            continue
        values = sorted(set(group["_label"].dropna().astype(str)))
        if len(values) == 1:
            mapping[str(order_id)] = values[0]
        elif len(values) > 1:
            conflicts.append(str(order_id))
    return mapping, {
        "rows": int(len(rows)),
        "orders": int(rows["Order Number"].nunique()),
        "conflicts": len(conflicts),
        "conflict_orders": conflicts[:10],
    }


def aggregate_groups(
    labels: pd.Series,
    value_order: list[str] | None = None,
    missing_label: str = "未知",
) -> tuple[list[dict], int, int]:
    labels = labels.fillna(missing_label).astype(str)
    known = labels[labels != missing_label]
    denominator = int(len(labels))
    known_count = int(len(known))
    counts = known.value_counts()
    order_index = {value: index for index, value in enumerate(value_order or [])}
    items = [
        {"value": str(value), "count": int(count)}
        for value, count in sorted(
            counts.items(),
            key=lambda item: (-int(item[1]), order_index.get(str(item[0]), 999), str(item[0])),
        )
    ]
    for item in items:
        item["share"] = round(item["count"] / known_count, 6) if known_count else 0.0
        item["share_of_total"] = round(item["count"] / denominator, 6) if denominator else 0.0
    return items, denominator, denominator - known_count


# ---------------------------------------------------------------------------
# Time window
# ---------------------------------------------------------------------------


def resolve_time_window(
    request: dict,
    vehicle: dict,
    metric: dict,
    family_orders: pd.DataFrame,
) -> dict:
    time_field = metric["time_field"]
    times = pd.to_datetime(family_orders[time_field], errors="coerce").dropna()
    cutoff = times.max() if len(times) else None
    minimum = times.min() if len(times) else None

    explicit_start = request.get("start_date")
    explicit_end = request.get("end_date")
    window = (request.get("time_window") or "").strip().lower()

    if cutoff is not None:
        default_end = cutoff.normalize() + timedelta(days=1)
    else:
        default_end = now_local().normalize() + timedelta(days=1)

    launch = parse_ts(vehicle.get("launch"))
    presale = parse_ts(vehicle.get("presale_start"))

    if explicit_start or explicit_end:
        start = parse_ts(explicit_start) if explicit_start else None
        end_date = parse_ts(explicit_end) if explicit_end else None
        end = end_date.normalize() + timedelta(days=1) if end_date is not None else default_end
        if start is None:
            start = launch or presale or minimum or default_end - timedelta(days=30)
        label = f"{start.date()} ~ {(end - timedelta(days=1)).date()}"
        basis = "显式 start_date / end_date"
    elif window in {"all", "full", "全部", "全量"}:
        start = (minimum or default_end).normalize()
        end = default_end
        label = "全量历史"
        basis = "order_data 内最早时间"
    elif window in {"last_7_days", "last7", "近7天", "近7日"}:
        end = default_end
        start = end.normalize() - timedelta(days=7)
        label = "近 7 天"
        basis = "数据截止日前 7 天"
    elif window in {"last_30_days", "last30", "近30天", "近30日"}:
        end = default_end
        start = end.normalize() - timedelta(days=30)
        label = "近 30 天"
        basis = "数据截止日前 30 天"
    elif window in {"mtd", "本月"}:
        end = default_end
        start = end.normalize().replace(day=1)
        label = "本月"
        basis = "数据截止日所在月"
    elif window in {"ytd", "今年"}:
        end = default_end
        start = end.normalize().replace(month=1, day=1)
        label = "今年"
        basis = "数据截止日所在年"
    else:
        # Default: launch date when confirmed, otherwise presale start.
        start = (launch or presale or minimum or default_end - timedelta(days=30)).normalize()
        end = default_end
        if launch is not None:
            label = "上市以来"
            basis = "business_definition.time_periods[generation].end"
        elif presale is not None:
            label = "预售以来（上市日未确认）"
            basis = "business_definition.time_periods[generation].start；无 end"
        else:
            label = "全量历史"
            basis = "无上市/预售定义，取数据最早时间"

    if start >= end:
        raise QueryError(
            "EMPTY_TIME_WINDOW",
            f"时间窗口为空：{start} ~ {end}（end 为开区间上界）",
        )

    return {
        "time_field": time_field,
        "start": display_ts(start),
        "end_exclusive": display_ts(end),
        "label": label,
        "basis": basis,
        "data_cutoff": display_ts(cutoff),
        "data_first": display_ts(minimum),
        "start_ts": start,
        "end_ts": end,
    }


# ---------------------------------------------------------------------------
# Main query
# ---------------------------------------------------------------------------


def run_query(request: dict) -> dict:
    started = time.perf_counter()
    warnings: list[str] = []

    cwd = Path(request.get("cwd") or os.getcwd()).expanduser().resolve()
    business_root = Path(request.get("business_root") or cwd).expanduser().resolve()
    definition_root = Path(request.get("definition_root") or business_root).expanduser().resolve()
    state_dir = Path(request["state_dir"]).expanduser() if request.get("state_dir") else None
    explicit_snapshot = Path(request["snapshot_dir"]).expanduser() if request.get("snapshot_dir") else None
    refresh_requested = bool(request.get("refresh"))
    max_age_hours = float(request.get("max_age_hours") or MAX_AGE_HOURS_DEFAULT)

    # Refresh first when explicitly requested; the returned snapshot becomes the query input.
    refresh_info = {"requested": refresh_requested, "performed": False, "status": "not_requested"}
    refreshed_snapshot: dict | None = None
    if refresh_requested:
        schema = definition_root / "shared" / "schema"
        resolve_vehicle(request.get("vehicle") or "", load_json(schema / "business_definition.json"))
        resolve_metric(request.get("metric") or "locked_orders", load_json(schema / "metrics.json").get("metrics") or {})
        try:
            refreshed_snapshot = refresh_and_snapshot(
                business_root=business_root,
                python=request.get("python") or "",
                timeout=float(request.get("refresh_timeout") or 900),
            )
            refresh_info = {
                "requested": True,
                "performed": True,
                "status": "success",
                "snapshot_dir": refreshed_snapshot["directory"],
                "jobs": refreshed_snapshot.get("jobs", []),
            }
        except Exception as exc:
            refresh_info = {
                "requested": True,
                "performed": False,
                "status": "failed",
                "error": str(exc),
                "fallback": "existing_snapshot",
            }
            warnings.append(f"刷新失败，已回退到现有快照：{exc}")

    snapshot: dict
    if refreshed_snapshot is not None:
        snapshot = refreshed_snapshot
    else:
        try:
            snapshot = discover_snapshot(cwd, state_dir, explicit_snapshot)
        except QueryError:
            raise
        except Exception as exc:
            warnings.append(f"快照发现失败，回退到 live dataset：{exc}")
            snapshot = {}
        if not snapshot:
            snapshot = live_snapshot(
                business_root,
                "未发现工单 analysisSnapshot，回退到生产 checkout 的 dataset/（非快照一致性读取）",
            )

    def definition_path(name: str) -> Path:
        pinned = snapshot.get("definitions", {}).get(name, {}).get("path")
        if pinned:
            return Path(snapshot["directory"]) / pinned
        return definition_root / "shared" / "schema" / f"{name}.json"

    bdef_path = definition_path("business_definition")
    metrics_path = definition_path("metrics")
    semantics_path = definition_path("config_semantics")
    bdef = load_json(bdef_path)
    metrics = (load_json(metrics_path) or {}).get("metrics") or {}
    semantics = load_json(semantics_path) if semantics_path.exists() else {}

    vehicle = resolve_vehicle(request.get("vehicle") or "", bdef)
    metric = resolve_metric(request.get("metric") or "locked_orders", metrics)

    order_info = snapshot["datasets"].get("order_data")
    if not order_info:
        raise QueryError("SNAPSHOT_MISSING", "快照中缺少 order_data")
    config_info = snapshot["datasets"].get("config_attribute")
    order_path = Path(order_info["path"])
    config_path = Path(config_info["path"]) if config_info else None

    order_columns = [
        "order_number",
        "series",
        "product_name",
        "order_type",
        metric["time_field"],
        "license_city",
        *[item.get("field") for item in metric["extra_filters"] if item.get("field")],
    ]
    orders = read_orders(order_path, order_columns, vehicle["series_values"])
    if orders.empty:
        raise QueryError(
            "EMPTY_SCOPE",
            f"order_data 中没有 series ∈ {vehicle['series_values']} 的订单。",
            series_values=vehicle["series_values"],
        )

    if metric["time_field"] not in orders.columns:
        raise QueryError(
            "SCHEMA_MISMATCH",
            f"order_data 缺少指标时间字段 {metric['time_field']}。",
        )
    orders[metric["time_field"]] = pd.to_datetime(orders[metric["time_field"]], errors="coerce")

    # Generation first: it is the routing key, and it keeps version/seat
    # warnings limited to the rows that actually enter this query.
    apply_series_group_logic = import_series_group(definition_root)
    try:
        orders = apply_series_group_logic(orders, bdef)
        orders["generation"] = orders["series_group_logic"]
    except Exception as exc:
        raise QueryError("ATTRIBUTE_RESOLUTION_FAILED", f"无法按共享业务定义解析 product_name 的代际：{exc}") from exc

    family_rows = len(orders)
    unmatched = orders[orders["generation"].isin(["其他", "未分类"])]
    if len(unmatched):
        warnings.append(f"{len(unmatched)} 行 product_name 未命中任何代际规则（generation=其他），已排除在车型范围外")

    scoped = orders[orders["generation"].isin(vehicle["generation_keys"])].copy()
    if scoped.empty:
        raise QueryError(
            "EMPTY_SCOPE",
            f"没有订单命中代际 {vehicle['generation_keys']}（series_group_logic）。",
            generation_keys=vehicle["generation_keys"],
        )

    time_window = resolve_time_window(request, vehicle, metric, scoped)
    scoped = scoped[
        (scoped[metric["time_field"]] >= time_window["start_ts"])
        & (scoped[metric["time_field"]] < time_window["end_ts"])
    ].copy()

    for item in metric["extra_filters"]:
        scoped = apply_filter(
            scoped,
            str(item.get("field") or ""),
            str(item.get("op") or ""),
            item.get("value"),
            warnings,
        )

    order_type_filter = request.get("order_type")
    if order_type_filter:
        scoped = scoped[scoped["order_type"].astype("string") == str(order_type_filter)]
    if request.get("exclude_test_orders"):
        scoped = scoped[scoped["order_type"].astype("string") != "试驾车"]
    city_filter = request.get("city")
    if city_filter:
        if "license_city" in scoped.columns:
            scoped = scoped[scoped["license_city"].astype("string") == str(city_filter)]
        else:
            warnings.append("order_data 缺少 license_city，city 过滤被忽略")

    before_dedup = len(scoped)
    scoped = scoped[scoped["order_number"].notna() & (scoped["order_number"].astype("string").str.len() > 0)]
    scoped = scoped.drop_duplicates(subset=["order_number"], keep="first").copy()
    order_duplicates = int(before_dedup - len(scoped))
    denominator = int(len(scoped))
    if denominator == 0:
        raise QueryError(
            "EMPTY_SCOPE",
            "按车型、指标时间、过滤条件裁剪后没有订单。",
            time_window=time_window["label"],
        )

    order_ids = scoped["order_number"].astype(str).tolist()
    config = read_config(config_path, order_ids, warnings)
    if not config.empty:
        config = config[config["Order Number"].astype(str).isin(set(order_ids))].copy()
        exact_duplicates = int(config.duplicated().sum())
        config = config.drop_duplicates()
    else:
        exact_duplicates = 0

    config_orders = int(config["Order Number"].nunique()) if not config.empty else 0
    attribute_names = (
        sorted(config["Attribute"].dropna().astype(str).unique().tolist())
        if not config.empty
        else []
    )
    dimension = resolve_dimension(
        request.get("dimension") or "seat_count",
        attribute_names,
        semantics,
        vehicle["family"],
    )

    if dimension["kind"] in {"seat_count", "power_type", "product_version"}:
        resolve_product_attributes = import_product_attributes(definition_root)
        try:
            attrs = resolve_product_attributes(scoped, bdef)
            scoped["product_version"] = attrs.version
            scoped["power_type"] = attrs.power_type
            scoped["product_seat"] = attrs.seat_count
            # Version warnings only matter when the requested dimension uses
            # the version/power dictionary; a seat query should not inherit
            # unrelated "unclassified version" noise.
            if dimension["kind"] in {"power_type", "product_version"}:
                warnings.extend(attrs.warnings or [])
        except Exception as exc:
            raise QueryError("ATTRIBUTE_RESOLUTION_FAILED", f"无法按共享业务定义解析 product_name：{exc}") from exc

    scoped_by_id = scoped.set_index("order_number", drop=False)
    seat_conflicts = {"rows": 0, "orders": 0, "conflicts": 0, "conflict_orders": []}
    config_dim_conflicts = {"rows": 0, "orders": 0, "conflicts": 0, "conflict_orders": []}
    source_mix: dict[str, int] = {}
    missing_label = "未知"
    value_order: list[str] | None = None

    if dimension["kind"] == "seat_count":
        missing_label = UNKNOWN_SEAT
        value_order = ["五座", "六座"]
        seat_map, seat_conflicts = build_seat_map(config, warnings)
        config_seat = scoped["order_number"].astype(str).map(seat_map)
        product_seat = scoped["product_seat"].replace({UNKNOWN_SEAT: pd.NA, "": pd.NA})
        final_seat = config_seat.fillna(product_seat).fillna(UNKNOWN_SEAT)
        labels = pd.Series(final_seat.to_numpy(), index=scoped.index)
        source = pd.Series(
            [
                "config_attribute" if isinstance(cfg, str) and cfg in {"五座", "六座"}
                else ("product_name" if isinstance(prod, str) and prod in {"五座", "六座"} else "missing")
                for cfg, prod in zip(config_seat, product_seat)
            ],
            index=scoped.index,
        )
        source_mix = {str(key): int(value) for key, value in source.value_counts().items()}
    elif dimension["kind"] == "config_attribute":
        attr = dimension["config_attribute"]
        generation_for_semantics = (
            vehicle["generation_keys"][0]
            if len(vehicle["generation_keys"]) == 1
            else None
        )
        series_semantics = (
            (semantics.get("series") or {}).get(generation_for_semantics) or {}
            if generation_for_semantics
            else {}
        )
        spec = (series_semantics.get("attributes") or {}).get(attr) or {}
        if not spec:
            dimension["definition"] = (
                f"config_attribute.{attr} 的 value_code/value 原始值"
                f"（{generation_for_semantics or vehicle['family']} 未登记 config_semantics）"
            )
            dimension["semantic"] = None
            warnings.append(
                f"config_semantics 未登记 {generation_for_semantics or vehicle['family']}/{attr}，"
                "按本代际订单内的 value_code/value 原始值归一，未借用其他代际显示名"
            )
        elif spec.get("semantic") == "noise":
            warnings.append(
                f"config_semantics 将 {attr} 标记为 noise（历史噪音属性），未纳入占比；"
                "如为激光雷达请改用 '已选' 或对应独立属性"
            )
        config_map, config_dim_conflicts = build_config_dimension_map(config, attr, spec, warnings)
        labels = scoped["order_number"].astype(str).map(config_map).fillna("未知")
        source_mix = {"config_attribute": int(labels.ne("未知").sum()), "missing": int(labels.eq("未知").sum())}
        if (spec or {}).get("semantic") == "boolean":
            value_order = ["含", "不含"]
    elif dimension["kind"] == "power_type":
        missing_label = UNKNOWN_POWER
        value_order = ["增程", "纯电"]
        labels = scoped["power_type"].fillna(UNKNOWN_POWER).replace({"": UNKNOWN_POWER})
        source_mix = {"product_version_series": int(labels.ne(UNKNOWN_POWER).sum()), "missing": int(labels.eq(UNKNOWN_POWER).sum())}
    elif dimension["kind"] == "product_version":
        missing_label = UNCLASSIFIED_VERSION
        labels = scoped["product_version"].fillna(UNCLASSIFIED_VERSION).replace({"": UNCLASSIFIED_VERSION})
        source_mix = {"product_version_logic": int(labels.ne(UNCLASSIFIED_VERSION).sum()), "missing": int(labels.eq(UNCLASSIFIED_VERSION).sum())}
    elif dimension["kind"] == "order_type":
        missing_label = "未填"
        labels = scoped["order_type"].fillna("未填").replace({"": "未填"})
        source_mix = {"order_data.order_type": int(labels.ne("未填").sum()), "missing": int(labels.eq("未填").sum())}
    else:  # pragma: no cover - resolver guarantees a known kind
        raise QueryError("UNSUPPORTED_DIMENSION", f"不支持的维度类型：{dimension['kind']}")

    groups, denominator, missing = aggregate_groups(labels, value_order, missing_label)
    known = denominator - missing
    if dimension["kind"] == "seat_count":
        for group in groups:
            mask = labels.astype(str) == group["value"]
            group["source_breakdown"] = {
                "config_attribute": int(((source == "config_attribute") & mask).sum()),
                "product_name": int(((source == "product_name") & mask).sum()),
            }

    total_known = known
    for group in groups:
        group["percent"] = round(float(group["share"]) * 100, 2)
        group["percent_of_total"] = round(float(group["share_of_total"]) * 100, 2)

    # Metric cutoff: actual max of the metric's time field in the vehicle scope.
    scoped_all_time = pd.to_datetime(
        orders.loc[orders["generation"].isin(vehicle["generation_keys"]), metric["time_field"]],
        errors="coerce",
    ).dropna()
    metric_cutoff = scoped_all_time.max() if len(scoped_all_time) else None

    # Freshness
    now = now_local()
    order_age_hours = (
        round((now - metric_cutoff).total_seconds() / 3600, 2) if metric_cutoff is not None else None
    )
    config_mtime = parse_ts((config_info or {}).get("file_mtime"))
    config_age_hours = round((now - config_mtime).total_seconds() / 3600, 2) if config_mtime is not None else None
    order_fresh = order_age_hours is not None and order_age_hours <= max_age_hours
    config_fresh = config_age_hours is not None and config_age_hours <= max_age_hours

    order_info = dict(order_info)
    order_info["metric_cutoff"] = display_ts(metric_cutoff)
    order_info["metric_cutoff_column"] = metric["time_field"]
    order_info["age_hours"] = order_age_hours
    order_info["fresh"] = order_fresh
    if config_info:
        config_info = dict(config_info)
        config_info["age_hours"] = config_age_hours
        config_info["fresh"] = config_fresh
        snapshot["datasets"]["config_attribute"] = config_info
    snapshot["datasets"]["order_data"] = order_info

    order_type_counts = {
        str(key): int(value)
        for key, value in scoped["order_type"].fillna("未填").replace({"": "未填"}).value_counts().items()
    }
    null_order_type = int(scoped["order_type"].isna().sum())

    coverage = round(known / denominator, 6) if denominator else 0.0
    missing_share = round(missing / denominator, 6) if denominator else 0.0
    group_sum = sum(int(group["count"]) for group in groups)
    share_sum = sum(float(group["share"]) for group in groups)

    checks: list[dict] = []

    def add_check(name: str, status: str, detail: str, **extra: Any) -> None:
        checks.append({"name": name, "status": status, "detail": detail, **extra})

    add_check("snapshot_readable", "pass", f"order_data {order_info['rows']} 行；config_attribute {config_info['rows'] if config_info else 0} 行")
    add_check(
        "order_key_unique",
        "pass" if order_duplicates == 0 else "warn",
        f"按 order_number 去重移除 {order_duplicates} 行；分母 {denominator} 单",
        removed=order_duplicates,
    )
    add_check(
        "generation_scope",
        "pass" if len(scoped) else "fail",
        f"family 命中 {family_rows} 行，代际 {vehicle['generation_keys']} 内 {denominator} 单",
    )
    add_check(
        "config_join_coverage",
        "pass" if config_orders >= denominator * 0.95 else ("warn" if config_orders >= denominator * 0.5 else "warn"),
        f"{config_orders}/{denominator} 单在 config_attribute 中有任意配置记录（{pct(config_orders / denominator if denominator else 0)}）",
        orders_with_config=config_orders,
        denominator=denominator,
    )
    add_check(
        "dimension_coverage",
        "pass" if coverage >= 0.95 else ("warn" if coverage >= 0.5 else "fail"),
        f"{known}/{denominator} 单可识别 {dimension['label']}（{pct(coverage)}），缺失 {missing} 单",
        known=known,
        missing=missing,
        coverage=coverage,
    )
    add_check(
        "dimension_conflicts",
        "pass" if (seat_conflicts["conflicts"] + config_dim_conflicts["conflicts"]) == 0 else "warn",
        f"座位冲突 {seat_conflicts['conflicts']} 单；配置值冲突 {config_dim_conflicts['conflicts']} 单",
    )
    add_check(
        "config_duplicate_rows",
        "pass" if exact_duplicates == 0 else "warn",
        f"config_attribute 精确重复行 {exact_duplicates} 行（已去除）",
        duplicates=exact_duplicates,
    )
    add_check(
        "denominator_integrity",
        "pass" if group_sum + missing == denominator else "fail",
        f"已知 {group_sum} + 缺失 {missing} = {group_sum + missing}，分母 {denominator}",
    )
    add_check(
        "share_integrity",
        "pass" if abs(share_sum - 1.0) <= 1e-5 or known == 0 else "fail",
        f"已知分组占比合计 {share_sum:.6f}",
    )
    add_check(
        "data_freshness",
        "pass" if order_fresh and (config_fresh or not config_info) else "warn",
        (
            f"order_data 截至 {display_ts(metric_cutoff)}（{order_age_hours}h 前，阈值 {max_age_hours}h）；"
            f"config_attribute 更新 {display_ts(config_mtime)}（{config_age_hours}h 前）"
        ),
        order_age_hours=order_age_hours,
        config_age_hours=config_age_hours,
        max_age_hours=max_age_hours,
    )
    add_check(
        "order_type_completeness",
        "pass" if null_order_type == 0 else "warn",
        f"order_type 未填 {null_order_type}/{denominator} 单",
        null_order_type=null_order_type,
    )
    if dimension["kind"] == "seat_count":
        add_check(
            "seat_source_mix",
            "pass" if source_mix.get("missing", 0) == 0 else ("warn" if coverage >= 0.8 else "fail"),
            f"座位来源：config_attribute {source_mix.get('config_attribute', 0)} 单，product_name {source_mix.get('product_name', 0)} 单，缺失 {source_mix.get('missing', 0)} 单",
            source_mix=source_mix,
        )

    quality_status = "pass"
    if any(check["status"] == "fail" for check in checks):
        quality_status = "fail"
    elif any(check["status"] == "warn" for check in checks):
        quality_status = "warn"

    if config_info and not config_fresh:
        warnings.append(
            f"config_attribute 更新时间 {display_ts(config_mtime)} 已 {config_age_hours}h，超过 {max_age_hours}h 新鲜度阈值"
        )
    if not order_fresh:
        warnings.append(
            f"order_data 业务截止 {display_ts(metric_cutoff)} 已 {order_age_hours}h，超过 {max_age_hours}h 新鲜度阈值；"
            "如需最新数据请显式设置 refresh=true"
        )
    if missing:
        warnings.append(f"{missing} 单缺失 {dimension['label']}，已从占比分母中排除并单独报告")
    if null_order_type:
        warnings.append(f"order_type 未填 {null_order_type} 单，占比可能包含非用户车订单")

    status = "ok"
    if quality_status == "fail":
        status = "partial"
    elif coverage < 0.5:
        status = "partial"

    # Build the human report after all numbers are final.
    filter_rules = build_filter_rules(vehicle, metric, time_window, request)
    report = render_report(
        vehicle=vehicle,
        metric=metric,
        dimension=dimension,
        groups=groups,
        denominator=denominator,
        known=known,
        missing=missing,
        missing_label=missing_label,
        time_window=time_window,
        snapshot=snapshot,
        order_type_counts=order_type_counts,
        coverage=coverage,
        quality_status=quality_status,
        warnings=warnings,
        order_age_hours=order_age_hours,
        config_age_hours=config_age_hours,
        max_age_hours=max_age_hours,
        source_mix=source_mix,
        filter_rules=filter_rules,
        checks=checks,
    )

    elapsed = round(time.perf_counter() - started, 3)
    result = {
        "status": status,
        "summary": build_summary(vehicle, metric, dimension, groups, denominator, missing, coverage),
        "vehicle": vehicle,
        "metric": metric,
        "dimension": dimension,
        "time_window": {key: value for key, value in time_window.items() if not key.endswith("_ts")},
        "filters": {
            "vehicle": vehicle["display"],
            "generation_keys": vehicle["generation_keys"],
            "family": vehicle["family"],
            "metric": metric["key"],
            "time_field": metric["time_field"],
            "order_type": order_type_filter,
            "exclude_test_orders": bool(request.get("exclude_test_orders")),
            "city": city_filter,
            "extra_filters": metric["extra_filters"],
            "rules": filter_rules,
        },
        "result": {
            "denominator": denominator,
            "known_denominator": known,
            "missing": missing,
            "missing_label": missing_label,
            "missing_share": missing_share,
            "coverage": coverage,
            "groups": groups,
            "order_type_breakdown": order_type_counts,
            "table": [
                {
                    dimension["label"]: group["value"],
                    "订单数": group["count"],
                    "占比": f"{group['percent']:.2f}%",
                }
                for group in groups
            ],
            "markdown": report,
        },
        "quality": {
            "status": quality_status,
            "checks": checks,
            "duplicates": {
                "order_rows_removed": order_duplicates,
                "config_exact_rows_removed": exact_duplicates,
            },
            "coverage": {
                "orders_with_any_config": config_orders,
                "dimension_known": known,
                "dimension_missing": missing,
            },
            "conflicts": {
                "seat_orders": seat_conflicts,
                "config_attribute_orders": config_dim_conflicts,
            },
            "source_mix": source_mix,
        },
        "data": {
            "snapshot": {
                key: value
                for key, value in snapshot.items()
                if key != "datasets"
            },
            "datasets": snapshot.get("datasets", {}),
            "definitions": [
                {"path": str(bdef_path), "keys": ["series_group_logic", "time_periods", "product_version_logic", "product_version_series", "seat_count_logic"]},
                {"path": str(metrics_path), "keys": [metric["key"]]},
                {"path": str(semantics_path), "keys": [vehicle["family"]]},
            ],
            "config_rows_in_scope": int(len(config)),
            "config_attributes_in_scope": attribute_names,
            "metric_cutoff": display_ts(metric_cutoff),
        },
        "refresh": refresh_info,
        "warnings": warnings,
        "errors": [],
        "elapsed_seconds": elapsed,
    }
    return result


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------


def build_summary(vehicle: dict, metric: dict, dimension: dict, groups: list[dict], denominator: int, missing: int, coverage: float) -> str:
    if not groups:
        return f"{vehicle['display']} {metric['key']} 按{dimension['label']}：无可识别分组；分母 {denominator} 单，缺失 {missing} 单"
    head = "；".join(f"{group['value']} {fmt_int(group['count'])} 单（{group['percent']:.2f}%）" for group in groups[:4])
    return (
        f"{vehicle['display']} {metric['key']} 按{dimension['label']}：{head}。"
        f"分母 {fmt_int(denominator)} 单，缺失 {fmt_int(missing)} 单（覆盖 {pct(coverage)}）。"
    )


def render_report(
    *,
    vehicle: dict,
    metric: dict,
    dimension: dict,
    groups: list[dict],
    denominator: int,
    known: int,
    missing: int,
    missing_label: str,
    time_window: dict,
    snapshot: dict,
    order_type_counts: dict,
    coverage: float,
    quality_status: str,
    warnings: list[str],
    order_age_hours: float | None,
    config_age_hours: float | None,
    max_age_hours: float,
    source_mix: dict,
    filter_rules: list[str] | None = None,
    checks: list[dict] | None = None,
) -> str:
    lines: list[str] = []
    lines.append(f"### {vehicle['display']} · {metric['key']} · {dimension['label']}")
    lines.append("")
    if groups:
        lines.append("| " + dimension["label"] + " | 订单数 | 占比（已知） | 占比（全量） |")
        lines.append("|---|---:|---:|---:|")
        for group in groups:
            lines.append(
                f"| {group['value']} | {fmt_int(group['count'])} | {group['percent']:.2f}% | {group['percent_of_total']:.2f}% |"
            )
        lines.append("")
    lines.append(f"**分母 {fmt_int(denominator)} 单** · 已知 {fmt_int(known)} 单 · 缺失 {fmt_int(missing)} 单（{pct(1 - coverage)}）")
    lines.append("")
    start_label = str(time_window["start"])[:10]
    end_label = str(time_window["end_exclusive"])[:10]
    lines.append(f"- 时间：{time_window['label']}（{start_label} ~ {end_label}，右开）")
    lines.append(f"- 指标：{metric['definition']}")
    lines.append(f"- 维度：{dimension['definition']}")
    if dimension["kind"] == "seat_count":
        lines.append(
            "- 座位来源：config_attribute `座椅` "
            f"{fmt_int(source_mix.get('config_attribute', 0))} 单；product_name 规则 "
            f"{fmt_int(source_mix.get('product_name', 0))} 单；缺失 {fmt_int(source_mix.get('missing', 0))} 单"
        )
    order_type_text = " / ".join(f"{key} {fmt_int(value)}" for key, value in order_type_counts.items()) or "无"
    lines.append(f"- 订单类型：{order_type_text}")
    lines.append(
        f"- 数据：{snapshot['mode']}；order_data 截至 {_dataset_cutoff(snapshot, 'order_data')}；"
        f"config_attribute 更新 {_dataset_mtime(snapshot, 'config_attribute')}"
    )
    if snapshot.get("version"):
        lines.append(f"- 快照：{snapshot['version']}；{snapshot.get('selected_because', '')}")
    else:
        lines.append(f"- 快照：{snapshot.get('selected_because', snapshot['mode'])}")
    freshness = "合格" if (order_age_hours is not None and order_age_hours <= max_age_hours) else "order_data 需刷新"
    if filter_rules:
        lines.append("- 过滤：" + "；".join(filter_rules))
    if checks:
        counts = {"pass": 0, "warn": 0, "fail": 0}
        for check in checks:
            counts[check["status"]] = counts.get(check["status"], 0) + 1
        non_pass = [f"{check['name']}（{check['status']}）" for check in checks if check["status"] != "pass"]
        quality_line = (
            f"- 质量检查：{counts['pass']} pass / {counts['warn']} warn / {counts['fail']} fail"
        )
        if non_pass:
            quality_line += "；未通过：" + "、".join(non_pass)
        lines.append(quality_line)
    lines.append(
        f"- 质量：{quality_status}；覆盖 {pct(coverage)}；数据新鲜度 {freshness}"
        f"（order_data {order_age_hours if order_age_hours is not None else '?'}h / "
        f"config_attribute {config_age_hours if config_age_hours is not None else '?'}h）"
    )
    if warnings:
        lines.append("")
        lines.append("> 注意：" + "；".join(warnings))
    return "\n".join(lines)


def _dataset_cutoff(snapshot: dict, dataset_id: str) -> str:
    info = (snapshot.get("datasets") or {}).get(dataset_id) or {}
    cutoff = info.get("metric_cutoff") or info.get("data_asof")
    if cutoff:
        column = info.get("metric_cutoff_column") or info.get("data_asof_column")
        return f"{cutoff}（{column}）" if column else str(cutoff)
    return "未知"


def _dataset_mtime(snapshot: dict, dataset_id: str) -> str:
    info = (snapshot.get("datasets") or {}).get(dataset_id) or {}
    return str(info.get("file_mtime") or "未知")


def build_filter_rules(vehicle: dict, metric: dict, time_window: dict, request: dict) -> list[str]:
    start_label = str(time_window["start"])[:10]
    end_label = str(time_window["end_exclusive"])[:10]
    rules = [
        f"series_group_logic ∈ {vehicle['generation_keys']}（{vehicle['rule']}）",
        f"{metric['time_field']} IS NOT NULL",
        f"{metric['time_field']} >= {start_label} 00:00:00 AND < {end_label} 00:00:00",
        "order_number 去重（保留首条）",
    ]
    for item in metric["extra_filters"]:
        field = str(item.get("field") or "")
        op = str(item.get("op") or "")
        value = item.get("value")
        if field == metric["time_field"] and op == "!=" and value is None:
            continue
        rules.append(f"{field} {op} {value}")
    if request.get("order_type"):
        rules.append(f"order_type == {request['order_type']}")
    if request.get("exclude_test_orders"):
        rules.append("order_type != 试驾车")
    if request.get("city"):
        rules.append(f"license_city == {request['city']}")
    return rules


# ---------------------------------------------------------------------------
# Controlled refresh + snapshot
# ---------------------------------------------------------------------------


def _python_for_refresh(business_root: Path, requested: str) -> Path:
    if requested:
        path = Path(requested).expanduser()
        if path.exists():
            return path
    candidate = business_root / ".venv" / "bin" / "python"
    if candidate.exists():
        return candidate
    return Path(sys.executable)


def _run_service_job(python: Path, business_root: Path, job_id: str, timeout: float) -> dict:
    command = [str(python), "-m", "jobs.cli", "--job", job_id, "--format", "json"]
    completed = subprocess.run(
        command,
        cwd=str(business_root),
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    payload = find_json_object(completed.stdout) or find_json_object(completed.stderr)
    if payload is None:
        raise QueryError(
            "REFRESH_FAILED",
            f"{job_id} 未返回 JSON（exit {completed.returncode}）：{(completed.stderr or completed.stdout)[-600:]}",
        )
    status = str(payload.get("status") or "")
    if status not in {"success", "no_new_data"}:
        raise QueryError(
            "REFRESH_FAILED",
            f"{job_id} 状态 {status or 'unknown'}：{payload.get('error') or payload.get('summary') or ''}",
            job=job_id,
        )
    if not payload.get("run_id"):
        raise QueryError("REFRESH_FAILED", f"{job_id} 成功但缺少 run_id，无法创建一致性快照")
    return payload


def refresh_and_snapshot(*, business_root: Path, python: str, timeout: float) -> dict:
    if not (business_root / "jobs" / "production.py").exists():
        raise QueryError(
            "REFRESH_UNAVAILABLE",
            f"生产 checkout 缺少 jobs/production.py：{business_root}",
        )
    if not (business_root / "jobs" / "snapshot.py").exists():
        raise QueryError(
            "REFRESH_UNAVAILABLE",
            f"生产 checkout 缺少 jobs/snapshot.py：{business_root}",
        )
    interpreter = _python_for_refresh(business_root, python)
    started = time.perf_counter()
    daily = _run_service_job(interpreter, business_root, "data_refresh_daily", timeout)
    config = _run_service_job(interpreter, business_root, "data_refresh_config_attribute", timeout)
    snapshot_dir = business_root / "outputs" / "order_config_ratio" / "snapshots" / uuid.uuid4().hex
    snapshot_dir.mkdir(parents=True, exist_ok=False)
    command = [
        str(interpreter),
        "-m",
        "jobs.snapshot",
        "--destination",
        str(snapshot_dir),
        "--dataset",
        "order_data",
        "--dataset",
        "config_attribute",
        "--run-id",
        str(daily["run_id"]),
        "--run-id",
        str(config["run_id"]),
    ]
    completed = subprocess.run(
        command,
        cwd=str(business_root),
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    payload = find_json_object(completed.stdout)
    if completed.returncode != 0 or payload is None:
        raise QueryError(
            "SNAPSHOT_FAILED",
            f"jobs.snapshot 失败（exit {completed.returncode}）：{(completed.stderr or completed.stdout)[-600:]}",
        )
    manifest = {
        "version": snapshot_dir.name,
        "created_at": display_ts(now_local()),
        "source": "order_config_ratio.refresh_and_snapshot",
        "datasets": payload,
    }
    (snapshot_dir / "snapshot.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    snapshot = load_snapshot_dir(snapshot_dir, "refreshed_snapshot")
    snapshot["jobs"] = [
        {"job": "data_refresh_daily", "run_id": daily.get("run_id"), "status": daily.get("status")},
        {"job": "data_refresh_config_attribute", "run_id": config.get("run_id"), "status": config.get("status")},
    ]
    snapshot["selected_because"] = (
        "按请求执行 data_refresh_daily + data_refresh_config_attribute，"
        "并用同批 run_id 通过 jobs.snapshot 绑定的一致性快照"
    )
    snapshot["refresh_seconds"] = round(time.perf_counter() - started, 1)
    return snapshot


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, help="JSON request object")
    args = parser.parse_args()
    try:
        request = json.loads(args.request)
    except json.JSONDecodeError as exc:
        print(json.dumps({"status": "error", "error": {"code": "INVALID_REQUEST", "message": str(exc)}}, ensure_ascii=False))
        return
    try:
        result = run_query(request)
        print(json.dumps(result, ensure_ascii=False, default=str))
    except QueryError as exc:
        payload = {
            "status": "error",
            "error": {
                "code": exc.code,
                "message": exc.message,
                **exc.details,
            },
            "warnings": [],
        }
        print(json.dumps(payload, ensure_ascii=False, default=str))
    except Exception as exc:  # pragma: no cover - defensive boundary
        payload = {
            "status": "error",
            "error": {
                "code": "INTERNAL_ERROR",
                "message": f"{type(exc).__name__}: {exc}",
            },
            "warnings": [],
        }
        print(json.dumps(payload, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
