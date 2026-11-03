#!/usr/bin/env python3
"""Report a dataset file's row count, columns and maximum cutoff values for a prepare record.

The workspace preparer sends one JSON request on stdin:

    {"path": "/abs/file.parquet", "columns": ["lock_time"], "now": "2026-11-03T13:00:00+08:00"}

It prints one JSON object on stdout. The probe is read-only: it opens the file for reading and writes nothing.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def _read(path: Path, columns: list[str]):
    import pandas as pd

    if path.suffix == ".parquet":
        import pyarrow.parquet as pq

        parquet = pq.ParquetFile(path)
        schema = list(parquet.schema_arrow.names)
        selected = [column for column in columns if column in schema]
        frame = parquet.read(columns=selected).to_pandas() if selected else None
        return int(parquet.metadata.num_rows), schema, frame, selected
    if path.suffix == ".csv":
        header = pd.read_csv(path, nrows=0).columns.tolist()
        selected = [column for column in columns if column in header]
        frame = pd.read_csv(path, usecols=selected, low_memory=False) if selected else None
        with path.open(encoding="utf-8", errors="ignore") as handle:
            rows = max(sum(1 for _ in handle) - 1, 0)
        return rows, header, frame, selected
    raise ValueError(f"unsupported dataset type: {path.suffix}")


def _cutoffs(frame, selected: list[str], now: datetime) -> list[dict[str, str]]:
    import pandas as pd

    cutoffs: list[dict[str, str]] = []
    now_utc = now.astimezone(timezone.utc).replace(tzinfo=None)
    now_local = now.astimezone().replace(tzinfo=None)
    for column in selected:
        series = pd.to_datetime(frame[column], errors="coerce")
        if getattr(series.dt, "tz", None) is not None:
            series = series.dt.tz_convert(None)
            limit = now_utc
        else:
            limit = now_local
        series = series.dropna()
        series = series[series <= limit]
        latest = series.max()
        if pd.isna(latest):
            continue
        cutoffs.append({"column": column, "at": pd.Timestamp(latest).isoformat()})
    return cutoffs


def main() -> int:
    try:
        request = json.load(sys.stdin)
        path = Path(str(request["path"]))
        columns = [str(column) for column in (request.get("columns") or [])]
        now = datetime.fromisoformat(str(request["now"]).replace("Z", "+00:00")) if request.get("now") else datetime.now(timezone.utc)
        rows, schema, frame, selected = _read(path, columns)
        result = {"rows": rows, "columns": schema}
        if frame is not None and selected:
            result["cutoffs"] = _cutoffs(frame, selected, now)
        print(json.dumps(result))
        return 0
    except Exception as error:  # The preparer turns this into a clear preparation failure.
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
