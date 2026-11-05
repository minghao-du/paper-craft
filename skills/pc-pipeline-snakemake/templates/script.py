# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "polars>=1.0.0",
#     "pyarrow>=15.0.0",
# ]
# ///
"""Stand-alone transformation script with PEP 723 inline dependency metadata.

Executed via: uv run workflow/scripts/{script_name}.py
"""

from __future__ import annotations

import argparse
from pathlib import Path

import polars as pl


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Process staged data artifact.")
    parser.add_argument("--input", required=True, type=Path, help="Input artifact path")
    parser.add_argument("--output", required=True, type=Path, help="Output artifact path")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    df = pl.read_parquet(args.input)
    # Analytical transformation logic
    df.write_parquet(args.output)


if __name__ == "__main__":
    main()
