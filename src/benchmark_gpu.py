#!/usr/bin/env python3
"""Schema-v2 GPU validation: independent browser sessions and matched-resolution metrics.

Usage: python src/benchmark_gpu.py --quick --sessions 5
       python src/benchmark_gpu.py --analyze output/validation/run-...
"""
from validation_metrics import run_cli

if __name__ == '__main__':
    run_cli()