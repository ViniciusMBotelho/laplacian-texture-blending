# Benchmark 3D Executado 100% na GPU (`src/benchmark_gpu.py`)

## Ambiente de Hardware e Protocolo

- **GPU:** `ANGLE (AMD, AMD Radeon Graphics (radeonsi renoir ACO), OpenGL ES 3.2)`
- **API / Shaders:** `WebGL 2.0 (OpenGL ES 3.0 Chromium)` | `WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)`
- **Timer de Hardware:** `EXT_disjoint_timer_query_webgl2` = **True**
- **Protocolo:** aquecimento de clock (12 renders) + 3 rodadas warm-up + 25 rodadas intercaladas (round-robin com ordem alternada par/impar dentro do mesmo tick `rAF`) em FBO offscreen (`pixelRatio = 1`), sem `gl.readPixels` durante a janela de medicao.
- **Parametros:** `nearLimit=0.25`, `farLimit=0.65`, `maxLod=4.5`, `maxAniso=8x`, `mip=6`.
- **Qualidade 3D:** PSNR calculado sobre pixels validos de terreno (`960x540` RGB renderizado pela GPU); SSIM (Rec.601) calculado sobre os PNGs `1280x720` capturados diretamente do framebuffer da GPU.

## 1080p — `overview` (`pbr2`)

| Metodo | Timer | GPU Media ± DP (ms) | Mediana (ms) | P95 (ms) | Speedup (%) | Fetches/px | Red. TMU (%) | PSNR 3D (dB) | SSIM GPU |
|---|---|---|---|---|---|---|---|---|---|
| Linear (Baseline) | gpu_timer_query | 6.509 ± 0.117 | 6.451 | 6.635 | +42.8% | 5.00 | 85.7% | 33.52 | 0.9593 |
| NVIDIA N=6 (Ref) | gpu_timer_query | 11.389 ± 0.079 | 11.371 | 11.459 | +0.0% | 35.00 | 0.0% | inf | 1.0000 |
| NVIDIA N=3 (Trunc) | gpu_timer_query | 9.519 ± 0.098 | 9.471 | 9.625 | +16.4% | 20.00 | 42.9% | 32.91 | - |
| Skip Puro {0,2,4,6} | gpu_timer_query | 8.673 ± 0.086 | 8.645 | 8.816 | +23.8% | 20.00 | 42.9% | 52.67 | 0.9993 |
| Skip Hibrido {0,1,3,5} | gpu_timer_query | 9.090 ± 0.104 | 9.040 | 9.236 | +20.2% | 20.00 | 42.9% | 37.10 | - |
| Adaptativo Isotropico | gpu_timer_query | 3.587 ± 0.102 | 3.559 | 3.604 | +68.5% | 10.41 | 70.3% | 27.69 | 0.7078 |
| Adaptativo Anisotropico | gpu_timer_query | 9.015 ± 0.127 | 8.992 | 9.157 | +20.8% | 21.42 | 38.8% | 38.72 | 0.9829 |

## 1080p — `grazing` (`pbr2`)

| Metodo | Timer | GPU Media ± DP (ms) | Mediana (ms) | P95 (ms) | Speedup (%) | Fetches/px | Red. TMU (%) | PSNR 3D (dB) | SSIM GPU |
|---|---|---|---|---|---|---|---|---|---|
| Linear (Baseline) | gpu_timer_query | 5.053 ± 0.921 | 5.596 | 5.732 | +43.1% | 5.00 | 85.7% | 31.47 | 0.9809 |
| NVIDIA N=6 (Ref) | gpu_timer_query | 8.877 ± 1.709 | 9.904 | 10.094 | +0.0% | 35.00 | 0.0% | inf | 1.0000 |
| NVIDIA N=3 (Trunc) | gpu_timer_query | 7.417 ± 1.326 | 8.218 | 8.393 | +16.4% | 20.00 | 42.9% | 31.89 | - |
| Skip Puro {0,2,4,6} | gpu_timer_query | 7.023 ± 1.319 | 7.791 | 7.970 | +20.9% | 20.00 | 42.9% | 50.09 | 0.9996 |
| Skip Hibrido {0,1,3,5} | gpu_timer_query | 7.178 ± 1.347 | 7.965 | 8.143 | +19.1% | 20.00 | 42.9% | 36.87 | - |
| Adaptativo Isotropico | gpu_timer_query | 4.068 ± 0.804 | 4.564 | 4.611 | +54.2% | 25.17 | 28.1% | 25.91 | 0.7976 |
| Adaptativo Anisotropico | gpu_timer_query | 7.763 ± 1.413 | 8.608 | 8.790 | +12.6% | 30.66 | 12.4% | 44.05 | 0.9945 |

## 1080p — `closeup` (`pbr2`)

| Metodo | Timer | GPU Media ± DP (ms) | Mediana (ms) | P95 (ms) | Speedup (%) | Fetches/px | Red. TMU (%) | PSNR 3D (dB) |
|---|---|---|---|---|---|---|---|---|
| Linear (Baseline) | gpu_timer_query | 4.079 ± 0.382 | 3.994 | 4.904 | +38.0% | 5.00 | 85.7% | 32.24 |
| NVIDIA N=6 (Ref) | gpu_timer_query | 6.576 ± 0.349 | 6.462 | 7.212 | +0.0% | 35.00 | 0.0% | inf |
| NVIDIA N=3 (Trunc) | gpu_timer_query | 5.775 ± 0.329 | 5.731 | 6.128 | +12.2% | 20.00 | 42.9% | 32.37 |
| Skip Puro {0,2,4,6} | gpu_timer_query | 5.595 ± 0.341 | 5.512 | 6.242 | +14.9% | 20.00 | 42.9% | 51.22 |
| Skip Hibrido {0,1,3,5} | gpu_timer_query | 5.539 ± 0.347 | 5.440 | 5.737 | +15.8% | 20.00 | 42.9% | 36.84 |
| Adaptativo Isotropico | gpu_timer_query | 2.648 ± 0.122 | 2.631 | 2.681 | +59.7% | 22.37 | 36.1% | 26.86 |
| Adaptativo Anisotropico | gpu_timer_query | 6.008 ± 0.304 | 5.928 | 6.149 | +8.6% | 30.33 | 13.3% | 43.04 |

## 1080p — `aerial` (`pbr2`)

| Metodo | Timer | GPU Media ± DP (ms) | Mediana (ms) | P95 (ms) | Speedup (%) | Fetches/px | Red. TMU (%) | PSNR 3D (dB) |
|---|---|---|---|---|---|---|---|---|
| Linear (Baseline) | gpu_timer_query | 2.400 ± 0.187 | 2.347 | 2.701 | +44.8% | 5.00 | 85.7% | 35.52 |
| NVIDIA N=6 (Ref) | gpu_timer_query | 4.344 ± 0.136 | 4.325 | 4.391 | +0.0% | 35.00 | 0.0% | inf |
| NVIDIA N=3 (Trunc) | gpu_timer_query | 3.608 ± 0.198 | 3.559 | 3.700 | +17.0% | 20.00 | 42.9% | 34.60 |
| Skip Puro {0,2,4,6} | gpu_timer_query | 3.244 ± 0.084 | 3.222 | 3.381 | +25.3% | 20.00 | 42.9% | 54.33 |
| Skip Hibrido {0,1,3,5} | gpu_timer_query | 3.293 ± 0.114 | 3.274 | 3.463 | +24.2% | 20.00 | 42.9% | 37.84 |
| Adaptativo Isotropico | gpu_timer_query | 1.486 ± 0.128 | 1.462 | 1.528 | +65.8% | 6.24 | 82.2% | 30.62 |
| Adaptativo Anisotropico | gpu_timer_query | 2.917 ± 0.087 | 2.881 | 3.051 | +32.9% | 14.50 | 58.6% | 35.60 |

## 1080p — `overview` (`albedo`)

| Metodo | Timer | GPU Media ± DP (ms) | Mediana (ms) | P95 (ms) | Speedup (%) | Fetches/px | Red. TMU (%) | PSNR 3D (dB) |
|---|---|---|---|---|---|---|---|---|
| Linear (Baseline) | gpu_timer_query | 1.678 ± 0.045 | 1.672 | 1.724 | +34.7% | 3.00 | 85.7% | 36.05 |
| NVIDIA N=6 (Ref) | gpu_timer_query | 2.570 ± 0.055 | 2.559 | 2.655 | +0.0% | 21.00 | 0.0% | inf |
| NVIDIA N=3 (Trunc) | gpu_timer_query | 2.206 ± 0.069 | 2.185 | 2.306 | +14.2% | 12.00 | 42.9% | 35.45 |
| Skip Puro {0,2,4,6} | gpu_timer_query | 2.107 ± 0.110 | 2.072 | 2.256 | +18.0% | 12.00 | 42.9% | 55.87 |
| Skip Hibrido {0,1,3,5} | gpu_timer_query | 2.152 ± 0.076 | 2.118 | 2.275 | +16.3% | 12.00 | 42.9% | 39.68 |
| Adaptativo Isotropico | gpu_timer_query | 1.327 ± 0.033 | 1.326 | 1.358 | +48.4% | 6.25 | 70.3% | 33.25 |
| Adaptativo Anisotropico | gpu_timer_query | 2.105 ± 0.118 | 2.072 | 2.243 | +18.1% | 12.85 | 38.8% | 41.40 |

## 1080p — `overview` (`pbr3`)

| Metodo | Timer | GPU Media ± DP (ms) | Mediana (ms) | P95 (ms) | Speedup (%) | Fetches/px | Red. TMU (%) | PSNR 3D (dB) |
|---|---|---|---|---|---|---|---|---|
| Linear (Baseline) | gpu_timer_query | 5.676 ± 0.445 | 5.542 | 5.898 | +51.2% | 8.00 | 85.7% | 33.09 |
| NVIDIA N=6 (Ref) | gpu_timer_query | 11.634 ± 0.471 | 11.452 | 12.629 | +0.0% | 56.00 | 0.0% | inf |
| NVIDIA N=3 (Trunc) | gpu_timer_query | 9.771 ± 0.403 | 9.636 | 10.557 | +16.0% | 32.00 | 42.9% | 32.48 |
| Skip Puro {0,2,4,6} | gpu_timer_query | 8.234 ± 0.299 | 8.200 | 8.419 | +29.2% | 32.00 | 42.9% | 52.49 |
| Skip Hibrido {0,1,3,5} | gpu_timer_query | 8.960 ± 0.389 | 8.887 | 9.379 | +23.0% | 32.00 | 42.9% | 36.74 |
| Adaptativo Isotropico | gpu_timer_query | 2.629 ± 0.151 | 2.532 | 2.828 | +77.4% | 16.66 | 70.3% | 27.72 |
| Adaptativo Anisotropico | gpu_timer_query | 8.535 ± 0.485 | 8.382 | 9.336 | +26.6% | 34.27 | 38.8% | 38.44 |

## 4K — `overview` (`pbr2`)

| Metodo | Timer | GPU Media ± DP (ms) | Mediana (ms) | P95 (ms) | Speedup (%) | Fetches/px | Red. TMU (%) | PSNR 3D (dB) | SSIM GPU |
|---|---|---|---|---|---|---|---|---|---|
| Linear (Baseline) | gpu_timer_query | 12.784 ± 0.807 | 12.596 | 12.968 | +33.6% | 5.00 | 85.7% | 33.52 | 0.9593 |
| NVIDIA N=6 (Ref) | gpu_timer_query | 19.266 ± 0.893 | 19.075 | 19.487 | +0.0% | 35.00 | 0.0% | inf | 1.0000 |
| NVIDIA N=3 (Trunc) | gpu_timer_query | 17.047 ± 0.369 | 16.998 | 17.520 | +11.5% | 20.00 | 42.9% | 32.91 | - |
| Skip Puro {0,2,4,6} | gpu_timer_query | 15.814 ± 0.557 | 15.670 | 16.267 | +17.9% | 20.00 | 42.9% | 52.67 | 0.9993 |
| Skip Hibrido {0,1,3,5} | gpu_timer_query | 16.269 ± 0.345 | 16.251 | 16.805 | +15.6% | 20.00 | 42.9% | 37.10 | - |
| Adaptativo Isotropico | gpu_timer_query | 5.982 ± 0.213 | 5.978 | 6.064 | +69.0% | 15.78 | 54.9% | 27.69 | 0.7078 |
| Adaptativo Anisotropico | gpu_timer_query | 18.017 ± 0.293 | 18.018 | 18.309 | +6.5% | 29.27 | 16.4% | 38.72 | 0.9829 |

## 4K — `grazing` (`pbr2`)

| Metodo | Timer | GPU Media ± DP (ms) | Mediana (ms) | P95 (ms) | Speedup (%) | Fetches/px | Red. TMU (%) | PSNR 3D (dB) | SSIM GPU |
|---|---|---|---|---|---|---|---|---|---|
| Linear (Baseline) | gpu_timer_query | 9.260 ± 0.275 | 9.258 | 9.701 | +39.8% | 5.00 | 85.7% | 31.47 | 0.9809 |
| NVIDIA N=6 (Ref) | gpu_timer_query | 15.383 ± 0.292 | 15.387 | 15.714 | +0.0% | 35.00 | 0.0% | inf | 1.0000 |
| NVIDIA N=3 (Trunc) | gpu_timer_query | 13.754 ± 0.235 | 13.776 | 13.997 | +10.6% | 20.00 | 42.9% | 31.89 | - |
| Skip Puro {0,2,4,6} | gpu_timer_query | 13.153 ± 0.341 | 13.165 | 13.550 | +14.5% | 20.00 | 42.9% | 50.09 | 0.9996 |
| Skip Hibrido {0,1,3,5} | gpu_timer_query | 13.455 ± 0.280 | 13.475 | 13.784 | +12.5% | 20.00 | 42.9% | 36.87 | - |
| Adaptativo Isotropico | gpu_timer_query | 7.619 ± 0.154 | 7.588 | 7.820 | +50.5% | 28.00 | 20.0% | 25.91 | 0.7976 |
| Adaptativo Anisotropico | gpu_timer_query | 14.715 ± 0.280 | 14.644 | 14.981 | +4.3% | 32.61 | 6.8% | 44.05 | 0.9945 |
