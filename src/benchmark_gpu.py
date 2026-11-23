#!/usr/bin/env python3
"""
Benchmark 3D 100% executado na GPU real (WebGL 2.0 + EXT_disjoint_timer_query_webgl2).

Executa `src/gpu_bench_driver.mjs` para coletar tempos de GPU em 1080p e 4K,
fetches/px reais, PSNR 3D e frames renderizados pela GPU; calcula SSIM sobre os
frames da GPU e gera tabelas e graficos oficiais em `output/benchmark_gpu/`.
"""

import argparse
import json
import os
import subprocess
import numpy as np
from PIL import Image
from scipy.ndimage import binary_erosion, gaussian_filter

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

LUMA_WEIGHTS = np.array([0.2989, 0.5870, 0.1140], dtype=np.float64)

METHOD_ID_TO_FRAME = {
    "linear": "linear",
    "nvidia_n6": "nvidia_n6",
    "skip_pure": "skip_pure",
    "adap_iso": "adap_iso",
    "adap_aniso": "adap_aniso",
}


def load_rgb_f64(path):
    return np.array(Image.open(path).convert("RGB"), dtype=np.float64) / 255.0


def load_mask_bool(path):
    arr = np.array(Image.open(path).convert("L"), dtype=np.uint8)
    return arr > 128


def compute_ssim_masked(img_a, img_b, mask_bool):
    lum_a = np.dot(img_a[..., :3], LUMA_WEIGHTS)
    lum_b = np.dot(img_b[..., :3], LUMA_WEIGHTS)
    gf = lambda z: gaussian_filter(z, 1.5, truncate=3.5)
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    mx, my = gf(lum_a), gf(lum_b)
    sxx = gf(lum_a * lum_a) - mx * mx
    syy = gf(lum_b * lum_b) - my * my
    sxy = gf(lum_a * lum_b) - mx * my
    s = ((2 * mx * my + c1) * (2 * sxy + c2)) / ((mx * mx + my * my + c1) * (sxx + syy + c2))

    interior = binary_erosion(mask_bool, structure=np.ones((9, 9), dtype=bool))
    region = interior if np.any(interior) else mask_bool
    return float(np.mean(s[region]))


def enrich_ssim_from_gpu_frames(report, frames_dir):
    for preset in ("overview", "grazing"):
        ref_path = os.path.join(frames_dir, f"{preset}_nvidia_n6.png")
        mask_path = os.path.join(frames_dir, f"{preset}_terrain_mask.png")
        if not (os.path.exists(ref_path) and os.path.exists(mask_path)):
            continue
        ref_img = load_rgb_f64(ref_path)
        mask = load_mask_bool(mask_path)
        ssim_cache = {}

        for mid, fkey in METHOD_ID_TO_FRAME.items():
            fpath = os.path.join(frames_dir, f"{preset}_{fkey}.png")
            if os.path.exists(fpath):
                if mid == "nvidia_n6":
                    ssim_cache[mid] = 1.0
                else:
                    ssim_cache[mid] = compute_ssim_masked(load_rgb_f64(fpath), ref_img, mask)

        for row in report["results"]:
            if row["preset"] == preset and row["materialMode"] == "pbr2" and row["methodId"] in ssim_cache:
                row["ssim_gpu"] = ssim_cache[row["methodId"]]


def parse_psnr(val):
    if val == "Infinity" or val is None:
        return float("inf") if val == "Infinity" else None
    return float(val)


def write_markdown_report(report, out_path):
    hw = report["hardware"]
    cfg = report["config"]
    gpu_name = hw.get("unmaskedRenderer") or hw.get("renderer")

    lines = [
        "# Benchmark 3D Executado 100% na GPU (`src/benchmark_gpu.py`)\n",
        "## Ambiente de Hardware e Protocolo\n",
        f"- **GPU:** `{gpu_name}`",
        f"- **API / Shaders:** `{hw.get('webglVersion')}` | `{hw.get('shadingLanguageVersion')}`",
        f"- **Timer de Hardware:** `EXT_disjoint_timer_query_webgl2` = **{hw.get('hasGpuTimerQuery')}**",
        f"- **Protocolo:** aquecimento de clock (12 renders) + {cfg.get('warmupFrames')} rodadas warm-up + {cfg.get('sampleFrames')} rodadas intercaladas (round-robin com ordem alternada par/impar dentro do mesmo tick `rAF`) em FBO offscreen (`pixelRatio = 1`), sem `gl.readPixels` durante a janela de medicao.",
        f"- **Parametros:** `nearLimit={cfg.get('nearLimit')}`, `farLimit={cfg.get('farLimit')}`, `maxLod={cfg.get('maxLod')}`, `maxAniso={cfg.get('maxAniso')}x`, `mip={cfg.get('mip')}`.",
        "- **Qualidade 3D:** PSNR calculado sobre pixels validos de terreno (`960x540` RGB renderizado pela GPU); SSIM (Rec.601) calculado sobre os PNGs `1280x720` capturados diretamente do framebuffer da GPU.\n",
    ]

    groups = []
    seen = set()
    for r in report["results"]:
        key = (r["resolution"], r["preset"], r["materialMode"])
        if key not in seen:
            seen.add(key)
            groups.append(key)

    for res, preset, mat in groups:
        sub = [r for r in report["results"] if (r["resolution"], r["preset"], r["materialMode"]) == (res, preset, mat)]
        has_ssim = any("ssim_gpu" in r for r in sub)
        lines.append(f"## {res} — `{preset}` (`{mat}`)\n")
        hdr = "| Metodo | Timer | GPU Media ± DP (ms) | Mediana (ms) | P95 (ms) | Speedup (%) | Fetches/px | Red. TMU (%) | PSNR 3D (dB) |"
        sep = "|---|---|---|---|---|---|---|---|---|"
        if has_ssim:
            hdr += " SSIM GPU |"
            sep += "---|"
        lines.append(hdr)
        lines.append(sep)

        for r in sub:
            psnr = parse_psnr(r.get("psnr_3d_db"))
            psnr_s = "inf" if (psnr is not None and np.isinf(psnr)) else (f"{psnr:.2f}" if psnr is not None else "-")
            mean_s = f"{r['mean_ms']:.3f} ± {r['std_ms']:.3f}" if r.get("mean_ms") is not None else "-"
            med_s = f"{r['median_ms']:.3f}" if r.get("median_ms") is not None else "-"
            p95_s = f"{r['p95_ms']:.3f}" if r.get("p95_ms") is not None else "-"
            row_s = (
                f"| {r['method']} | {r['timerType']} | {mean_s} | {med_s} | {p95_s} | "
                f"{r['speedup_vs_ref_pct']:+.1f}% | {r['fetches_px']:.2f} | {r['tmu_reduction_pct']:.1f}% | {psnr_s} |"
            )
            if has_ssim:
                ssim_v = r.get("ssim_gpu")
                row_s += f" {ssim_v:.4f} |" if ssim_v is not None else " - |"
            lines.append(row_s)
        lines.append("")

    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


def plot_gpu_1080p_vs_4k(report, out_path):
    combos = [("1080p", "overview"), ("1080p", "grazing"), ("4K", "overview"), ("4K", "grazing")]
    available = [
        (res, pre)
        for (res, pre) in combos
        if any(r["resolution"] == res and r["preset"] == pre and r["materialMode"] == "pbr2" for r in report["results"])
    ]
    if not available:
        return

    methods_order = [
        ("linear", "Linear (5t)", "#64748b"),
        ("nvidia_n6", "NVIDIA N=6 (35t)", "#ef4444"),
        ("nvidia_n3", "NVIDIA N=3 (20t)", "#f59e0b"),
        ("skip_pure", "Skip Puro (20t)", "#38bdf8"),
        ("skip_hybrid", "Skip Hibrido (20t)", "#818cf8"),
        ("adap_iso", "Adap. Iso", "#a3e635"),
        ("adap_aniso", "Adap. Aniso", "#10b981"),
    ]

    fig, axes = plt.subplots(1, len(available), figsize=(5.2 * len(available), 5.2), squeeze=False)
    for idx, (res, pre) in enumerate(available):
        ax = axes[0][idx]
        sub = {
            r["methodId"]: r
            for r in report["results"]
            if r["resolution"] == res and r["preset"] == pre and r["materialMode"] == "pbr2"
        }
        x = np.arange(len(methods_order))
        means = [sub[mid]["mean_ms"] if mid in sub and sub[mid]["mean_ms"] is not None else 0.0 for mid, _, _ in methods_order]
        stds = [sub[mid]["std_ms"] if mid in sub and sub[mid]["std_ms"] is not None else 0.0 for mid, _, _ in methods_order]
        colors = [c for _, _, c in methods_order]
        labels = [lbl for _, lbl, _ in methods_order]

        bars = ax.bar(x, means, yerr=stds, capsize=3, color=colors, edgecolor="#0f172a", linewidth=0.6)
        ymax = max((m + s for m, s in zip(means, stds)), default=1.0) * 1.22
        ax.set_ylim(0, ymax)
        for b, err, (mid, _, _) in zip(bars, stds, methods_order):
            if mid in sub and mid != "nvidia_n6":
                sp = sub[mid]["speedup_vs_ref_pct"]
                ax.text(
                    b.get_x() + b.get_width() * 0.5,
                    b.get_height() + err + ymax * 0.025,
                    f"{sp:+.0f}%",
                    ha="center",
                    va="bottom",
                    fontsize=7.8,
                    fontweight="bold",
                )
        ax.set_xticks(x)
        ax.set_xticklabels(labels, rotation=32, ha="right", fontsize=8.5)
        ax.set_ylabel("Tempo GPU (ms)")
        ax.set_title(f"{res} — {pre} (pbr2)", fontsize=10.5, fontweight="bold")
        ax.grid(axis="y", alpha=0.3)

    gpu_name = report["hardware"].get("unmaskedRenderer") or report["hardware"].get("renderer")
    fig.suptitle(f"Desempenho Real em Hardware GPU (EXT_disjoint_timer_query_webgl2)\n{gpu_name}", fontsize=11.5, fontweight="bold")
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def plot_pbr_scalability(report, out_path):
    mats = ["albedo", "pbr2", "pbr3"]
    avail_mats = [m for m in mats if any(r["resolution"] == "1080p" and r["preset"] == "overview" and r["materialMode"] == m for r in report["results"])]
    if len(avail_mats) < 2:
        return

    sel_methods = [
        ("linear", "Linear Baseline", "#64748b", "o"),
        ("nvidia_n6", "NVIDIA N=6 (Ref)", "#ef4444", "D"),
        ("nvidia_n3", "NVIDIA N=3 (Trunc)", "#f59e0b", "s"),
        ("skip_pure", "Skip Puro {0,2,4,6}", "#38bdf8", "^"),
        ("skip_hybrid", "Skip Hibrido {0,1,3,5}", "#818cf8", "v"),
        ("adap_aniso", "Adaptativo Anisotropico", "#10b981", "P"),
    ]

    fig, ax = plt.subplots(figsize=(8.6, 5.2))
    x = np.arange(len(avail_mats))
    for mid, lbl, col, mk in sel_methods:
        ys, es = [], []
        for mat in avail_mats:
            r = next((row for row in report["results"] if row["resolution"] == "1080p" and row["preset"] == "overview" and row["materialMode"] == mat and row["methodId"] == mid), None)
            ys.append(r["mean_ms"] if r and r["mean_ms"] is not None else np.nan)
            es.append(r["std_ms"] if r and r["std_ms"] is not None else 0.0)
        ax.errorbar(x, ys, yerr=es, marker=mk, markersize=7, linewidth=2.0, capsize=4, color=col, label=lbl)

    mat_labels = {
        "albedo": "Albedo (2 camadas)\n3 fetches/nivel",
        "pbr2": "PBR 2 Camadas\n5 fetches/nivel",
        "pbr3": "PBR 3 Camadas\n8 fetches/nivel",
    }
    ax.set_xticks(x)
    ax.set_xticklabels([mat_labels[m] for m in avail_mats], fontsize=9.5)
    ax.set_ylabel("Tempo GPU (ms) — 1080p overview")
    ax.set_title("Escalabilidade Real em GPU por Complexidade de Material PBR (1080p)", fontsize=11.5, fontweight="bold")
    ax.grid(alpha=0.3)
    ax.legend(fontsize=8.8)
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def plot_gpu_pareto(report, out_path):
    combos = [("1080p", "overview"), ("1080p", "grazing"), ("4K", "overview"), ("4K", "grazing")]
    available = [
        (res, pre)
        for (res, pre) in combos
        if any(r["resolution"] == res and r["preset"] == pre and r["materialMode"] == "pbr2" for r in report["results"])
    ]
    if not available:
        return

    markers = {
        "linear": ("o", "#64748b"),
        "nvidia_n3": ("s", "#f59e0b"),
        "nvidia_n6": ("D", "#ef4444"),
        "skip_pure": ("P", "#38bdf8"),
        "skip_hybrid": ("X", "#818cf8"),
        "adap_iso": ("*", "#a3e635"),
        "adap_aniso": ("^", "#10b981"),
    }

    fig, axes = plt.subplots(1, len(available), figsize=(4.8 * len(available), 5.0), squeeze=False)
    for j, (res, pre) in enumerate(available):
        ax = axes[0][j]
        sub = [r for r in report["results"] if r["resolution"] == res and r["preset"] == pre and r["materialMode"] == "pbr2"]
        for r in sub:
            if r.get("mean_ms") is None:
                continue
            psnr = parse_psnr(r.get("psnr_3d_db"))
            if psnr is None:
                continue
            psnr_plot = 62.0 if np.isinf(psnr) else psnr
            mk, col = markers.get(r["methodId"], ("o", "#334155"))
            lbl = r["method"] if j == 0 else None
            ax.scatter(r["mean_ms"], psnr_plot, marker=mk, s=90, color=col, edgecolor="#0f172a", linewidth=0.6, label=lbl)
        ax.set_title(f"{res} — {pre} (pbr2)", fontsize=10, fontweight="bold")
        ax.set_xlabel("Tempo GPU Real (ms)")
        ax.set_ylabel("PSNR 3D GPU (dB)\n[Ref plotada em 62 dB]")
        ax.grid(alpha=0.3)

    handles, labels = axes[0][0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="lower center", ncol=4, fontsize=8.5)
    fig.suptitle("Fronteira de Pareto em Hardware GPU Real (Tempo ms x Qualidade 3D)", fontsize=12, fontweight="bold")
    fig.tight_layout(rect=[0, 0.11, 1, 0.94])
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def plot_gpu_panel(report, frames_dir, out_path):
    req = ["linear", "nvidia_n6", "skip_pure", "adap_aniso", "adap_aniso_heatmap", "terrain_mask"]
    paths = {k: os.path.join(frames_dir, f"overview_{k}.png") for k in req}
    if not all(os.path.exists(p) for p in paths.values()):
        return

    imgs = {k: load_rgb_f64(paths[k]) for k in req if k != "terrain_mask"}
    mask = load_mask_bool(paths["terrain_mask"])

    diff = np.abs(imgs["adap_aniso"] - imgs["nvidia_n6"]) * 5.0
    diff[~mask] = 0.0
    diff = np.clip(diff, 0.0, 1.0)

    def stat_str(mid):
        r = next((row for row in report["results"] if row["resolution"] == "1080p" and row["preset"] == "overview" and row["materialMode"] == "pbr2" and row["methodId"] == mid), None)
        if not r:
            return ""
        return f" ({r['mean_ms']:.2f} ms, {r['fetches_px']:.1f} fetches/px)"

    fig, axes = plt.subplots(2, 3, figsize=(16, 9.2))
    panels = [
        (f"(a) Linear Baseline{stat_str('linear')}", imgs["linear"]),
        (f"(b) NVIDIA N=6 Ref{stat_str('nvidia_n6')}", imgs["nvidia_n6"]),
        (f"(c) Skip Puro {{0,2,4,6}}{stat_str('skip_pure')}", imgs["skip_pure"]),
        (f"(d) Adaptativo Anisotropico{stat_str('adap_aniso')}", imgs["adap_aniso"]),
        ("(e) |Adaptativo Aniso - NVIDIA Ref| x5 (terreno)", diff),
        ("(f) Heatmap TMU GPU (Vermelho=35t, Amarelo=20t, Verde=5t)", imgs["adap_aniso_heatmap"]),
    ]
    for ax, (title, im) in zip(axes.flat, panels):
        ax.imshow(np.clip(im, 0.0, 1.0))
        ax.set_title(title, fontsize=10)
        ax.axis("off")

    fig.suptitle("Frames Renderizados Diretamente na GPU WebGL 2.0 — Preset Overview (PBR 2 Camadas)", fontsize=12, fontweight="bold")
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description="Benchmark 3D 100% na GPU via WebGL 2.0 + EXT_disjoint_timer_query_webgl2")
    parser.add_argument("--outdir", default="output/benchmark_gpu")
    parser.add_argument("--quick", action="store_true", help="Executa apenas 1080p overview e grazing")
    args = parser.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    cmd = ["node", "src/gpu_bench_driver.mjs", "--outdir", args.outdir]
    if args.quick:
        cmd.append("--quick")

    subprocess.run(cmd, check=True)

    json_path = os.path.join(args.outdir, "resultados_gpu.json")
    with open(json_path, "r", encoding="utf-8") as fh:
        report = json.load(fh)

    frames_dir = os.path.join(args.outdir, "frames")
    enrich_ssim_from_gpu_frames(report, frames_dir)

    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)

    write_markdown_report(report, os.path.join(args.outdir, "tabela_resultados_gpu.md"))
    plot_gpu_1080p_vs_4k(report, os.path.join(args.outdir, "grafico_tempo_gpu_1080p_4k.png"))
    plot_pbr_scalability(report, os.path.join(args.outdir, "grafico_escalabilidade_pbr_gpu.png"))
    plot_gpu_pareto(report, os.path.join(args.outdir, "grafico_pareto_gpu_ms_qualidade.png"))
    plot_gpu_panel(report, frames_dir, os.path.join(args.outdir, "painel_gpu_3d.png"))

    print(f"[benchmark_gpu] Concluido! Artefatos salvos em '{args.outdir}/'")


if __name__ == "__main__":
    main()
