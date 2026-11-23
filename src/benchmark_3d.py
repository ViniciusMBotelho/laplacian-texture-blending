#!/usr/bin/env python3
"""
Pipeline Quantitativo em Perspectiva 3D Real (float32)
Reproduz com exatidao a geometria, cameras, texturas, estimador de LOD anisotropico
e modos de mesclagem do ambiente WebGL 2.0 (demo_webgl/).

Gera em output/benchmark_3d/:
  - resultados_3d.json
  - tabela_resultados_3d.md
  - comparativo_3d_overview.png
  - comparativo_3d_grazing.png
  - curva_pareto_3d.png
  - analise_2d_vs_3d.png
"""

import argparse
import json
import os
import time
import numpy as np
from PIL import Image
from scipy.ndimage import binary_erosion, gaussian_filter, uniform_filter

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

TERRAIN_SIZE = 400.0
TILE_SIZE = 10.0
TEX_RES = 1024.0
FOV_DEG = 50.0
SUN_DIR = np.array([0.45, 0.72, 0.52], dtype=np.float32)
SUN_DIR /= np.linalg.norm(SUN_DIR)
FOG_COLOR = np.array([0x9B / 255.0, 0xB4 / 255.0, 0xCC / 255.0], dtype=np.float32)
FOG_DENSITY = 0.0028
LUMA_WEIGHTS = np.array([0.2989, 0.5870, 0.1140], dtype=np.float32)


def terrain_height(x, z):
    return (
        2.8 * np.sin(x * 0.045) * np.cos(z * 0.045)
        + 4.5 * np.sin(x * 0.018 + z * 0.015)
        + 1.1 * np.cos(x * 0.11 - z * 0.09)
        + 0.35 * np.sin(x * 0.24 + z * 0.21)
    )


def terrain_normal(x, z):
    dhdx = (
        2.8 * 0.045 * np.cos(x * 0.045) * np.cos(z * 0.045)
        + 4.5 * 0.018 * np.cos(x * 0.018 + z * 0.015)
        - 1.1 * 0.11 * np.sin(x * 0.11 - z * 0.09)
        + 0.35 * 0.24 * np.cos(x * 0.24 + z * 0.21)
    )
    dhdz = (
        -2.8 * 0.045 * np.sin(x * 0.045) * np.sin(z * 0.045)
        + 4.5 * 0.015 * np.cos(x * 0.018 + z * 0.015)
        + 1.1 * 0.09 * np.sin(x * 0.11 - z * 0.09)
        + 0.35 * 0.21 * np.cos(x * 0.24 + z * 0.21)
    )
    n = np.stack([-dhdx, np.ones_like(dhdx), -dhdz], axis=-1)
    n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-8)
    return n.astype(np.float32)


def get_camera_presets():
    def h(x, z):
        return float(terrain_height(np.float64(x), np.float64(z)))

    return {
        "overview": {
            "label": "Panoramica (3 Zonas)",
            "pos": np.array([0.0, h(0.0, 60.0) + 14.0, 60.0], dtype=np.float64),
            "target": np.array([0.0, h(0.0, -60.0) + 1.0, -60.0], dtype=np.float64),
        },
        "grazing": {
            "label": "Angulo Rasante (Anisotropia)",
            "pos": np.array([-20.0, h(-20.0, 75.0) + 2.6, 75.0], dtype=np.float64),
            "target": np.array([10.0, h(10.0, -80.0) + 2.0, -80.0], dtype=np.float64),
        },
        "closeup": {
            "label": "Close-Up (Detalhes PBR)",
            "pos": np.array([12.0, h(12.0, 18.0) + 3.8, 18.0], dtype=np.float64),
            "target": np.array([12.0, h(12.0, 8.0) + 0.2, 8.0], dtype=np.float64),
        },
        "aerial": {
            "label": "Vista Aerea (Macro)",
            "pos": np.array([-55.0, h(-55.0, 85.0) + 48.0, 85.0], dtype=np.float64),
            "target": np.array([15.0, h(15.0, -25.0), -25.0], dtype=np.float64),
        },
    }


def render_sky_background(ray_dir):
    h = np.clip(ray_dir[..., 1], 0.0, 1.0)
    top_col = np.array([0x1B / 255.0, 0x33 / 255.0, 0x56 / 255.0], dtype=np.float32)
    hor_col = FOG_COLOR
    t = (h ** 0.55)[..., None]
    sky = hor_col * (1.0 - t) + top_col * t
    sun_glow = (np.maximum(np.sum(ray_dir * SUN_DIR, axis=-1), 0.0) ** 48.0)[..., None]
    sky += np.array([1.0, 0.93, 0.80], dtype=np.float32) * sun_glow * 0.35
    return np.clip(sky, 0.0, 1.0).astype(np.float32)


def trace_terrain_gbuffer(cam_pos, cam_target, width, height, max_aniso=8.0):
    """
    Vectorized ray-heightfield intersection + analytical screen-space Jacobian UV differentials.
    """
    fwd = cam_target - cam_pos
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, np.array([0.0, 1.0, 0.0], dtype=np.float64))
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)

    tan_half = np.tan(np.radians(FOV_DEG) * 0.5)
    aspect = float(width) / float(height)

    xs = (np.arange(width, dtype=np.float64) + 0.5) / width * 2.0 - 1.0
    ys = 1.0 - (np.arange(height, dtype=np.float64) + 0.5) / height * 2.0
    gx, gy = np.meshgrid(xs, ys)

    raw_ray = (
        fwd[None, None, :]
        + right[None, None, :] * (gx[..., None] * aspect * tan_half)
        + up[None, None, :] * (gy[..., None] * tan_half)
    )
    raw_len = np.linalg.norm(raw_ray, axis=-1, keepdims=True)
    ray_dir = raw_ray / raw_len

    y_min, y_max = -9.0, 9.0
    oy = cam_pos[1]
    dy = ray_dir[..., 1]

    t_near = np.full((height, width), 0.2, dtype=np.float64)
    t_far = np.full((height, width), 380.0, dtype=np.float64)

    # Slab intersection with [y_min, y_max]
    safe_dy = np.where(np.abs(dy) < 1e-7, 1e-7, dy)
    t_ymin = (y_min - oy) / safe_dy
    t_ymax = (y_max - oy) / safe_dy
    t_lo = np.minimum(t_ymin, t_ymax)
    t_hi = np.maximum(t_ymin, t_ymax)

    parallel_outside = (np.abs(dy) < 1e-7) & ((oy < y_min) | (oy > y_max))
    t_near = np.where(np.abs(dy) >= 1e-7, np.maximum(t_near, t_lo), t_near)
    t_far = np.where(np.abs(dy) >= 1e-7, np.minimum(t_far, t_hi), t_far)
    valid_slab = (~parallel_outside) & (t_far > t_near)

    idx_y, idx_x = np.nonzero(valid_slab)
    m = len(idx_x)
    rd_m = ray_dir[idx_y, idx_x]
    tn_m = t_near[idx_y, idx_x]
    tf_m = t_far[idx_y, idx_x]

    # Nonlinear stepping concentrates samples near the camera to catch grazing hills
    n_steps = 96
    s_grid = np.linspace(0.0, 1.0, n_steps, dtype=np.float64) ** 1.55
    prev_t = tn_m.copy()
    hit_m = np.zeros(m, dtype=bool)
    lo_t = np.zeros(m, dtype=np.float64)
    hi_t = np.zeros(m, dtype=np.float64)

    half_size = TERRAIN_SIZE * 0.5
    ox, oz = cam_pos[0], cam_pos[2]
    rdx, rdy, rdz = rd_m[:, 0], rd_m[:, 1], rd_m[:, 2]

    for k in range(1, n_steps):
        cur_t = tn_m + (tf_m - tn_m) * s_grid[k]
        px = ox + cur_t * rdx
        py = oy + cur_t * rdy
        pz = oz + cur_t * rdz
        in_box = (np.abs(px) <= half_size) & (np.abs(pz) <= half_size)
        h_val = terrain_height(px, pz)
        crossed = (~hit_m) & in_box & (py <= h_val)
        if np.any(crossed):
            hit_m[crossed] = True
            lo_t[crossed] = prev_t[crossed]
            hi_t[crossed] = cur_t[crossed]
        prev_t = cur_t

    # 7-iteration bisection on crossed intervals
    h_idx = np.nonzero(hit_m)[0]
    a = lo_t[h_idx]
    b = hi_t[h_idx]
    r_h = rd_m[h_idx]
    for _ in range(7):
        mid = 0.5 * (a + b)
        px = ox + mid * r_h[:, 0]
        py = oy + mid * r_h[:, 1]
        pz = oz + mid * r_h[:, 2]
        below = py <= terrain_height(px, pz)
        b = np.where(below, mid, b)
        a = np.where(below, a, mid)

    t_hit = 0.5 * (a + b)
    px = ox + t_hit * r_h[:, 0]
    py = oy + t_hit * r_h[:, 1]
    pz = oz + t_hit * r_h[:, 2]
    in_bounds = (np.abs(px) <= half_size) & (np.abs(pz) <= half_size)

    hit = np.zeros((height, width), dtype=bool)
    world_pos = np.zeros((height, width, 3), dtype=np.float32)
    world_norm = np.zeros((height, width, 3), dtype=np.float32)
    depth_map = np.zeros((height, width), dtype=np.float32)
    uv = np.zeros((height, width, 2), dtype=np.float32)

    gy_h = idx_y[h_idx[in_bounds]]
    gx_h = idx_x[h_idx[in_bounds]]
    px_v = px[in_bounds]
    py_v = py[in_bounds]
    pz_v = pz[in_bounds]
    t_v = t_hit[in_bounds]

    hit[gy_h, gx_h] = True
    world_pos[gy_h, gx_h] = np.stack([px_v, py_v, pz_v], axis=-1).astype(np.float32)
    world_norm[gy_h, gx_h] = terrain_normal(px_v, pz_v)
    depth_map[gy_h, gx_h] = t_v.astype(np.float32)
    uv[gy_h, gx_h, 0] = ((px_v + half_size) / TILE_SIZE).astype(np.float32)
    uv[gy_h, gx_h, 1] = ((pz_v + half_size) / TILE_SIZE).astype(np.float32)

    # Analytical ray-tangent-plane differentials for UV footprint (zero boundary spikes)
    dr_dx = (2.0 * aspect * tan_half / float(width)) * right
    dr_dy = (-2.0 * tan_half / float(height)) * up

    d_hit = ray_dir[gy_h, gx_h]
    rl_hit = raw_len[gy_h, gx_h, 0]
    n_hit = world_norm[gy_h, gx_h].astype(np.float64)

    dd_dx = (dr_dx[None, :] - d_hit * np.sum(d_hit * dr_dx[None, :], axis=-1, keepdims=True)) / rl_hit[:, None]
    dd_dy = (dr_dy[None, :] - d_hit * np.sum(d_hit * dr_dy[None, :], axis=-1, keepdims=True)) / rl_hit[:, None]

    nd = np.sum(n_hit * d_hit, axis=-1, keepdims=True)
    nd_safe = np.where(np.abs(nd) < 0.03, np.where(nd >= 0, 0.03, -0.03), nd)

    dp_dx = t_v[:, None] * (dd_dx - (np.sum(n_hit * dd_dx, axis=-1, keepdims=True) / nd_safe) * d_hit)
    dp_dy = t_v[:, None] * (dd_dy - (np.sum(n_hit * dd_dy, axis=-1, keepdims=True) / nd_safe) * d_hit)

    dpdx_uv = np.zeros((height, width, 2), dtype=np.float32)
    dpdy_uv = np.zeros((height, width, 2), dtype=np.float32)
    dpdx_uv[gy_h, gx_h] = np.stack([dp_dx[:, 0], dp_dx[:, 2]], axis=-1).astype(np.float32) / TILE_SIZE
    dpdy_uv[gy_h, gx_h] = np.stack([dp_dy[:, 0], dp_dy[:, 2]], axis=-1).astype(np.float32) / TILE_SIZE

    jx = dpdx_uv * TEX_RES
    jy = dpdy_uv * TEX_RES
    A = np.sum(jx * jx, axis=-1)
    B = np.sum(jy * jy, axis=-1)
    C = np.sum(jx * jy, axis=-1)
    tr = A + B
    disc = np.sqrt(np.maximum((A - B) ** 2 + 4.0 * C * C, 0.0))
    lam1 = 0.5 * (tr + disc)
    lam2 = np.maximum(0.5 * (tr - disc), 1e-12)
    rho_max = np.sqrt(np.maximum(lam1, 1e-12))
    rho_min = np.sqrt(lam2)
    aniso_ratio = np.clip(rho_max / np.maximum(rho_min, 1e-6), 1.0, max_aniso)

    lambda_iso = np.maximum(0.0, np.log2(np.maximum(rho_max, 1e-6)))
    lambda_aniso = np.maximum(0.0, np.log2(np.maximum(np.maximum(rho_min, rho_max / max_aniso), 1e-6)))

    # Screen-space major axis direction for anisotropic sampling
    v1_x = np.where(np.abs(A - lam1) >= np.abs(B - lam1), C, lam1 - B)
    v1_y = np.where(np.abs(A - lam1) >= np.abs(B - lam1), lam1 - A, C)
    v_norm = np.hypot(v1_x, v1_y)
    vx = np.where(v_norm > 1e-8, v1_x / np.maximum(v_norm, 1e-8), 1.0)
    vy = np.where(v_norm > 1e-8, v1_y / np.maximum(v_norm, 1e-8), 0.0)
    major_uv = vx[..., None] * dpdx_uv + vy[..., None] * dpdy_uv

    return {
        "hit": hit,
        "world_pos": world_pos,
        "world_norm": world_norm,
        "depth": depth_map,
        "uv": uv,
        "dpdx_uv": dpdx_uv,
        "dpdy_uv": dpdy_uv,
        "major_uv": major_uv,
        "rho_max": rho_max,
        "rho_min": rho_min,
        "aniso_ratio": aniso_ratio,
        "lambda_iso": lambda_iso,
        "lambda_aniso": lambda_aniso,
        "sky": render_sky_background(ray_dir.astype(np.float32)),
        "ray_dir": ray_dir.astype(np.float32),
    }


def build_box_mip_pyramid(arr_f32):
    """Exact 2x2 box downsampling mip pyramid in float32 (no uint8 quantization)."""
    cur = arr_f32.astype(np.float32)
    if cur.ndim == 2:
        cur = cur[..., None]
    pyr = [cur]
    while cur.shape[0] > 1 or cur.shape[1] > 1:
        h, w = cur.shape[:2]
        if h >= 2 and w >= 2:
            cur = 0.25 * (cur[0::2, 0::2] + cur[1::2, 0::2] + cur[0::2, 1::2] + cur[1::2, 1::2])
        elif h >= 2:
            cur = 0.5 * (cur[0::2, :] + cur[1::2, :])
        else:
            cur = 0.5 * (cur[:, 0::2] + cur[:, 1::2])
        pyr.append(cur.astype(np.float32))
    return pyr


def mirror_repeat(t):
    fl = np.floor(t)
    fr = t - fl
    odd = (fl.astype(np.int64) & 1) == 1
    return np.where(odd, 1.0 - fr, fr)


def sample_bilinear_level(tex_arr, u, v):
    h, w, _ = tex_arr.shape
    um = mirror_repeat(u)
    vm = mirror_repeat(v)
    x = np.clip(um * w - 0.5, 0.0, max(0.0, w - 1.0))
    y = np.clip(vm * h - 0.5, 0.0, max(0.0, h - 1.0))
    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    c00 = tex_arr[y0, x0]
    c10 = tex_arr[y0, x1]
    c01 = tex_arr[y1, x0]
    c11 = tex_arr[y1, x1]
    return ((1.0 - fy) * ((1.0 - fx) * c00 + fx * c10) + fy * ((1.0 - fx) * c01 + fx * c11)).astype(np.float32)


def sample_trilinear_flat(pyr, u_flat, v_flat, lod_flat):
    max_lvl = len(pyr) - 1
    lod_c = np.clip(lod_flat, 0.0, float(max_lvl))
    l0 = np.floor(lod_c).astype(np.int32)
    l1 = np.minimum(l0 + 1, max_lvl)
    frac = (lod_c - l0)[:, None]

    chans = pyr[0].shape[2]
    s0 = np.empty((len(u_flat), chans), dtype=np.float32)
    s1 = np.empty((len(u_flat), chans), dtype=np.float32)

    for lv in np.unique(l0):
        m = l0 == lv
        s0[m] = sample_bilinear_level(pyr[int(lv)], u_flat[m], v_flat[m])
    for lv in np.unique(l1):
        m = l1 == lv
        s1[m] = sample_bilinear_level(pyr[int(lv)], u_flat[m], v_flat[m])

    return (1.0 - frac) * s0 + frac * s1


def sample_anisotropic_flat(pyr, u_flat, v_flat, lod_flat, major_uv_flat, aniso_ratio_flat, max_aniso=8.0):
    n_taps = np.clip(np.round(aniso_ratio_flat).astype(np.int32), 1, int(max_aniso))
    out = np.zeros((len(u_flat), pyr[0].shape[2]), dtype=np.float32)

    for nt in np.unique(n_taps):
        m = n_taps == nt
        if nt == 1:
            out[m] = sample_trilinear_flat(pyr, u_flat[m], v_flat[m], lod_flat[m])
        else:
            acc = np.zeros((np.count_nonzero(m), pyr[0].shape[2]), dtype=np.float32)
            offsets = np.linspace(-0.5 + 0.5 / nt, 0.5 - 0.5 / nt, int(nt), dtype=np.float32)
            um = u_flat[m]
            vm = v_flat[m]
            lm = lod_flat[m]
            mj = major_uv_flat[m]
            for off in offsets:
                acc += sample_trilinear_flat(pyr, um + off * mj[:, 0], vm + off * mj[:, 1], lm)
            out[m] = acc / float(nt)
    return out


def prepare_assets(demo_dir="demo_webgl"):
    def load_img(name, mode="RGB", rot90=False):
        im = Image.open(os.path.join(demo_dir, name)).convert(mode)
        if rot90:
            im = im.rotate(-90)
        return np.array(im, dtype=np.float32) / 255.0

    alb0 = load_img("1.jpg")
    alb1 = load_img("2.jpg")
    alb2_base = load_img("1rot.jpg")
    alb2 = np.clip(
        np.stack(
            [
                alb2_base[..., 0] * 1.08 + 14.0 / 255.0,
                alb2_base[..., 1] * 1.10 + 18.0 / 255.0,
                alb2_base[..., 2] * 1.18 + 26.0 / 255.0,
            ],
            axis=-1,
        ),
        0.0,
        1.0,
    ).astype(np.float32)

    def pack_nr(norm_arr, alb_arr, rmin, rmax, rot90=False):
        h, w = norm_arr.shape[:2]
        alb_rs = np.array(
            Image.fromarray((np.clip(alb_arr, 0, 1) * 255).astype(np.uint8)).resize((w, h), Image.Resampling.BILINEAR),
            dtype=np.float32,
        ) / 255.0
        n = norm_arr * 2.0 - 1.0
        if rot90:
            nx, ny = n[..., 1].copy(), -n[..., 0].copy()
            n[..., 0], n[..., 1] = nx, ny
        n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-8)
        n_enc = n * 0.5 + 0.5
        luma = np.dot(alb_rs[..., :3], LUMA_WEIGHTS)
        rough = np.clip(rmin + (rmax - rmin) * (1.0 - 0.65 * luma), 0.05, 1.0)
        return np.concatenate([n_enc, rough[..., None]], axis=-1).astype(np.float32)

    n0_raw = load_img("normal0.jpg")
    n1_raw = load_img("normal1.jpg")
    n2_raw = load_img("normal0.jpg", rot90=True)

    nr0 = pack_nr(n0_raw, alb0, 0.42, 0.88, False)
    nr1 = pack_nr(n1_raw, alb1, 0.55, 0.95, False)
    nr2 = pack_nr(n2_raw, alb2_base, 0.28, 0.72, True)

    perlin_raw = load_img("perlin.jpg", mode="L")
    mask1 = np.clip((perlin_raw - 0.55) * 8.0 + 0.5, 0.0, 1.0)[..., None].astype(np.float32)

    # Mask 2: swapped XY + offset matching MaskShader3D
    h_p, w_p = perlin_raw.shape
    p_swap = perlin_raw.T
    ox = int(round(0.37 * w_p))
    oy = int(round(0.61 * h_p))
    p_shift = np.roll(np.roll(p_swap, shift=oy, axis=0), shift=ox, axis=1)
    mask2 = np.clip((p_shift - 0.58) * 6.0 + 0.5, 0.0, 1.0)[..., None].astype(np.float32)

    return {
        "alb0": build_box_mip_pyramid(alb0),
        "alb1": build_box_mip_pyramid(alb1),
        "alb2": build_box_mip_pyramid(alb2),
        "nr0": build_box_mip_pyramid(nr0),
        "nr1": build_box_mip_pyramid(nr1),
        "nr2": build_box_mip_pyramid(nr2),
        "mask1": build_box_mip_pyramid(mask1),
        "mask2": build_box_mip_pyramid(mask2),
    }


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def evaluate_scene_method(gbuf, assets, method_spec, material_mode="pbr2", max_lod=4.5,
                          near_limit=0.25, far_limit=0.65, trans_band=0.08, max_aniso=8.0):
    hit = gbuf["hit"]
    hy, hx = np.nonzero(hit)
    n_hit = len(hy)
    u = gbuf["uv"][hy, hx, 0]
    v = gbuf["uv"][hy, hx, 1]
    major_uv = gbuf["major_uv"][hy, hx]
    aniso_r = gbuf["aniso_ratio"][hy, hx]

    anisotropic = method_spec["anisotropic"]
    lam_eff = gbuf["lambda_aniso"][hy, hx] if anisotropic else gbuf["lambda_iso"][hy, hx]
    dist_factor = np.clip(lam_eff / max(max_lod, 0.5), 0.0, 1.0)

    kind = method_spec["kind"]
    fetches_per_lvl = 8 if material_mode == "pbr3" else (5 if material_mode == "pbr2" else 3)
    alt_w = np.clip((gbuf["world_pos"][hy, hx, 1] - 1.0) / 5.0, 0.0, 1.0)[:, None]

    level_cache = {}

    def get_level(k):
        if k in level_cache:
            return level_cache[k]
        lod = np.maximum(lam_eff, float(k))

        def samp(pyr):
            if k == 0 and anisotropic:
                return sample_anisotropic_flat(pyr, u, v, lod, major_uv, aniso_r, max_aniso)
            return sample_trilinear_flat(pyr, u, v, lod)

        d = {
            "alb0": samp(assets["alb0"]),
            "alb1": samp(assets["alb1"]),
            "m1": samp(assets["mask1"]),
        }
        if material_mode in ("pbr2", "pbr3"):
            d["nr0"] = samp(assets["nr0"])
            d["nr1"] = samp(assets["nr1"])
        if material_mode == "pbr3":
            d["alb2"] = samp(assets["alb2"])
            d["nr2"] = samp(assets["nr2"])
            d["m2"] = samp(assets["mask2"]) * alt_w
        level_cache[k] = d
        return d

    def blend_levels(levels, idx_mask):
        if not np.any(idx_mask):
            return None, None
        m_sub = idx_mask
        acc_alb = np.zeros((np.count_nonzero(m_sub), 3), dtype=np.float32)
        acc_nr = np.zeros((np.count_nonzero(m_sub), 4), dtype=np.float32) if material_mode in ("pbr2", "pbr3") else None

        for a_lv, b_lv in zip(levels[:-1], levels[1:]):
            la = get_level(a_lv)
            lb = get_level(b_lv)
            m1 = la["m1"][m_sub]
            band_alb = (la["alb0"][m_sub] - lb["alb0"][m_sub]) * (1.0 - m1) + (la["alb1"][m_sub] - lb["alb1"][m_sub]) * m1
            if material_mode == "pbr3":
                m2 = la["m2"][m_sub]
                band_alb = band_alb * (1.0 - m2) + (la["alb2"][m_sub] - lb["alb2"][m_sub]) * m2
            acc_alb += band_alb

            if material_mode in ("pbr2", "pbr3"):
                band_nr = (la["nr0"][m_sub] - lb["nr0"][m_sub]) * (1.0 - m1) + (la["nr1"][m_sub] - lb["nr1"][m_sub]) * m1
                if material_mode == "pbr3":
                    m2 = la["m2"][m_sub]
                    band_nr = band_nr * (1.0 - m2) + (la["nr2"][m_sub] - lb["nr2"][m_sub]) * m2
                acc_nr += band_nr

        r_lv = levels[-1]
        lr = get_level(r_lv)
        mr1 = lr["m1"][m_sub]
        res_alb = lr["alb0"][m_sub] * (1.0 - mr1) + lr["alb1"][m_sub] * mr1
        if material_mode == "pbr3":
            mr2 = lr["m2"][m_sub]
            res_alb = res_alb * (1.0 - mr2) + lr["alb2"][m_sub] * mr2
        acc_alb += res_alb

        if material_mode in ("pbr2", "pbr3"):
            res_nr = lr["nr0"][m_sub] * (1.0 - mr1) + lr["nr1"][m_sub] * mr1
            if material_mode == "pbr3":
                mr2 = lr["m2"][m_sub]
                res_nr = res_nr * (1.0 - mr2) + lr["nr2"][m_sub] * mr2
            acc_nr += res_nr

        return acc_alb, acc_nr

    fetches = np.zeros(n_hit, dtype=np.float32)
    regime_code = np.zeros(n_hit, dtype=np.int32)
    alb_out = np.zeros((n_hit, 3), dtype=np.float32)
    nr_out = np.zeros((n_hit, 4), dtype=np.float32) if material_mode in ("pbr2", "pbr3") else None

    all_true = np.ones(n_hit, dtype=bool)

    if kind == "linear":
        alb_out, nr_out = blend_levels([0], all_true)
        fetches[:] = fetches_per_lvl
        regime_code[:] = 3
    elif kind == "full":
        lv = list(range(method_spec["levels"] + 1))
        alb_out, nr_out = blend_levels(lv, all_true)
        fetches[:] = fetches_per_lvl * len(lv)
        regime_code[:] = 1 if method_spec["levels"] == 6 else 5
    elif kind == "skip_pure":
        lv = [0, 2, 4, 6]
        alb_out, nr_out = blend_levels(lv, all_true)
        fetches[:] = fetches_per_lvl * len(lv)
        regime_code[:] = 2
    elif kind == "skip_hybrid":
        lv = [0, 1, 3, 5]
        alb_out, nr_out = blend_levels(lv, all_true)
        fetches[:] = fetches_per_lvl * len(lv)
        regime_code[:] = 5
    elif kind == "adaptive":
        w_nm = smoothstep(near_limit - trans_band, near_limit + trans_band, dist_factor)
        w_mf = smoothstep(far_limit - trans_band, far_limit + trans_band, dist_factor)
        w_full = (1.0 - w_nm) * (1.0 - w_mf)
        w_skip = w_nm * (1.0 - w_mf)
        w_lin = w_mf

        need_full = w_full > 0.0
        need_skip = w_skip > 0.0
        need_lin = w_lin > 0.0
        n_active = need_full.astype(np.int32) + need_skip.astype(np.int32) + need_lin.astype(np.int32)

        regime_code = np.where(
            n_active > 1,
            4,
            np.where(need_full, 1, np.where(need_skip, 2, 3)),
        )

        # Exact union fetch reuse matching GLSL TerrainShader
        fetches = np.where(
            need_full,
            fetches_per_lvl * 7.0,
            np.where(need_skip, fetches_per_lvl * 4.0, fetches_per_lvl * 1.0),
        ).astype(np.float32)

        if np.any(need_full):
            af, nf = blend_levels([0, 1, 2, 3, 4, 5, 6], need_full)
            alb_out[need_full] += af * w_full[need_full, None]
            if nr_out is not None:
                nr_out[need_full] += nf * w_full[need_full, None]

        if np.any(need_skip):
            as_, ns_ = blend_levels([0, 2, 4, 6], need_skip)
            alb_out[need_skip] += as_ * w_skip[need_skip, None]
            if nr_out is not None:
                nr_out[need_skip] += ns_ * w_skip[need_skip, None]

        if np.any(need_lin):
            al, nl = blend_levels([0], need_lin)
            alb_out[need_lin] += al * w_lin[need_lin, None]
            if nr_out is not None:
                nr_out[need_lin] += nl * w_lin[need_lin, None]

    # Shading (Cook-Torrance GGX in pbr2/pbr3, diffuse+hemisphere in albedo) + atmospheric fog
    alb_c = np.clip(alb_out, 0.0, 1.0)
    n_geom = gbuf["world_norm"][hy, hx]
    pos_h = gbuf["world_pos"][hy, hx]
    v_dir = -gbuf["ray_dir"][hy, hx]
    l_dir = SUN_DIR[None, :]

    nw_full = np.zeros_like(gbuf["world_norm"])

    if material_mode == "albedo":
        diff = np.maximum(np.sum(n_geom * l_dir, axis=-1, keepdims=True), 0.0)
        hemi = (0.5 + 0.5 * n_geom[:, 1:2])
        ambient = (1.0 - hemi) * np.array([0.14, 0.13, 0.11], dtype=np.float32) + hemi * np.array([0.26, 0.31, 0.38], dtype=np.float32)
        shaded = alb_c * (ambient + np.array([1.05, 0.99, 0.90], dtype=np.float32) * diff * 0.85)
        nw_h = n_geom
    else:
        tn = nr_out[:, :3] * 2.0 - 1.0
        tn[:, 2] = np.maximum(tn[:, 2], 0.08)
        tn /= np.maximum(np.linalg.norm(tn, axis=-1, keepdims=True), 1e-8)

        up_ref = np.where(
            (np.abs(n_geom[:, 2]) < 0.999)[:, None],
            np.array([[0.0, 0.0, 1.0]], dtype=np.float32),
            np.array([[1.0, 0.0, 0.0]], dtype=np.float32),
        )
        t_vec = np.cross(up_ref, n_geom)
        t_vec /= np.maximum(np.linalg.norm(t_vec, axis=-1, keepdims=True), 1e-8)
        b_vec = np.cross(n_geom, t_vec)

        nw_h = t_vec * tn[:, 0:1] + b_vec * tn[:, 1:2] + n_geom * tn[:, 2:3]
        nw_h /= np.maximum(np.linalg.norm(nw_h, axis=-1, keepdims=True), 1e-8)

        rough = np.clip(nr_out[:, 3:4], 0.08, 1.0)
        h_vec = v_dir + l_dir
        h_vec /= np.maximum(np.linalg.norm(h_vec, axis=-1, keepdims=True), 1e-8)

        ndoth = np.maximum(np.sum(nw_h * h_vec, axis=-1, keepdims=True), 0.0)
        ndotv = np.maximum(np.sum(nw_h * v_dir, axis=-1, keepdims=True), 0.0)
        ndotl = np.maximum(np.sum(nw_h * l_dir, axis=-1, keepdims=True), 0.0)
        hdotv = np.maximum(np.sum(h_vec * v_dir, axis=-1, keepdims=True), 0.0)

        a = rough * rough
        a2 = a * a
        denom = ndoth * ndoth * (a2 - 1.0) + 1.0
        ndf = a2 / np.maximum(np.pi * denom * denom, 1e-5)

        r_k = (rough + 1.0) ** 2 / 8.0
        g_v = ndotv / np.maximum(ndotv * (1.0 - r_k) + r_k, 1e-5)
        g_l = ndotl / np.maximum(ndotl * (1.0 - r_k) + r_k, 1e-5)
        g_sm = g_v * g_l

        f0 = 0.04
        f_sch = f0 + (1.0 - f0) * np.power(np.clip(1.0 - hdotv, 0.0, 1.0), 5.0)
        spec = (ndf * g_sm * f_sch) / np.maximum(4.0 * ndotv * ndotl, 1e-4)
        kd = 1.0 - f_sch

        hemi = 0.5 + 0.5 * nw_h[:, 1:2]
        ambient = (1.0 - hemi) * np.array([0.13, 0.12, 0.11], dtype=np.float32) + hemi * np.array([0.25, 0.30, 0.37], dtype=np.float32)
        radiance = np.array([1.45, 1.38, 1.24], dtype=np.float32)
        shaded = alb_c * ambient + (kd * alb_c + spec) * radiance * ndotl

    dist = gbuf["depth"][hy, hx, None]
    fog_f = np.clip(1.0 - np.exp(-((dist * FOG_DENSITY) ** 1.6)), 0.0, 1.0)
    shaded = np.clip(shaded * (1.0 - fog_f) + FOG_COLOR[None, :] * fog_f, 0.0, 1.0)

    img = gbuf["sky"].copy()
    img[hy, hx] = shaded.astype(np.float32)

    nw_full[hy, hx] = nw_h.astype(np.float32)

    fetch_map = np.zeros(hit.shape, dtype=np.float32)
    fetch_map[hy, hx] = fetches

    regime_map = np.zeros(hit.shape, dtype=np.int32)
    regime_map[hy, hx] = regime_code

    # Also store transition zone mask at level 0 for local variance evaluation
    m1_l0 = get_level(0)["m1"][:, 0]
    trans_mask = np.zeros(hit.shape, dtype=bool)
    trans_mask[hy, hx] = (m1_l0 > 0.05) & (m1_l0 < 0.95)

    return {
        "image": img,
        "world_norm_perturbed": nw_full,
        "fetch_map": fetch_map,
        "regime_map": regime_map,
        "trans_mask": trans_mask,
        "mean_fetches": float(np.mean(fetches)),
        "mean_lod": float(np.mean(lam_eff)),
        "pct_near": float(np.mean(regime_code == 1) * 100.0),
        "pct_mid": float(np.mean(regime_code == 2) * 100.0),
        "pct_far": float(np.mean(regime_code == 3) * 100.0),
        "pct_trans": float(np.mean(regime_code == 4) * 100.0),
    }


def compute_metrics(cand, ref, lin, gbuf, is_pbr=False):
    hit = gbuf["hit"]
    img_c = cand["image"]
    img_r = ref["image"]

    diff_sq = (img_c[hit].astype(np.float64) - img_r[hit].astype(np.float64)) ** 2
    mse = float(np.mean(diff_sq))
    psnr_db = float("inf") if mse == 0.0 else 10.0 * np.log10(1.0 / mse)

    # SSIM on Rec.601 luminance strictly inside interior terrain pixels
    lum_c = np.dot(img_c[..., :3], LUMA_WEIGHTS).astype(np.float64)
    lum_r = np.dot(img_r[..., :3], LUMA_WEIGHTS).astype(np.float64)
    lum_lin = np.dot(lin["image"][..., :3], LUMA_WEIGHTS).astype(np.float64)

    gf = lambda z: gaussian_filter(z, 1.5, truncate=3.5)
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    mx, my = gf(lum_c), gf(lum_r)
    sxx = gf(lum_c * lum_c) - mx * mx
    syy = gf(lum_r * lum_r) - my * my
    sxy = gf(lum_c * lum_r) - mx * my
    ssim_map = ((2 * mx * my + c1) * (2 * sxy + c2)) / ((mx * mx + my * my + c1) * (sxx + syy + c2))

    interior = binary_erosion(hit, structure=np.ones((9, 9), dtype=bool))
    ssim_mask = interior if np.any(interior) else hit
    ssim_val = float(np.mean(ssim_map[ssim_mask]))

    # Local variance in transition zone
    var_c_map = np.maximum(uniform_filter(lum_c ** 2, 7) - uniform_filter(lum_c, 7) ** 2, 0.0)
    var_r_map = np.maximum(uniform_filter(lum_r ** 2, 7) - uniform_filter(lum_r, 7) ** 2, 0.0)
    var_l_map = np.maximum(uniform_filter(lum_lin ** 2, 7) - uniform_filter(lum_lin, 7) ** 2, 0.0)
    t_mask = cand["trans_mask"] & interior if np.any(cand["trans_mask"] & interior) else hit

    var_c = float(np.mean(var_c_map[t_mask]))
    var_r = float(np.mean(var_r_map[t_mask]))
    var_l = float(np.mean(var_l_map[t_mask]))

    row = {
        "fetches_px": cand["mean_fetches"],
        "reducao_fetches_pct": (1.0 - cand["mean_fetches"] / ref["mean_fetches"]) * 100.0,
        "psnr_db": psnr_db,
        "ssim": ssim_val,
        "var_local": var_c,
        "ret_var_vs_ref_pct": (var_c / var_r * 100.0) if var_r > 0 else 100.0,
        "ret_var_vs_linear_pct": (var_c / var_l * 100.0) if var_l > 0 else 100.0,
        "pct_near": cand["pct_near"],
        "pct_mid": cand["pct_mid"],
        "pct_far": cand["pct_far"],
        "pct_trans": cand["pct_trans"],
        "mean_lod": cand["mean_lod"],
    }

    if is_pbr:
        nc = cand["world_norm_perturbed"][hit].astype(np.float64)
        nr = ref["world_norm_perturbed"][hit].astype(np.float64)
        dot_n = np.clip(np.sum(nc * nr, axis=-1), -1.0, 1.0)
        row["erro_angular_medio_graus"] = float(np.mean(np.degrees(np.arccos(dot_n))))

    return row


def save_overview_figure(outputs, gbuf, out_path):
    lin = outputs["Linear (Baseline)"]["image"]
    ref = outputs["NVIDIA N=6 (Ref)"]["image"]
    skip = outputs["Skip Puro {0,2,4,6}"]["image"]
    adap_res = outputs["Adaptativo Anisotropico"]
    adap = adap_res["image"]
    diff = np.clip(np.abs(adap - ref) * 5.0, 0.0, 1.0)
    fmap = adap_res["fetch_map"].copy()
    fmap[~gbuf["hit"]] = np.nan

    fig, axes = plt.subplots(2, 3, figsize=(16, 9.5))
    panels = [
        (f"(a) Linear Baseline ({outputs['Linear (Baseline)']['mean_fetches']:.1f} fetches/px)", lin),
        (f"(b) NVIDIA N=6 Ref ({outputs['NVIDIA N=6 (Ref)']['mean_fetches']:.1f} fetches/px)", ref),
        (f"(c) Skip Puro {{0,2,4,6}} ({outputs['Skip Puro {0,2,4,6}']['mean_fetches']:.1f} fetches/px)", skip),
        (f"(d) Adaptativo Anisotropico ({adap_res['mean_fetches']:.2f} fetches/px)", adap),
        ("(e) |Adaptativo Aniso - NVIDIA Ref| x5", diff),
    ]
    for ax, (title, im) in zip(axes.flat, panels):
        ax.imshow(np.clip(im, 0.0, 1.0))
        ax.set_title(title, fontsize=10.5)
        ax.axis("off")

    ax = axes.flat[5]
    cmap = plt.get_cmap("RdYlGn_r").copy()
    cmap.set_bad(color="#111827")
    im_c = ax.imshow(fmap, cmap=cmap, vmin=0.0, vmax=outputs["NVIDIA N=6 (Ref)"]["mean_fetches"])
    # Overlay iso-contours of dist_factor for Near/Far limits
    dist_map = np.clip(gbuf["lambda_aniso"] / 4.5, 0.0, 1.0)
    dist_map = np.where(gbuf["hit"], dist_map, np.nan)
    ax.contour(dist_map, levels=[0.25, 0.65], colors=["white", "cyan"], linewidths=[1.1, 1.1], linestyles=["--", "--"])
    ax.set_title("(f) Heatmap Real de Custo TMU (fetches/px)\nlinhas tracejadas = limiares Near/Far", fontsize=10.5)
    ax.axis("off")
    fig.colorbar(im_c, ax=ax, fraction=0.046, pad=0.04)

    fig.suptitle("Perspectiva 3D Real — Preset Overview (PBR 2 Camadas + Minificacao Otica)", fontsize=12.5, fontweight="bold")
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def save_grazing_figure(outputs, gbuf, out_path):
    ref = outputs["NVIDIA N=6 (Ref)"]["image"]
    iso = outputs["Adaptativo Isotropico"]["image"]
    aniso = outputs["Adaptativo Anisotropico"]["image"]
    diff_iso = np.clip(np.abs(iso - ref) * 5.0, 0.0, 1.0)
    diff_aniso = np.clip(np.abs(aniso - ref) * 5.0, 0.0, 1.0)
    aniso_map = np.where(gbuf["hit"], gbuf["aniso_ratio"], np.nan)

    fig, axes = plt.subplots(2, 3, figsize=(16, 9.5))
    panels = [
        (f"(a) NVIDIA N=6 Ref ({outputs['NVIDIA N=6 (Ref)']['mean_fetches']:.1f} fetches/px)", ref),
        (f"(b) Adaptativo Isotropico ({outputs['Adaptativo Isotropico']['mean_fetches']:.2f} fetches/px)", iso),
        (f"(c) Adaptativo Anisotropico ({outputs['Adaptativo Anisotropico']['mean_fetches']:.2f} fetches/px)", aniso),
        ("(d) |Adaptativo Iso - Ref| x5 (blur rasante)", diff_iso),
        ("(e) |Adaptativo Aniso - Ref| x5 (detalhe preservado)", diff_aniso),
    ]
    for ax, (title, im) in zip(axes.flat, panels):
        ax.imshow(np.clip(im, 0.0, 1.0))
        ax.set_title(title, fontsize=10.5)
        ax.axis("off")

    ax = axes.flat[5]
    cmap = plt.get_cmap("turbo").copy()
    cmap.set_bad(color="#111827")
    im_a = ax.imshow(aniso_map, cmap=cmap, vmin=1.0, vmax=8.0)
    ax.set_title("(f) Razao de Anisotropia da Pegada (rhoMax / rhoMin)", fontsize=10.5)
    ax.axis("off")
    fig.colorbar(im_a, ax=ax, fraction=0.046, pad=0.04)

    fig.suptitle("Perspectiva 3D Real — Preset Grazing (Angulo Rasante e Anisotropia)", fontsize=12.5, fontweight="bold")
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def save_pareto_3d(albedo_cases, out_path):
    n = len(albedo_cases)
    fig, axes = plt.subplots(2, n, figsize=(4.6 * n, 8.2), squeeze=False)
    markers = ["o", "s", "^", "v", "D", "P", "X", "*", "h"]
    for j, c in enumerate(albedo_cases):
        for k, m in enumerate(c["metodos"]):
            fpx = m["fetches_px"]
            psnr_val = 65.0 if np.isinf(m["psnr_db"]) else m["psnr_db"]
            lbl = m["metodo"] + (" (Ref)" if np.isinf(m["psnr_db"]) else "")
            axes[0][j].scatter(fpx, psnr_val, marker=markers[k % len(markers)], s=72, label=lbl if j == 0 else None)
            axes[1][j].scatter(fpx, m["ssim"], marker=markers[k % len(markers)], s=72)
        axes[0][j].set_title(f"{c['preset']} ({c['material_mode']})", fontsize=10)
        axes[0][j].set_ylabel("PSNR vs NVIDIA N=6 (dB)\n[Ref plotada em 65 dB]")
        axes[1][j].set_ylabel("SSIM vs NVIDIA N=6")
        for i in range(2):
            axes[i][j].set_xlabel("fetches / pixel (terreno 3D)")
            axes[i][j].grid(alpha=0.3)

    handles, labels = axes[0][0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="lower center", ncol=5, fontsize=8.5)
    fig.suptitle("Fronteira de Pareto em Perspectiva 3D Real (Custo TMU x Qualidade Visual)", fontsize=12, fontweight="bold")
    fig.tight_layout(rect=[0, 0.08, 1, 0.95])
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def save_2d_vs_3d_chart(albedo_cases, json_2d_path, out_path):
    if not os.path.exists(json_2d_path):
        return
    with open(json_2d_path, "r", encoding="utf-8") as fh:
        data_2d = json.load(fh)
    caso_2d = data_2d["casos"][0]["metodos"]
    map_2d = {m["metodo"]: m for m in caso_2d}

    labels_x = ["2D Plano\n(Chk. 2)"] + [f"3D\n{c['preset']}" for c in albedo_cases]
    x = np.arange(len(labels_x))
    w = 0.25

    def get_vals(metric, key_2d, key_3d):
        v2d = map_2d[key_2d][metric]
        vals = [v2d]
        for c in albedo_cases:
            m3d = next(r for r in c["metodos"] if r["metodo"] == key_3d)
            vals.append(m3d[metric])
        return vals

    psnr_trunc = get_vals("psnr_db", "NVIDIA N=3 (trunc)", "NVIDIA N=3 (Trunc)")
    psnr_skip = get_vals("psnr_db", "Skip puro {0, 2, 4, 6}", "Skip Puro {0,2,4,6}")
    psnr_adap = get_vals("psnr_db", "Adaptativo (dist)", "Adaptativo Anisotropico")

    f_trunc = get_vals("fetches_px", "NVIDIA N=3 (trunc)", "NVIDIA N=3 (Trunc)")
    f_skip = get_vals("fetches_px", "Skip puro {0, 2, 4, 6}", "Skip Puro {0,2,4,6}")
    f_adap_raw = [data_2d["casos"][0]["adaptativo_custo_medio_union"]] + [
        next(r for r in c["metodos"] if r["metodo"] == "Adaptativo Anisotropico")["fetches_px"]
        for c in albedo_cases
    ]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13.5, 5.2))
    ax1.bar(x - w, psnr_trunc, width=w, label="NVIDIA Trunc N=3 (12 fetches)", color="#f59e0b")
    ax1.bar(x, psnr_skip, width=w, label="Skip Puro {0,2,4,6} (12 fetches)", color="#38bdf8")
    ax1.bar(x + w, psnr_adap, width=w, label="Adaptativo Anisotropico (Union)", color="#10b981")
    ax1.set_xticks(x)
    ax1.set_xticklabels(labels_x, fontsize=9)
    ax1.set_ylabel("PSNR vs NVIDIA N=6 (dB)")
    ax1.set_title("Fidelidade Visual: 2D Plano vs Perspectiva 3D Real")
    ax1.grid(axis="y", alpha=0.3)
    ax1.legend(fontsize=8.5)

    ax2.bar(x - w, f_trunc, width=w, label="NVIDIA Trunc N=3", color="#f59e0b")
    ax2.bar(x, f_skip, width=w, label="Skip Puro {0,2,4,6}", color="#38bdf8")
    ax2.bar(x + w, f_adap_raw, width=w, label="Adaptativo Anisotropico (Union)", color="#10b981")
    ax2.axhline(21.0, color="#ef4444", linestyle="--", linewidth=1.2, label="NVIDIA N=6 Ref (21 fetches)")
    ax2.set_xticks(x)
    ax2.set_xticklabels(labels_x, fontsize=9)
    ax2.set_ylabel("Fetches / pixel (custo TMU)")
    ax2.set_title("Economia Real de Largura de Banda (Minificacao 3D)")
    ax2.grid(axis="y", alpha=0.3)
    ax2.legend(fontsize=8.5)

    fig.suptitle("Impacto da Minificacao Otica Real: Simulacao 2D (Checkpoint 2) vs Cenario 3D", fontsize=12, fontweight="bold")
    fig.tight_layout()
    fig.savefig(out_path, dpi=130)
    plt.close(fig)


def write_markdown_report(cases, out_path, width, height):
    L = []
    L.append("# Resultados em Perspectiva 3D Real (`src/benchmark_3d.py`)\n")
    L.append("## Configuracao Experimental\n")
    L.append(f"- Resolucao avaliada: **{width}x{height}**, FOV = {FOV_DEG}°, terreno `400m x 400m` (`TILE_SIZE = {TILE_SIZE}m`).")
    L.append("- Piramide `float32`: reducao `2x2 BOX` em cascata sem quantizacao para `uint8`; wrapping `MirroredRepeat`.")
    L.append("- Estimador de LOD: Jacobiano analitico em espaco de texel (`rhoMax`, `rhoMin`, `maxAniso = 8.0`).")
    L.append("- Nivel 0 anisotropico via integracao ao longo do eixo maior da elipse quando `anisotropic=True`.")
    L.append("- Reuso de fetches (`union`) nas faixas de transicao (`nearLimit=0.25`, `farLimit=0.65`, `transBand=0.08`, `maxLod=4.5`).")
    L.append("- PSNR/SSIM/Erro Angular calculados estritamente sobre pixels validos do terreno (`hit == True`).\n")

    for c in cases:
        L.append(f"## Caso: {c['preset']} — `{c['material_mode']}` ({c['label']})\n")
        L.append(f"Cobertura do terreno na tela: **{c['terrain_coverage_pct']:.1f}%** ({c['terrain_pixels']} px) | Tempo G-buffer: {c['gbuffer_ms']:.0f} ms.\n")
        hdr = "| Metodo | Fetches/px | Red. TMU (%) | PSNR (dB) | SSIM | Ret. Var. Ref (%) | LOD Medio | Zonas N/M/F/T (%) |"
        sep = "|---|---|---|---|---|---|---|---|"
        if c["is_pbr"]:
            hdr += " Erro Normal (°) |"
            sep += "---|"
        L.append(hdr)
        L.append(sep)

        for m in c["metodos"]:
            psnr_str = "inf" if np.isinf(m["psnr_db"]) else f"{m['psnr_db']:.2f}"
            zones_str = f"{m['pct_near']:.0f}/{m['pct_mid']:.0f}/{m['pct_far']:.0f}/{m['pct_trans']:.0f}"
            line = (
                f"| {m['metodo']} | {m['fetches_px']:.2f} | {m['reducao_fetches_pct']:.1f}% | "
                f"{psnr_str} | {m['ssim']:.4f} | {m['ret_var_vs_ref_pct']:.1f}% | "
                f"{m['mean_lod']:.2f} | {zones_str} |"
            )
            if c["is_pbr"]:
                line += f" {m['erro_angular_medio_graus']:.3f}° |"
            L.append(line)
        L.append("")

    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L))


def main():
    parser = argparse.ArgumentParser(description="Benchmark quantitativo 3D em perspectiva real (float32)")
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--height", type=int, default=540)
    parser.add_argument("--outdir", default="output/benchmark_3d")
    args = parser.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    t_total = time.perf_counter()

    print("[3D Benchmark] Carregando texturas e gerando piramides float32...", flush=True)
    assets = prepare_assets("demo_webgl")
    presets = get_camera_presets()

    methods = [
        {"name": "Linear (Baseline)", "kind": "linear", "levels": 0, "anisotropic": True},
        {"name": "NVIDIA N=3 (Trunc)", "kind": "full", "levels": 3, "anisotropic": True},
        {"name": "NVIDIA N=4 (Trunc)", "kind": "full", "levels": 4, "anisotropic": True},
        {"name": "NVIDIA N=5 (Trunc)", "kind": "full", "levels": 5, "anisotropic": True},
        {"name": "NVIDIA N=6 (Ref)", "kind": "full", "levels": 6, "anisotropic": True},
        {"name": "Skip Puro {0,2,4,6}", "kind": "skip_pure", "levels": 6, "anisotropic": True},
        {"name": "Skip Hibrido {0,1,3,5}", "kind": "skip_hybrid", "levels": 6, "anisotropic": True},
        {"name": "Adaptativo Isotropico", "kind": "adaptive", "levels": 6, "anisotropic": False},
        {"name": "Adaptativo Anisotropico", "kind": "adaptive", "levels": 6, "anisotropic": True},
    ]

    suite = [
        ("overview", "albedo"),
        ("grazing", "albedo"),
        ("closeup", "albedo"),
        ("aerial", "albedo"),
        ("overview", "pbr2"),
        ("grazing", "pbr2"),
        ("overview", "pbr3"),
    ]

    gbuffers = {}
    for p_key in ("overview", "grazing", "closeup", "aerial"):
        t0 = time.perf_counter()
        gbuf = trace_terrain_gbuffer(presets[p_key]["pos"], presets[p_key]["target"], args.width, args.height)
        gbuf["gbuffer_ms"] = (time.perf_counter() - t0) * 1000.0
        gbuffers[p_key] = gbuf
        cov = np.mean(gbuf["hit"]) * 100.0
        print(f"  [G-buffer] {p_key}: {gbuf['gbuffer_ms']:.0f} ms, cobertura={cov:.1f}%, aniso_med={np.mean(gbuf['aniso_ratio'][gbuf['hit']]):.2f}x", flush=True)

    all_cases = []
    overview_pbr2_outputs = None
    grazing_pbr2_outputs = None

    for p_key, mat_mode in suite:
        gbuf = gbuffers[p_key]
        is_pbr = mat_mode in ("pbr2", "pbr3")
        print(f"[3D Benchmark] Avaliando {p_key} ({mat_mode})...", flush=True)

        outputs = {}
        for m in methods:
            outputs[m["name"]] = evaluate_scene_method(gbuf, assets, m, material_mode=mat_mode)

        ref = outputs["NVIDIA N=6 (Ref)"]
        lin = outputs["Linear (Baseline)"]

        rows = []
        for m in methods:
            row = compute_metrics(outputs[m["name"]], ref, lin, gbuf, is_pbr=is_pbr)
            row["metodo"] = m["name"]
            rows.append(row)

        if p_key == "overview" and mat_mode == "pbr2":
            overview_pbr2_outputs = outputs
        if p_key == "grazing" and mat_mode == "pbr2":
            grazing_pbr2_outputs = outputs

        all_cases.append({
            "preset": p_key,
            "label": presets[p_key]["label"],
            "material_mode": mat_mode,
            "is_pbr": is_pbr,
            "resolucao": [args.width, args.height],
            "terrain_pixels": int(np.count_nonzero(gbuf["hit"])),
            "terrain_coverage_pct": float(np.mean(gbuf["hit"]) * 100.0),
            "gbuffer_ms": float(gbuf["gbuffer_ms"]),
            "metodos": rows,
        })

    if overview_pbr2_outputs is not None:
        save_overview_figure(overview_pbr2_outputs, gbuffers["overview"], os.path.join(args.outdir, "comparativo_3d_overview.png"))
    if grazing_pbr2_outputs is not None:
        save_grazing_figure(grazing_pbr2_outputs, gbuffers["grazing"], os.path.join(args.outdir, "comparativo_3d_grazing.png"))

    albedo_cases = [c for c in all_cases if c["material_mode"] == "albedo"]
    save_pareto_3d(albedo_cases, os.path.join(args.outdir, "curva_pareto_3d.png"))
    save_2d_vs_3d_chart(albedo_cases, "output/resultados_checkpoint2.json", os.path.join(args.outdir, "analise_2d_vs_3d.png"))

    payload = {
        "config": {
            "resolucao": [args.width, args.height],
            "fov_deg": FOV_DEG,
            "terrain_size": TERRAIN_SIZE,
            "tile_size": TILE_SIZE,
            "tex_res": TEX_RES,
            "near_limit": 0.25,
            "far_limit": 0.65,
            "trans_band": 0.08,
            "max_lod": 4.5,
            "max_aniso": 8.0,
            "piramide": "float32 2x2 BOX mipmaps, MirroredRepeatWrapping, level-0 anisotropic footprint integration",
        },
        "casos": all_cases,
    }
    json_path = os.path.join(args.outdir, "resultados_3d.json")
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)

    md_path = os.path.join(args.outdir, "tabela_resultados_3d.md")
    write_markdown_report(all_cases, md_path, args.width, args.height)

    print(f"[3D Benchmark] Concluido em {time.perf_counter() - t_total:.1f}s. Arquivos salvos em '{args.outdir}/'", flush=True)


if __name__ == "__main__":
    main()
