"""Compute PSNR and SSIM from the exact RGBA captures of each timed resolution.

No historical output is read or modified. Process one image at a time to keep
4K analysis bounded. Requires numpy, scipy and Pillow.
"""
import argparse
import csv
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import subprocess
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import binary_erosion, gaussian_filter


def image_metrics(candidate, reference):
    if candidate.shape != reference.shape or candidate.ndim != 3 or candidate.shape[2] != 4:
        raise ValueError('Expected equally sized RGBA images')
    mask = reference[..., 3] >= 128
    if not np.array_equal(mask, candidate[..., 3] >= 128):
        raise ValueError('Candidate/reference terrain masks differ')
    if not mask.any():
        raise ValueError('Empty terrain mask')
    x = reference[..., :3].astype(np.float64) / 255
    y = candidate[..., :3].astype(np.float64) / 255
    mse = float(np.mean((x[mask] - y[mask]) ** 2))
    psnr = float('inf') if mse == 0 else float(-10 * np.log10(mse))
    weights = np.array([.2989, .5870, .1140])
    x, y = x @ weights, y @ weights
    smooth = lambda value: gaussian_filter(value, sigma=1.5, radius=5)
    mx, my = smooth(x), smooth(y)
    vx, vy = smooth(x*x) - mx*mx, smooth(y*y) - my*my
    cov = smooth(x*y) - mx*my
    ssim_map = ((2*mx*my + .01**2) * (2*cov + .03**2)
                / ((mx*mx + my*my + .01**2) * (vx + vy + .03**2)))
    # Strict support: no fallback to un-eroded mask or outside-image padding.
    interior = binary_erosion(mask, structure=np.ones((11, 11), dtype=bool), border_value=0)
    if not interior.any():
        raise ValueError('No valid SSIM windows fully inside terrain')
    return {'psnr_3d_db': 'Infinity' if np.isinf(psnr) else psnr,
            'ssim_gpu': float(ssim_map[interior].mean()),
            'quality_terrain_pixels': int(mask.sum()), 'ssim_valid_centers': int(interior.sum())}


def load_rgba(path):
    with Image.open(path) as image:
        if image.mode != 'RGBA':
            raise ValueError(f'Terrain alpha mask missing in {path}')
        return np.array(image)


def analyze_session(folder):
    folder = Path(folder)
    report_path = folder / 'resultados_gpu.json'
    report = json.loads(report_path.read_text(encoding='utf8'))
    if report.get('schemaVersion') != 2:
        raise ValueError('Refusing to enrich legacy mixed-resolution dataset')
    for row in report['results']:
        if (row['width'], row['height']) != (row['quality_width'], row['quality_height']):
            raise ValueError('Quality/timing resolution mismatch')
        image = load_rgba(folder / row['quality_frame'])
        if image.shape[:2] != (row['height'], row['width']):
            raise ValueError('PNG resolution does not match row metadata')
        reference_row = next(r for r in report['results'] if r['caseId'] == row['caseId'] and r['methodId'] == row['quality_reference'])
        reference = load_rgba(folder / reference_row['quality_frame'])
        metrics = image_metrics(image, reference)
        before = float(row['psnr_3d_db'])
        after = float(metrics['psnr_3d_db'])
        if not np.isclose(before, after, atol=1e-9, rtol=1e-9):
            raise ValueError(f'Browser/PNG PSNR mismatch: {before} vs {after}')
        row.update(metrics)
    report['qualityProtocol'] = {'source': 'same RGBA PNG for PSNR and SSIM',
        'range': 1, 'channels_psnr': 'RGB', 'channels_ssim': 'Rec.601 luma',
        'ssim_sigma': 1.5, 'ssim_window': 11, 'ssim_mask_erosion': 11,
        'outside_image_windows_excluded': True, 'mask': 'alpha >= 128, terrain only',
        'C1': .01**2, 'C2': .03**2, 'encoding': 'rendered encoded framebuffer values'}
    report['analysisEnvironment'] = {'python': platform.python_version(),
        'packages': {name: importlib.metadata.version(name) for name in ('numpy', 'scipy', 'pillow')}}
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False), encoding='utf8')
    with (folder/'resultados_gpu.csv').open('w', newline='', encoding='utf8') as output:
        writer = csv.DictWriter(output, fieldnames=report['results'][0].keys())
        writer.writeheader(); writer.writerows(report['results'])
    lines = ['# Validação GPU — qualidade e tempo na mesma resolução', '',
             f"Sessão: {report['sessionId']}; GPU: {report['hardware']['unmaskedRenderer']}", '',
             '| Caso | Método | Média ms | Mediana ms | IQR ms | n válido | Descartes | PSNR dB | SSIM |',
             '|---|---|---:|---:|---:|---:|---:|---:|---:|']
    for row in report['results']:
        lines.append(f"| {row['caseId']} | {row['methodId']} | {row['mean_ms']:.4f} | {row['median_ms']:.4f} | "
                     f"{row['iqr_ms']:.4f} | {row['n_valid']} | {row['n_discarded']} | {row['psnr_3d_db']} | {row['ssim_gpu']:.6f} |")
    lines += ['', 'Tempos: passe de cena com céu; preparação das máscaras e leituras de pixels fora das consultas.',
              'Amostras brutas: raw_queries.csv e rawQueries no JSON. Não são contadores de TMU.',
              'As quatro variantes adaptativas formam uma ablação estimador de LOD × filtragem inicial.',
              'A referência comum é nvidia_n6 com filtro grad e estimador aniso.']
    (folder/'tabela_resultados.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
    return report


def analyze_run(folder):
    folder = Path(folder)
    sessions = sorted(folder.glob('session-*/resultados_gpu.json'))
    if not sessions:
        raise ValueError('No schema-v2 session reports found')
    for file in sessions:
        report = analyze_session(file.parent)
        print(f"[quality] {report['sessionId']}: {len(report['results'])} matched-resolution PSNR/SSIM pairs", flush=True)
    return len(sessions)


def run_cli():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--analyze', type=Path, help='Analyze an existing run directory')
    parser.add_argument('--outdir', default='output/validation')
    parser.add_argument('--sessions', type=int, default=5)
    parser.add_argument('--quick', action='store_true')
    parser.add_argument('--smoke', action='store_true')
    parser.add_argument('--allow-software', action='store_true')
    args = parser.parse_args()
    if args.analyze:
        analyze_run(args.analyze)
    else:
        command = ['node', 'src/run_validation.mjs', '--outdir', args.outdir, '--sessions', str(args.sessions)]
        for flag in ('quick', 'smoke', 'allow_software'):
            if getattr(args, flag): command.append('--'+flag.replace('_','-'))
        import os
        subprocess.run(command, cwd=Path(__file__).resolve().parents[1], check=True,
                       env={**os.environ, 'PYTHON':sys.executable})


if __name__ == '__main__':
    run_cli()
