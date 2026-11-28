"""
GPU-Friendly Laplacian Texture Blending (Wronski, JCGT 2025)
Offline Reference Implementation & Experimental Comparison

Reproduces the core algorithm from Listing 1 of the paper:
'GPU Friendly Laplacian Texture Blending', Bartlomiej Wronski (2025).

Checkpoint 2 additions (``--benchmark``):
  * float32 mip pyramid (no uint8 quantization between levels);
  * level skipping (pure / hybrid), simple truncations and a
    distance-adaptive variant (2D simulation, no real perspective);
  * metrics vs. the NVIDIA 6-level reference: PSNR, SSIM, local variance,
    fetches/pixel, run time, angular error for normal maps;
  * comparison of pyramid reduction filters (BOX/BILINEAR/BICUBIC/LANCZOS).
"""

import argparse
import json
import os
import time
import numpy as np
from PIL import Image, ImageFilter


LUMA_WEIGHTS = np.array([0.2989, 0.5870, 0.1140], dtype=np.float32)


def build_mipmap_chain(img_array: np.ndarray, num_levels: int, filter_type=Image.Resampling.BILINEAR,
                       precision: str = "uint8", levels_needed=None):
    """
    Constructs a chain of mipmap levels upsampled back to full resolution,
    simulating hardware texture sampling at different LODs:
    Fup((G_k) ^ k)

    precision="uint8"  : original behavior (image quantized to 8 bits before
                         reduction). Kept for the legacy CLI outputs.
    precision="float32": each channel is reduced with PIL in mode 'F'
                         (32-bit float) using ``filter_type`` directly from
                         level 0 to (w >> k, h >> k), then upsampled back with
                         PIL 'F' BILINEAR (pixel-center aligned, like GPU
                         bilinear sampling). No quantization and no clipping,
                         so filter overshoot is preserved.
                         Used by the benchmark.

    levels_needed: optional iterable of levels to compute. If given, a dict
                   {level: array} is returned (only those levels are built).
                   Otherwise a list with levels 0..num_levels is returned.
    """
    h, w = img_array.shape[0], img_array.shape[1]

    if precision == "float32":
        arr = img_array.astype(np.float32)
        if arr.ndim == 2:
            arr = arr[:, :, np.newaxis]
        wanted = list(range(num_levels + 1)) if levels_needed is None else sorted(set(levels_needed))
        out = {}
        for lvl in wanted:
            if lvl == 0:
                out[0] = arr.copy()
                continue
            tw, th = max(1, w >> lvl), max(1, h >> lvl)
            chans = []
            for c in range(arr.shape[2]):
                ch = Image.fromarray(np.ascontiguousarray(arr[:, :, c]), mode="F")
                down = ch.resize((tw, th), resample=filter_type)
                up = down.resize((w, h), resample=Image.Resampling.BILINEAR)
                chans.append(np.asarray(up, dtype=np.float32))
            out[lvl] = np.stack(chans, axis=2)
        if levels_needed is None:
            return [out[i] for i in range(num_levels + 1)]
        return out

    arr_uint8 = (np.clip(img_array, 0, 1) * 255.0).astype(np.uint8)
    if arr_uint8.ndim == 3 and arr_uint8.shape[2] == 1:
        base_img = Image.fromarray(arr_uint8[:, :, 0], mode="L")
    else:
        base_img = Image.fromarray(arr_uint8)
    
    levels = []
    # Level 0 is the original full-resolution image
    levels.append(img_array.copy())
    
    for i in range(1, num_levels + 1):
        target_w = max(1, w >> i)
        target_h = max(1, h >> i)
        
        # Downsample to mip level
        down = base_img.resize((target_w, target_h), resample=filter_type)
        # Upsample bilinearly back to original resolution (simulating GPU texture2D with lod)
        up = down.resize((w, h), resample=Image.Resampling.BILINEAR)
        
        level_array = np.array(up, dtype=np.float32) / 255.0
        if level_array.ndim == 2:
            level_array = level_array[:, :, np.newaxis]
        levels.append(level_array)
        
    if levels_needed is not None:
        return {i: levels[i] for i in levels_needed}
    return levels


def laplacian_blend(tex0: np.ndarray, tex1: np.ndarray, mask: np.ndarray, num_levels: int = 4,
                    filter_type=Image.Resampling.BILINEAR, precision: str = "uint8", clip: bool = True):
    """
    Executes the exact algorithm from Listing 1 in Wronski (2025).
    Cost: 3 * (num_levels + 1) texture fetches per pixel.
    Defaults reproduce the original (legacy) behavior.
    """
    tex0_levels = build_mipmap_chain(tex0, num_levels, filter_type, precision)
    tex1_levels = build_mipmap_chain(tex1, num_levels, filter_type, precision)
    mask_levels = build_mipmap_chain(mask, num_levels, filter_type, precision)
    
    blended = np.zeros_like(tex0, dtype=np.float32)
    
    # Accumulate Laplacian band differences
    for i in range(num_levels):
        tex0_laplace = tex0_levels[i] - tex0_levels[i + 1]
        tex1_laplace = tex1_levels[i] - tex1_levels[i + 1]
        
        # Blend each band with corresponding mask level
        blended += tex0_laplace * (1.0 - mask_levels[i]) + tex1_laplace * mask_levels[i]
        
    # Coarsest Gaussian residual level
    tex0_gauss = tex0_levels[num_levels]
    tex1_gauss = tex1_levels[num_levels]
    blended += tex0_gauss * (1.0 - mask_levels[num_levels]) + tex1_gauss * mask_levels[num_levels]
    
    return np.clip(blended, 0.0, 1.0) if clip else blended


def _blend_selected_levels(t0L: dict, t1L: dict, mL: dict, levels: list):
    """
    Generic Laplacian blend over an ordered subset of mip levels
    L = [l0=0, l1, ..., lk]. Bands are (G_lj - G_l(j+1)) weighted by the
    mask at level lj; the residual is G_lk weighted by the mask at lk.
    With L = [0..N] this is exactly Listing 1. Telescoping sum => with a
    constant mask the result equals the input (no energy loss).
    """
    blended = np.zeros_like(t0L[0], dtype=np.float32)
    for a, b in zip(levels[:-1], levels[1:]):
        m = mL[a]
        blended += (t0L[a] - t0L[b]) * (1.0 - m) + (t1L[a] - t1L[b]) * m
    r = levels[-1]
    blended += t0L[r] * (1.0 - mL[r]) + t1L[r] * mL[r]
    return blended


def skipping_levels(num_levels: int = 6, step: int = 2, hybrid: bool = False):
    """
    Level sets used by level skipping.
      pure   : {0, step, 2*step, ..., num_levels}           -> 6,2: {0,2,4,6}
      hybrid : {0, 1, 1+step, 1+2*step, ...} (< num_levels)  -> 6,2: {0,1,3,5}
               (keeps the finest band 0-1 exact, residual at level 5).
    """
    if hybrid:
        lv = [0] + list(range(1, num_levels, step))
    else:
        lv = list(range(0, num_levels + 1, step))
        if lv[-1] != num_levels:
            lv.append(num_levels)
    return lv


def laplacian_blend_level_skipping(tex0, tex1, mask, num_levels: int = 6, step: int = 2, hybrid: bool = False,
                                   filter_type=Image.Resampling.BOX, precision: str = "float32", clip: bool = True):
    """
    Level-skipping Laplacian blend. Cost = 3 * len(levels) fetches/pixel.
    """
    lv = skipping_levels(num_levels, step, hybrid)
    t0L = build_mipmap_chain(tex0, num_levels, filter_type, precision, lv)
    t1L = build_mipmap_chain(tex1, num_levels, filter_type, precision, lv)
    mL = build_mipmap_chain(mask, num_levels, filter_type, precision, lv)
    out = _blend_selected_levels(t0L, t1L, mL, lv)
    return np.clip(out, 0.0, 1.0) if clip else out


def naive_linear_blend(tex0: np.ndarray, tex1: np.ndarray, mask: np.ndarray, clip: bool = True):
    """
    Standard pointwise linear texture blending (lerp baseline).
    Cost: 3 texture fetches per pixel.
    """
    out = tex0 * (1.0 - mask) + tex1 * mask
    return np.clip(out, 0.0, 1.0) if clip else out


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def laplacian_blend_distance_adaptive(tex0, tex1, mask, near_limit: float = 0.35, far_limit: float = 0.75,
                                      trans_band: float = 0.12, num_levels: int = 6, step: int = 2,
                                      filter_type=Image.Resampling.BOX, precision: str = "float32",
                                      clip: bool = True):
    """
    Distance-adaptive blend (2D SIMULATION: no real perspective/LOD).
    dist = 0 at the bottom row (near) and 1 at the top row (far).
      full (NVIDIA N levels)  -> level skipping (pure) -> linear
    Transitions are smoothstep bands of width ``trans_band`` centered at
    near_limit and far_limit.
    Returns (image, cost_map_sum, cost_map_union, weights):
      cost_map_sum   : fetches/pixel assuming each active regime is evaluated
                       independently (transition = sum of both regimes).
      cost_map_union : fetches/pixel if fetches shared between regimes are
                       reused (skip levels are a subset of full levels and
                       linear uses only level 0) -> max of active regimes.
    """
    h, w = tex0.shape[:2]
    dist = 1.0 - (np.arange(h, dtype=np.float32) / max(1, h - 1))
    dist = np.repeat(dist[:, None], w, axis=1)
    hb = trans_band / 2.0
    w_full = 1.0 - smoothstep(near_limit - hb, near_limit + hb, dist)
    w_lin = smoothstep(far_limit - hb, far_limit + hb, dist)
    w_skip = np.clip(1.0 - w_full - w_lin, 0.0, 1.0)

    all_lv = list(range(num_levels + 1))
    t0L = build_mipmap_chain(tex0, num_levels, filter_type, precision, all_lv)
    t1L = build_mipmap_chain(tex1, num_levels, filter_type, precision, all_lv)
    mL = build_mipmap_chain(mask, num_levels, filter_type, precision, all_lv)
    skip_lv = skipping_levels(num_levels, step, False)

    full = _blend_selected_levels(t0L, t1L, mL, all_lv)
    skip = _blend_selected_levels(t0L, t1L, mL, skip_lv)
    lin = tex0 * (1.0 - mask) + tex1 * mask

    out = w_full[..., None] * full + w_skip[..., None] * skip + w_lin[..., None] * lin

    eps = 1e-6
    c_full, c_skip, c_lin = 3 * len(all_lv), 3 * len(skip_lv), 3
    a_full, a_skip, a_lin = w_full > eps, w_skip > eps, w_lin > eps
    cost_sum = a_full * c_full + a_skip * c_skip + a_lin * c_lin
    cost_union = np.maximum.reduce([a_full * c_full, a_skip * c_skip, a_lin * c_lin])
    weights = {"full": w_full, "skip": w_skip, "linear": w_lin}
    out = np.clip(out, 0.0, 1.0) if clip else out
    return out, cost_sum.astype(np.float32), cost_union.astype(np.float32), weights


def local_variance(img_gray: np.ndarray, kernel_size: int = 7):
    """
    Computes local patch variance as a proxy for contrast/texture detail preservation.
    """
    from scipy.ndimage import uniform_filter
    mean = uniform_filter(img_gray, size=kernel_size)
    mean_sq = uniform_filter(img_gray ** 2, size=kernel_size)
    var = mean_sq - mean ** 2
    return np.maximum(var, 0.0)


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def to_luma(img):
    return np.dot(img[..., :3], LUMA_WEIGHTS).astype(np.float64)


def psnr(a, b):
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    if mse == 0:
        return float("inf")
    return 10.0 * np.log10(1.0 / mse)


def ssim_luma(a, b, sigma=1.5):
    """
    SSIM (Wang et al. 2004) on Rec.601 luminance, data range 1.0,
    Gaussian window sigma=1.5 (truncate=3.5 -> 11x11), C1=(0.01)^2, C2=(0.03)^2.
    """
    from scipy.ndimage import gaussian_filter
    x, y = to_luma(a), to_luma(b)
    g = lambda z: gaussian_filter(z, sigma, truncate=3.5)
    C1, C2 = 0.01 ** 2, 0.03 ** 2
    mx, my = g(x), g(y)
    sxx = g(x * x) - mx * mx
    syy = g(y * y) - my * my
    sxy = g(x * y) - mx * my
    s = ((2 * mx * my + C1) * (2 * sxy + C2)) / ((mx * mx + my * my + C1) * (sxx + syy + C2))
    return float(np.mean(s))


def mean_local_var(img, region):
    return float(np.mean(local_variance(to_luma(img))[region]))


def decode_normals(enc):
    n = enc[..., :3].astype(np.float64) * 2.0 - 1.0
    norm = np.linalg.norm(n, axis=2, keepdims=True)
    return n / np.maximum(norm, 1e-8)


def angular_error_deg(enc_a, enc_b):
    na, nb = decode_normals(enc_a), decode_normals(enc_b)
    d = np.clip(np.sum(na * nb, axis=2), -1.0, 1.0)
    return float(np.mean(np.degrees(np.arccos(d))))


def overshoot_pct(raw):
    bad = np.any((raw < 0.0) | (raw > 1.0), axis=2)
    return float(np.mean(bad) * 100.0)


# ---------------------------------------------------------------------------
# Benchmark
# ---------------------------------------------------------------------------

def load_rgb(path, size=None):
    img = Image.open(path).convert("RGB")
    if size is not None and img.size != size:
        img = img.resize(size, Image.Resampling.BILINEAR)
    return np.array(img, dtype=np.float32) / 255.0


def make_mask(spec, w, h):
    """Same mask rules as the legacy CLI (perlin: threshold 0.55, gain 8)."""
    if spec == "linear":
        x = np.linspace(0, 1, w, dtype=np.float32)
        return np.tile(x, (h, 1))[:, :, np.newaxis]
    mask_img = Image.open(spec).convert("L").resize((w, h), Image.Resampling.BILINEAR)
    raw_mask = np.array(mask_img, dtype=np.float32) / 255.0
    threshold = 0.55
    return np.clip((raw_mask - threshold) * 8.0 + 0.5, 0.0, 1.0)[:, :, np.newaxis]


def _timed(fn, reps):
    times = []
    out = None
    for _ in range(reps):
        t = time.perf_counter()
        out = fn()
        times.append(time.perf_counter() - t)
    return out, float(np.mean(times) * 1000.0), float(np.std(times) * 1000.0)


def _finish_normal(raw):
    """Decode [0,1]->[-1,1], renormalize, re-encode to [0,1]."""
    return (decode_normals(raw) * 0.5 + 0.5).astype(np.float32)


def run_case(name, t0, t1, mask, reps, is_normal=False, levels=6, keep_images=False):
    F = Image.Resampling.BOX
    P = "float32"
    lv_skip = skipping_levels(levels, 2, False)
    lv_hyb = skipping_levels(levels, 2, True)

    methods = [
        ("Linear", lambda: naive_linear_blend(t0, t1, mask, clip=False), 3.0),
        ("NVIDIA N=3 (trunc)", lambda: laplacian_blend(t0, t1, mask, 3, F, P, clip=False), 12.0),
        ("NVIDIA N=4 (trunc)", lambda: laplacian_blend(t0, t1, mask, 4, F, P, clip=False), 15.0),
        ("NVIDIA N=5 (trunc)", lambda: laplacian_blend(t0, t1, mask, 5, F, P, clip=False), 18.0),
        ("NVIDIA N=6 (ref)", lambda: laplacian_blend(t0, t1, mask, levels, F, P, clip=False), 3.0 * (levels + 1)),
        ("Skip puro " + str(set(lv_skip)),
         lambda: laplacian_blend_level_skipping(t0, t1, mask, levels, 2, False, F, P, clip=False), 3.0 * len(lv_skip)),
        ("Skip hibrido " + str(set(lv_hyb)),
         lambda: laplacian_blend_level_skipping(t0, t1, mask, levels, 2, True, F, P, clip=False), 3.0 * len(lv_hyb)),
        ("Adaptativo (dist)", lambda: laplacian_blend_distance_adaptive(t0, t1, mask, num_levels=levels,
                                                                         filter_type=F, precision=P, clip=False), None),
    ]

    raws, rows = {}, []
    extra = {}
    for mname, fn, cost in methods:
        out, t_ms, t_sd = _timed(fn, reps)
        if mname.startswith("Adaptativo"):
            raw, cmap_sum, cmap_union, weights = out
            cost = float(np.mean(cmap_sum))
            extra = {"cost_map_sum": cmap_sum, "cost_map_union": cmap_union,
                     "cost_union_mean": float(np.mean(cmap_union)), "weights": weights}
        else:
            raw = out
        raws[mname] = (raw, cost, t_ms, t_sd)

    region = (mask[:, :, 0] > 0.05) & (mask[:, :, 0] < 0.95)
    final = {k: (_finish_normal(v[0]) if is_normal else np.clip(v[0], 0, 1)) for k, v in raws.items()}
    ref = final["NVIDIA N=6 (ref)"]
    var_ref = mean_local_var(ref, region)
    var_lin = mean_local_var(final["Linear"], region)
    cost_ref = raws["NVIDIA N=6 (ref)"][1]

    for mname, (raw, cost, t_ms, t_sd) in raws.items():
        img = final[mname]
        v = mean_local_var(img, region)
        row = {
            "metodo": mname,
            "fetches_px": cost,
            "reducao_fetches_pct": (1.0 - cost / cost_ref) * 100.0,
            "psnr_db": psnr(img, ref),
            "ssim": ssim_luma(img, ref),
            "var_local": v,
            "ret_var_vs_ref_pct": v / var_ref * 100.0 if var_ref > 0 else None,
            "ret_var_vs_linear_pct": v / var_lin * 100.0 if var_lin > 0 else None,
            "tempo_ms": t_ms,
            "tempo_std_ms": t_sd,
            "overshoot_pct": overshoot_pct(raw),
        }
        if is_normal:
            row["erro_angular_medio_graus"] = angular_error_deg(img, ref)
        rows.append(row)

    res = {
        "caso": name,
        "resolucao": [int(t0.shape[1]), int(t0.shape[0])],
        "pixels_zona_transicao": int(np.count_nonzero(region)),
        "pct_zona_transicao": float(np.mean(region) * 100.0),
        "normal_map": is_normal,
        "adaptativo_custo_medio_union": extra.get("cost_union_mean"),
        "metodos": rows,
    }
    if keep_images:
        res["_images"] = final
        res["_extra"] = extra
    return res


def run_filter_study(t0, t1, mask, reps, levels=6):
    filters = [("BOX", Image.Resampling.BOX), ("BILINEAR", Image.Resampling.BILINEAR),
               ("BICUBIC", Image.Resampling.BICUBIC), ("LANCZOS", Image.Resampling.LANCZOS)]
    region = (mask[:, :, 0] > 0.05) & (mask[:, :, 0] < 0.95)
    lin = np.clip(naive_linear_blend(t0, t1, mask), 0, 1)
    var_lin = mean_local_var(lin, region)
    outs = {}
    for fname, f in filters:
        raw, t_ms, t_sd = _timed(lambda: laplacian_blend(t0, t1, mask, levels, f, "float32", clip=False), reps)
        outs[fname] = (raw, t_ms, t_sd)
    ref_box = np.clip(outs["BOX"][0], 0, 1)
    rows = []
    for fname, (raw, t_ms, t_sd) in outs.items():
        img = np.clip(raw, 0, 1)
        v = mean_local_var(img, region)
        rows.append({
            "filtro": fname,
            "var_local": v,
            "ret_var_vs_linear_pct": v / var_lin * 100.0,
            "psnr_vs_box_db": psnr(img, ref_box),
            "ssim_vs_box": ssim_luma(img, ref_box),
            "overshoot_pct": overshoot_pct(raw),
            "min_antes_clip": float(raw.min()),
            "max_antes_clip": float(raw.max()),
            "tempo_ms": t_ms,
        })
    return {"var_local_linear": var_lin, "filtros": rows}


def _fmt(x, nd=2):
    if x is None:
        return "-"
    if isinstance(x, float) and np.isinf(x):
        return "inf"
    return f"{x:.{nd}f}"


def write_markdown(results, filt, path, reps):
    L = []
    L.append("# Resultados — Checkpoint 2 (gerado por `src/laplacian_blend.py --benchmark`)\n")
    L.append("## Configuração\n")
    L.append("- Pirâmide em **float32**: cada canal é reduzido com PIL modo `'F'` diretamente do nível 0 para "
             "(w>>k, h>>k) com o filtro indicado e re-amostrado com BILINEAR `'F'` para a resolução cheia "
             "(simula `texture2DLod` com filtragem bilinear). Sem quantização para uint8 e sem clip entre níveis.")
    L.append("- Referência: NVIDIA (Listing 1) com N=6 níveis, filtro de redução **BOX** (equivale a mip 2x2 box em cascata para dimensões potência de 2).")
    L.append("- PSNR em RGB (faixa 1.0). SSIM em **luminância Rec.601** (0.2989, 0.5870, 0.1140), janela gaussiana σ=1.5 (11x11), C1=(0.01)², C2=(0.03)².")
    L.append("- Variância local: janela 7x7 sobre luminância, média na zona de transição (0.05 < máscara < 0.95).")
    L.append("- Custo: 3 fetches (tex0, tex1, máscara) por nível amostrado. Skip puro = {0,2,4,6}; skip híbrido = {0,1,3,5} (resíduo no nível 5).")
    L.append("- Adaptativo: **simulação 2D** (sem perspectiva real). dist = 0 na base, 1 no topo; completo → skip puro → linear com "
             "smoothstep (near=0.35, far=0.75, banda=0.12). Custo nas faixas de transição = soma dos dois regimes "
             "(coluna `fetches/px`); o custo com reuso de fetches compartilhados (union) é informado abaixo de cada tabela.")
    L.append(f"- Tempo: média de {reps} repetições em CPU (numpy/PIL). **Não representa custo em GPU**; o adaptativo calcula tudo em tela cheia.")
    L.append("- Normais: blend sobre a codificação [0,1], depois decodifica para [-1,1], renormaliza e re-codifica; erro angular médio vs. referência.\n")
    for r in results:
        L.append(f"## Caso: {r['caso']}\n")
        L.append(f"Resolução {r['resolucao'][0]}x{r['resolucao'][1]}; zona de transição: {r['pixels_zona_transicao']} px "
                 f"({r['pct_zona_transicao']:.1f}%).\n")
        hdr = "| Método | fetches/px | Redução vs ref (%) | PSNR (dB) | SSIM | Var. local | Ret. vs ref (%) | Ret. vs linear (%) | Overshoot (%) | Tempo (ms) |"
        sep = "|---|---|---|---|---|---|---|---|---|---|"
        if r["normal_map"]:
            hdr += " Erro angular (°) |"
            sep += "---|"
        L.append(hdr)
        L.append(sep)
        for m in r["metodos"]:
            line = (f"| {m['metodo']} | {_fmt(m['fetches_px'])} | {_fmt(m['reducao_fetches_pct'],1)} | {_fmt(m['psnr_db'])} | "
                    f"{_fmt(m['ssim'],4)} | {m['var_local']:.6f} | {_fmt(m['ret_var_vs_ref_pct'],1)} | "
                    f"{_fmt(m['ret_var_vs_linear_pct'],1)} | {_fmt(m['overshoot_pct'],3)} | {_fmt(m['tempo_ms'],1)} |")
            if r["normal_map"]:
                line += f" {_fmt(m['erro_angular_medio_graus'],3)} |"
            L.append(line)
        L.append(f"\nAdaptativo — custo médio com reuso de fetches (union): {_fmt(r['adaptativo_custo_medio_union'])} fetches/px.\n")
    L.append("## Filtros de redução da pirâmide (caso a, NVIDIA N=6, float32)\n")
    L.append("PSNR/SSIM medidos contra o resultado com filtro BOX. Overshoot = % de pixels com algum canal < 0 ou > 1 antes do clip.\n")
    L.append(f"Variância local do blend linear (mesma zona): {filt['var_local_linear']:.6f}\n")
    L.append("| Filtro | Var. local | Ret. vs linear (%) | PSNR vs BOX (dB) | SSIM vs BOX | Overshoot (%) | min | max | Tempo (ms) |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    for f in filt["filtros"]:
        L.append(f"| {f['filtro']} | {f['var_local']:.6f} | {_fmt(f['ret_var_vs_linear_pct'],1)} | {_fmt(f['psnr_vs_box_db'])} | "
                 f"{_fmt(f['ssim_vs_box'],4)} | {_fmt(f['overshoot_pct'],3)} | {f['min_antes_clip']:.4f} | "
                 f"{f['max_antes_clip']:.4f} | {_fmt(f['tempo_ms'],1)} |")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L) + "\n")


def save_comparison_figure(case, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap, BoundaryNorm

    imgs = case["_images"]
    extra = case["_extra"]
    skip_key = [k for k in imgs if k.startswith("Skip puro")][0]
    adap = imgs["Adaptativo (dist)"]
    ref = imgs["NVIDIA N=6 (ref)"]
    diff = np.clip(np.abs(adap - ref) * 5.0, 0, 1)
    cost = extra["cost_map_sum"]

    fig, axes = plt.subplots(2, 3, figsize=(15, 10.5))
    panels = [("(a) Linear (3 fetches/px)", imgs["Linear"]),
              ("(b) NVIDIA N=6 (21 fetches/px)", ref),
              (f"(c) {skip_key} (12 fetches/px)", imgs[skip_key]),
              (f"(d) Adaptativo (média {np.mean(cost):.2f} fetches/px)", adap),
              ("(e) |Adaptativo − NVIDIA| ×5", diff)]
    for ax, (t, im) in zip(axes.flat, panels):
        ax.imshow(np.clip(im, 0, 1))
        ax.set_title(t, fontsize=10)
        ax.axis("off")
    vals = sorted(set(np.unique(cost).tolist()))
    cmap = plt.get_cmap("RdYlGn_r")
    ax = axes.flat[5]
    vmax = max(vals)
    im = ax.imshow(cost, cmap=cmap, vmin=0, vmax=vmax)
    ax.set_title("(f) Mapa de custo (fetches/px)\nverde=barato, vermelho=caro", fontsize=10)
    ax.axis("off")
    cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    cb.set_ticks(vals)
    fig.suptitle(f"Checkpoint 2 — caso: {case['caso']}  |  Adaptativo = SIMULAÇÃO 2D (dist: base=perto, topo=longe; sem perspectiva real)",
                 fontsize=11)
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)


def save_pareto(results, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    n = len(results)
    fig, axes = plt.subplots(2, n, figsize=(5 * n, 9), squeeze=False)
    markers = ["o", "s", "^", "v", "D", "P", "X", "*"]
    for j, r in enumerate(results):
        for k, m in enumerate(r["metodos"]):
            for i, key in enumerate(["ssim", "ret_var_vs_ref_pct"]):
                ax = axes[i][j]
                ax.scatter(m["fetches_px"], m[key], marker=markers[k % len(markers)], s=70,
                           label=m["metodo"] if (i == 0) else None)
        axes[0][j].set_title(r["caso"], fontsize=10)
        axes[0][j].set_ylabel("SSIM vs NVIDIA N=6")
        axes[1][j].set_ylabel("Retenção de variância local vs ref (%)")
        for i in range(2):
            axes[i][j].set_xlabel("fetches / pixel")
            axes[i][j].grid(alpha=0.3)
    handles, labels = axes[0][0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="lower center", ncol=4, fontsize=9)
    fig.suptitle("Curva custo × qualidade (um ponto por método; referência = NVIDIA N=6, BOX, float32)", fontsize=11)
    fig.tight_layout(rect=[0, 0.06, 1, 0.96])
    fig.savefig(path, dpi=110)
    plt.close(fig)


def run_benchmark(outdir, reps=5, levels=6):
    os.makedirs(outdir, exist_ok=True)
    d = "demo_webgl"
    cases_spec = [
        ("(a) 1+2, perlin", f"{d}/1.jpg", f"{d}/2.jpg", f"{d}/perlin.jpg", False),
        ("(b) 1rot+2rot, perlin", f"{d}/1rot.jpg", f"{d}/2rot.jpg", f"{d}/perlin.jpg", False),
        ("(c1) normal0+normal1, linear", f"{d}/normal0.jpg", f"{d}/normal1.jpg", "linear", True),
        ("(c2) normal0+normal1, perlin", f"{d}/normal0.jpg", f"{d}/normal1.jpg", f"{d}/perlin.jpg", True),
    ]
    results = []
    first = None
    filt = None
    for name, p0, p1, pm, is_n in cases_spec:
        print(f"[benchmark] caso {name} ...", flush=True)
        t0 = load_rgb(p0)
        h, w = t0.shape[:2]
        t1 = load_rgb(p1, (w, h))
        mask = make_mask(pm, w, h)
        r = run_case(name, t0, t1, mask, reps, is_normal=is_n, levels=levels, keep_images=(first is None))
        if first is None:
            first = r
            print("[benchmark] estudo de filtros (caso a) ...", flush=True)
            filt = run_filter_study(t0, t1, mask, reps, levels)
        results.append(r)

    save_comparison_figure(first, os.path.join(outdir, "comparativo_checkpoint2.png"))
    save_pareto(results, os.path.join(outdir, "curva_pareto_custo_qualidade.png"))

    clean = []
    for r in results:
        clean.append({k: v for k, v in r.items() if not k.startswith("_")})
    payload = {
        "config": {
            "referencia": "NVIDIA Listing 1, N=6, filtro BOX, piramide float32",
            "piramide": "float32: PIL modo 'F' por canal, reducao direta nivel 0 -> (w>>k,h>>k) com o filtro, "
                        "upsample BILINEAR 'F' para resolucao cheia; sem quantizacao nem clip entre niveis",
            "ssim": "luminancia Rec.601, gaussiana sigma=1.5 (11x11), C1=0.01^2, C2=0.03^2, faixa 1.0",
            "psnr": "RGB, faixa 1.0",
            "variancia_local": "janela 7x7 em luminancia, media na zona 0.05<mask<0.95",
            "custo": "3 fetches por nivel amostrado; skip puro {0,2,4,6}; skip hibrido {0,1,3,5} (residuo no 5)",
            "adaptativo": "SIMULACAO 2D sem perspectiva real; dist=0 base (perto), 1 topo (longe); near=0.35, far=0.75, "
                          "banda=0.12; fetches_px = soma dos regimes nas transicoes; union = reuso de fetches",
            "mascara_perlin": "clip((raw-0.55)*8+0.5, 0, 1)",
            "normais": "blend na codificacao [0,1]; decodifica [-1,1], renormaliza; erro angular medio vs ref",
            "repeticoes_tempo": reps,
            "tempo_obs": "CPU numpy/PIL; nao representa custo em GPU",
        },
        "casos": clean,
        "filtros_caso_a": filt,
    }
    with open(os.path.join(outdir, "resultados_checkpoint2.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
    write_markdown(clean, filt, os.path.join(outdir, "tabela_resultados.md"), reps)
    print(f"[benchmark] arquivos salvos em '{outdir}/'")
    return payload


def main():
    parser = argparse.ArgumentParser(description="GPU-Friendly Laplacian Texture Blending (Reference Runner)")
    parser.add_argument("--tex0", default="demo_webgl/1.jpg", help="Path to Texture 0")
    parser.add_argument("--tex1", default="demo_webgl/2.jpg", help="Path to Texture 1")
    parser.add_argument("--mask", default="demo_webgl/perlin.jpg", help="Path to mask or 'linear'")
    parser.add_argument("--levels", type=int, default=4, help="Number of Laplacian levels (default: 4)")
    parser.add_argument("--outdir", default="output", help="Output directory")
    parser.add_argument("--benchmark", action="store_true",
                        help="Run the full Checkpoint 2 suite (fixed test cases, 6 levels)")
    parser.add_argument("--reps", type=int, default=5, help="Timing repetitions for --benchmark (default: 5)")
    args = parser.parse_args()

    os.makedirs(args.outdir, exist_ok=True)

    if args.benchmark:
        run_benchmark(args.outdir, reps=args.reps, levels=6)
        return

    # 1. Load textures
    img0 = Image.open(args.tex0).convert("RGB")
    img1 = Image.open(args.tex1).convert("RGB").resize(img0.size, Image.Resampling.BILINEAR)
    w, h = img0.size

    # Load or generate mask
    if args.mask == "linear":
        x = np.linspace(0, 1, w, dtype=np.float32)
        mask_arr = np.tile(x, (h, 1))[:, :, np.newaxis]
    else:
        mask_img = Image.open(args.mask).convert("L").resize((w, h), Image.Resampling.BILINEAR)
        raw_mask = np.array(mask_img, dtype=np.float32) / 255.0
        # Sigmoid/threshold similar to demo shader for organic transition boundary
        threshold = 0.55
        mask_arr = np.clip((raw_mask - threshold) * 8.0 + 0.5, 0.0, 1.0)[:, :, np.newaxis]

    t0_arr = np.array(img0, dtype=np.float32) / 255.0
    t1_arr = np.array(img1, dtype=np.float32) / 255.0

    print("=================================================================")
    print("  GPU-Friendly Laplacian Texture Blending - Verificação")
    print("=================================================================")
    print(f"Textura 0: {args.tex0} ({w}x{h})")
    print(f"Textura 1: {args.tex1} ({w}x{h})")
    print(f"Níveis Laplacianos: {args.levels}")

    # 2. Computar blends
    print("\nExecutando Linear Blend (Baseline)...")
    linear_res = naive_linear_blend(t0_arr, t1_arr, mask_arr)

    print(f"Executando Laplacian Texture Blend ({args.levels} níveis)...")
    laplacian_res = laplacian_blend(t0_arr, t1_arr, mask_arr, num_levels=args.levels)

    # 3. Métricas quantitativas de preservação de detalhe na zona de transição
    # Transição é onde a máscara está entre 0.05 e 0.95
    blend_region = (mask_arr[:, :, 0] > 0.05) & (mask_arr[:, :, 0] < 0.95)
    
    # Converter para escala de cinza para medir variância local (detalhes/contraste)
    lin_gray = np.dot(linear_res[..., :3], [0.2989, 0.5870, 0.1140])
    lap_gray = np.dot(laplacian_res[..., :3], [0.2989, 0.5870, 0.1140])
    
    var_lin = np.mean(local_variance(lin_gray)[blend_region])
    var_lap = np.mean(local_variance(lap_gray)[blend_region])
    contrast_retention = (var_lap / var_lin) * 100.0 if var_lin > 0 else 100.0

    print("\n--- Resultados Quantitativos na Zona de Transição ---")
    print(f"Pixels na zona de transição: {np.count_nonzero(blend_region)} ({np.mean(blend_region)*100:.1f}% da imagem)")
    print(f"Variância local média - Linear Blend:    {var_lin:.6f}")
    print(f"Variância local média - Laplacian Blend: {var_lap:.6f}")
    print(f"Ganho relativo de preservação de contraste/detalhe: {contrast_retention:.1f}%")

    # 4. Salvar saídas
    p_lin = os.path.join(args.outdir, "blend_linear_baseline.png")
    p_lap = os.path.join(args.outdir, f"blend_laplacian_{args.levels}levels.png")
    p_mask = os.path.join(args.outdir, "mask_used.png")

    Image.fromarray((linear_res * 255.0).astype(np.uint8)).save(p_lin)
    Image.fromarray((laplacian_res * 255.0).astype(np.uint8)).save(p_lap)
    Image.fromarray((np.repeat(mask_arr, 3, axis=2) * 255.0).astype(np.uint8)).save(p_mask)

    # 5. Criar montagem comparativa (Grid)
    # Linha 1: Tex0, Mascara, Tex1
    # Linha 2: Linear Baseline, Laplacian Blend, Mapa de Diferença Absoluta (|Lap - Lin| * 3x)
    thumb_w, thumb_h = w // 2, h // 2
    def thumb(arr):
        return Image.fromarray((np.clip(arr, 0, 1) * 255.0).astype(np.uint8)).resize((thumb_w, thumb_h), Image.Resampling.BILINEAR)

    diff = np.abs(laplacian_res - linear_res) * 4.0  # amplificado 4x para visualização
    
    grid = Image.new("RGB", (thumb_w * 3, thumb_h * 2), (25, 25, 25))
    grid.paste(thumb(t0_arr), (0, 0))
    grid.paste(thumb(np.repeat(mask_arr, 3, axis=2)), (thumb_w, 0))
    grid.paste(thumb(t1_arr), (thumb_w * 2, 0))

    grid.paste(thumb(linear_res), (0, thumb_h))
    grid.paste(thumb(laplacian_res), (thumb_w, thumb_h))
    grid.paste(thumb(diff), (thumb_w * 2, thumb_h))

    p_grid = os.path.join(args.outdir, "comparativo_completo.png")
    grid.save(p_grid)

    print(f"\nImagens salvas em '{args.outdir}/':")
    print(f" - {p_lin}")
    print(f" - {p_lap}")
    print(f" - {p_mask}")
    print(f" - {p_grid}")
    print("\nExecução e comprovação da Regra de Viabilidade Inicial concluídas com sucesso!")


if __name__ == "__main__":
    main()
