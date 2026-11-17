#!/usr/bin/env python3
"""Read-only dataset catalog and probe used by dsh-data-prep.

Two subcommands:

    python dataset_probe.py catalog --root /path/to/business-repo
    python dataset_probe.py probe --request '{"path": "...", "columns": ["lock_time"], "now": "..."}'

`catalog` imports the business repository's own dataset registry (the single
source of truth for dataset ids, paths, requiredness and business date
columns) and its registered production jobs. `probe` reports one file's row
count, columns and latest business cutoff. Neither command writes anything:
the probe opens files for reading only and never imports a refresh module.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def _catalog(root: Path) -> dict:
    sys.path.insert(0, str(root))
    from dataset.updater.dataset_registry import DATASETS  # noqa: PLC0415

    datasets = [
        {
            "id": spec.key,
            "label": spec.label,
            "path": spec.display_path,
            "required": spec.required,
            "step_id": spec.step_id,
            "date_columns": list(spec.date_columns),
            "note": spec.note,
        }
        for spec in DATASETS
    ]
    jobs: list[dict] = []
    try:
        from jobs.production import JOB_DATASETS  # noqa: PLC0415

        jobs = [{"id": key, "datasets": list(value)} for key, value in JOB_DATASETS.items()]
    except Exception:
        # The job mapping is advisory; the dataset catalog stays usable without it.
        jobs = []
    return {"root": str(root), "datasets": datasets, "jobs": jobs}


def _read(path: Path, columns: list[str]):
    import pandas as pd  # noqa: PLC0415

    if path.suffix == ".parquet":
        import pyarrow.parquet as pq  # noqa: PLC0415

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


def _parse_dates(series):
    """Match the dataset registry's parser, including Tableau's Chinese dates."""
    import warnings  # noqa: PLC0415

    import pandas as pd  # noqa: PLC0415

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        parsed = pd.to_datetime(series, errors="coerce")
        if parsed.notna().any():
            return parsed
        cleaned = (
            series.astype(str)
            .str.replace("年", "-", regex=False)
            .str.replace("月", "-", regex=False)
            .str.replace("日", "", regex=False)
        )
        return pd.to_datetime(cleaned, errors="coerce")


def _cutoffs(frame, selected: list[str], now: datetime) -> list[dict[str, str]]:
    import pandas as pd  # noqa: PLC0415

    cutoffs: list[dict[str, str]] = []
    now_utc = now.astimezone(timezone.utc).replace(tzinfo=None)
    now_local = now.astimezone().replace(tzinfo=None)
    for column in selected:
        series = _parse_dates(frame[column])
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


def _probe(request: dict) -> dict:
    path = Path(str(request["path"]))
    if not path.is_file():
        raise FileNotFoundError(f"dataset file is missing: {path}")
    columns = [str(column) for column in (request.get("columns") or [])]
    now = (
        datetime.fromisoformat(str(request["now"]).replace("Z", "+00:00"))
        if request.get("now")
        else datetime.now(timezone.utc)
    )
    rows, schema, frame, selected = _read(path, columns)
    result: dict = {"path": str(path), "rows": rows, "columns": schema}
    if frame is not None and selected:
        result["cutoffs"] = _cutoffs(frame, selected, now)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    catalog_parser = subparsers.add_parser("catalog")
    catalog_parser.add_argument("--root", required=True)
    probe_parser = subparsers.add_parser("probe")
    probe_parser.add_argument("--request", required=True)
    args = parser.parse_args()
    try:
        if args.command == "catalog":
            print(json.dumps(_catalog(Path(args.root).resolve()), ensure_ascii=False))
        else:
            print(json.dumps(_probe(json.loads(args.request)), ensure_ascii=False))
        return 0
    except Exception as error:  # The host turns this into a clear preparation failure.
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
