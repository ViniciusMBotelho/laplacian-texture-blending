# Resultados em Perspectiva 3D Real (`src/benchmark_3d.py`)

## Configuracao Experimental

- Resolucao avaliada: **960x540**, FOV = 50.0°, terreno `400m x 400m` (`TILE_SIZE = 10.0m`).
- Piramide `float32`: reducao `2x2 BOX` em cascata sem quantizacao para `uint8`; wrapping `MirroredRepeat`.
- Estimador de LOD: Jacobiano analitico em espaco de texel (`rhoMax`, `rhoMin`, `maxAniso = 8.0`).
- Nivel 0 anisotropico via integracao ao longo do eixo maior da elipse quando `anisotropic=True`.
- Reuso de fetches (`union`) nas faixas de transicao (`nearLimit=0.25`, `farLimit=0.65`, `transBand=0.08`, `maxLod=4.5`).
- PSNR/SSIM/Erro Angular calculados estritamente sobre pixels validos do terreno (`hit == True`).

## Caso: overview — `albedo` (Panoramica (3 Zonas))

Cobertura do terreno na tela: **60.6%** (314104 px) | Tempo G-buffer: 4071 ms.

| Metodo | Fetches/px | Red. TMU (%) | PSNR (dB) | SSIM | Ret. Var. Ref (%) | LOD Medio | Zonas N/M/F/T (%) |
|---|---|---|---|---|---|---|---|
| Linear (Baseline) | 3.00 | 85.7% | 36.21 | 0.9527 | 138.3% | 3.25 | 0/0/100/0 |
| NVIDIA N=3 (Trunc) | 12.00 | 42.9% | 35.61 | 0.9425 | 153.8% | 3.25 | 0/0/0/0 |
| NVIDIA N=4 (Trunc) | 15.00 | 28.6% | 36.62 | 0.9527 | 145.1% | 3.25 | 0/0/0/0 |
| NVIDIA N=5 (Trunc) | 18.00 | 14.3% | 39.84 | 0.9758 | 125.9% | 3.25 | 0/0/0/0 |
| NVIDIA N=6 (Ref) | 21.00 | 0.0% | inf | 1.0000 | 100.0% | 3.25 | 100/0/0/0 |
| Skip Puro {0,2,4,6} | 12.00 | 42.9% | 58.21 | 0.9995 | 100.9% | 3.25 | 0/100/0/0 |
| Skip Hibrido {0,1,3,5} | 12.00 | 42.9% | 39.81 | 0.9757 | 126.5% | 3.25 | 0/0/0/0 |
| Adaptativo Isotropico | 4.17 | 80.1% | 33.87 | 0.8557 | 74.1% | 5.10 | 0/0/87/13 |
| Adaptativo Anisotropico | 8.29 | 60.5% | 41.56 | 0.9769 | 114.0% | 3.25 | 0/31/41/28 |

## Caso: grazing — `albedo` (Angulo Rasante (Anisotropia))

Cobertura do terreno na tela: **55.7%** (288596 px) | Tempo G-buffer: 5364 ms.

| Metodo | Fetches/px | Red. TMU (%) | PSNR (dB) | SSIM | Ret. Var. Ref (%) | LOD Medio | Zonas N/M/F/T (%) |
|---|---|---|---|---|---|---|---|
| Linear (Baseline) | 3.00 | 85.7% | 32.99 | 0.9782 | 112.3% | 1.09 | 0/0/100/0 |
| NVIDIA N=3 (Trunc) | 12.00 | 42.9% | 33.36 | 0.9770 | 113.8% | 1.09 | 0/0/0/0 |
| NVIDIA N=4 (Trunc) | 15.00 | 28.6% | 34.54 | 0.9820 | 110.5% | 1.09 | 0/0/0/0 |
| NVIDIA N=5 (Trunc) | 18.00 | 14.3% | 37.57 | 0.9907 | 105.4% | 1.09 | 0/0/0/0 |
| NVIDIA N=6 (Ref) | 21.00 | 0.0% | inf | 1.0000 | 100.0% | 1.09 | 100/0/0/0 |
| Skip Puro {0,2,4,6} | 12.00 | 42.9% | 55.05 | 0.9998 | 100.5% | 1.09 | 0/100/0/0 |
| Skip Hibrido {0,1,3,5} | 12.00 | 42.9% | 37.54 | 0.9907 | 106.0% | 1.09 | 0/0/0/0 |
| Adaptativo Isotropico | 12.51 | 40.4% | 29.64 | 0.8246 | 56.9% | 2.85 | 12/24/31/34 |
| Adaptativo Anisotropico | 17.58 | 16.3% | 47.16 | 0.9939 | 100.9% | 1.09 | 67/4/14/15 |

## Caso: closeup — `albedo` (Close-Up (Detalhes PBR))

Cobertura do terreno na tela: **93.8%** (486116 px) | Tempo G-buffer: 3753 ms.

| Metodo | Fetches/px | Red. TMU (%) | PSNR (dB) | SSIM | Ret. Var. Ref (%) | LOD Medio | Zonas N/M/F/T (%) |
|---|---|---|---|---|---|---|---|
| Linear (Baseline) | 3.00 | 85.7% | 35.78 | 0.9756 | 116.4% | 1.39 | 0/0/100/0 |
| NVIDIA N=3 (Trunc) | 12.00 | 42.9% | 35.79 | 0.9710 | 121.2% | 1.39 | 0/0/0/0 |
| NVIDIA N=4 (Trunc) | 15.00 | 28.6% | 36.98 | 0.9768 | 117.1% | 1.39 | 0/0/0/0 |
| NVIDIA N=5 (Trunc) | 18.00 | 14.3% | 40.39 | 0.9884 | 109.4% | 1.39 | 0/0/0/0 |
| NVIDIA N=6 (Ref) | 21.00 | 0.0% | inf | 1.0000 | 100.0% | 1.39 | 100/0/0/0 |
| Skip Puro {0,2,4,6} | 12.00 | 42.9% | 57.90 | 0.9997 | 100.6% | 1.39 | 0/100/0/0 |
| Skip Hibrido {0,1,3,5} | 12.00 | 42.9% | 40.35 | 0.9883 | 110.0% | 1.39 | 0/0/0/0 |
| Adaptativo Isotropico | 11.00 | 47.6% | 31.10 | 0.8362 | 63.2% | 3.16 | 13/21/41/25 |
| Adaptativo Anisotropico | 16.34 | 22.2% | 45.96 | 0.9920 | 103.2% | 1.39 | 50/12/17/21 |

## Caso: aerial — `albedo` (Vista Aerea (Macro))

Cobertura do terreno na tela: **71.3%** (369757 px) | Tempo G-buffer: 2919 ms.

| Metodo | Fetches/px | Red. TMU (%) | PSNR (dB) | SSIM | Ret. Var. Ref (%) | LOD Medio | Zonas N/M/F/T (%) |
|---|---|---|---|---|---|---|---|
| Linear (Baseline) | 3.00 | 85.7% | 38.23 | 0.9527 | 141.6% | 4.15 | 0/0/100/0 |
| NVIDIA N=3 (Trunc) | 12.00 | 42.9% | 37.41 | 0.9431 | 156.3% | 4.15 | 0/0/0/0 |
| NVIDIA N=4 (Trunc) | 15.00 | 28.6% | 37.77 | 0.9465 | 153.4% | 4.15 | 0/0/0/0 |
| NVIDIA N=5 (Trunc) | 18.00 | 14.3% | 40.68 | 0.9702 | 134.0% | 4.15 | 0/0/0/0 |
| NVIDIA N=6 (Ref) | 21.00 | 0.0% | inf | 1.0000 | 100.0% | 4.15 | 100/0/0/0 |
| Skip Puro {0,2,4,6} | 12.00 | 42.9% | 59.87 | 0.9995 | 100.6% | 4.15 | 0/100/0/0 |
| Skip Hibrido {0,1,3,5} | 12.00 | 42.9% | 40.68 | 0.9701 | 134.2% | 4.15 | 0/0/0/0 |
| Adaptativo Isotropico | 3.00 | 85.7% | 37.02 | 0.9119 | 89.4% | 5.52 | 0/0/100/0 |
| Adaptativo Anisotropico | 3.45 | 83.6% | 38.30 | 0.9531 | 141.2% | 4.15 | 0/0/95/5 |

## Caso: overview — `pbr2` (Panoramica (3 Zonas))

Cobertura do terreno na tela: **60.6%** (314104 px) | Tempo G-buffer: 4071 ms.

| Metodo | Fetches/px | Red. TMU (%) | PSNR (dB) | SSIM | Ret. Var. Ref (%) | LOD Medio | Zonas N/M/F/T (%) | Erro Normal (°) |
|---|---|---|---|---|---|---|---|---|
| Linear (Baseline) | 5.00 | 85.7% | 33.59 | 0.9535 | 129.0% | 3.25 | 0/0/100/0 | 0.460° |
| NVIDIA N=3 (Trunc) | 20.00 | 42.9% | 32.99 | 0.9439 | 141.3% | 3.25 | 0/0/0/0 | 0.405° |
| NVIDIA N=4 (Trunc) | 25.00 | 28.6% | 34.01 | 0.9536 | 134.5% | 3.25 | 0/0/0/0 | 0.328° |
| NVIDIA N=5 (Trunc) | 30.00 | 14.3% | 37.17 | 0.9757 | 120.1% | 3.25 | 0/0/0/0 | 0.187° |
| NVIDIA N=6 (Ref) | 35.00 | 0.0% | inf | 1.0000 | 100.0% | 3.25 | 100/0/0/0 | 0.002° |
| Skip Puro {0,2,4,6} | 20.00 | 42.9% | 54.11 | 0.9993 | 100.9% | 3.25 | 0/100/0/0 | 0.140° |
| Skip Hibrido {0,1,3,5} | 20.00 | 42.9% | 37.11 | 0.9754 | 120.9% | 3.25 | 0/0/0/0 | 0.232° |
| Adaptativo Isotropico | 6.95 | 80.1% | 29.42 | 0.7672 | 63.2% | 5.10 | 0/0/87/13 | 3.940° |
| Adaptativo Anisotropico | 13.82 | 60.5% | 38.81 | 0.9754 | 110.7% | 3.25 | 0/31/41/28 | 0.305° |

## Caso: grazing — `pbr2` (Angulo Rasante (Anisotropia))

Cobertura do terreno na tela: **55.7%** (288596 px) | Tempo G-buffer: 5364 ms.

| Metodo | Fetches/px | Red. TMU (%) | PSNR (dB) | SSIM | Ret. Var. Ref (%) | LOD Medio | Zonas N/M/F/T (%) | Erro Normal (°) |
|---|---|---|---|---|---|---|---|---|
| Linear (Baseline) | 5.00 | 85.7% | 30.03 | 0.9780 | 110.5% | 1.09 | 0/0/100/0 | 0.562° |
| NVIDIA N=3 (Trunc) | 20.00 | 42.9% | 30.42 | 0.9773 | 111.8% | 1.09 | 0/0/0/0 | 0.468° |
| NVIDIA N=4 (Trunc) | 25.00 | 28.6% | 31.65 | 0.9822 | 109.0% | 1.09 | 0/0/0/0 | 0.362° |
| NVIDIA N=5 (Trunc) | 30.00 | 14.3% | 34.70 | 0.9906 | 104.8% | 1.09 | 0/0/0/0 | 0.211° |
| NVIDIA N=6 (Ref) | 35.00 | 0.0% | inf | 1.0000 | 100.0% | 1.09 | 100/0/0/0 | 0.002° |
| Skip Puro {0,2,4,6} | 20.00 | 42.9% | 51.61 | 0.9997 | 100.6% | 1.09 | 0/100/0/0 | 0.156° |
| Skip Hibrido {0,1,3,5} | 20.00 | 42.9% | 34.64 | 0.9904 | 105.5% | 1.09 | 0/0/0/0 | 0.269° |
| Adaptativo Isotropico | 20.85 | 40.4% | 26.26 | 0.7846 | 54.1% | 2.85 | 12/24/31/34 | 4.113° |
| Adaptativo Anisotropico | 29.30 | 16.3% | 44.31 | 0.9929 | 100.8% | 1.09 | 67/4/14/15 | 0.102° |

## Caso: overview — `pbr3` (Panoramica (3 Zonas))

Cobertura do terreno na tela: **60.6%** (314104 px) | Tempo G-buffer: 4071 ms.

| Metodo | Fetches/px | Red. TMU (%) | PSNR (dB) | SSIM | Ret. Var. Ref (%) | LOD Medio | Zonas N/M/F/T (%) | Erro Normal (°) |
|---|---|---|---|---|---|---|---|---|
| Linear (Baseline) | 8.00 | 85.7% | 33.08 | 0.9492 | 130.5% | 3.25 | 0/0/100/0 | 0.483° |
| NVIDIA N=3 (Trunc) | 32.00 | 42.9% | 32.49 | 0.9394 | 143.6% | 3.25 | 0/0/0/0 | 0.426° |
| NVIDIA N=4 (Trunc) | 40.00 | 28.6% | 33.52 | 0.9501 | 136.7% | 3.25 | 0/0/0/0 | 0.342° |
| NVIDIA N=5 (Trunc) | 48.00 | 14.3% | 36.77 | 0.9744 | 121.4% | 3.25 | 0/0/0/0 | 0.191° |
| NVIDIA N=6 (Ref) | 56.00 | 0.0% | inf | 1.0000 | 100.0% | 3.25 | 100/0/0/0 | 0.002° |
| Skip Puro {0,2,4,6} | 32.00 | 42.9% | 53.87 | 0.9993 | 101.0% | 3.25 | 0/100/0/0 | 0.153° |
| Skip Hibrido {0,1,3,5} | 32.00 | 42.9% | 36.73 | 0.9741 | 122.1% | 3.25 | 0/0/0/0 | 0.239° |
| Adaptativo Isotropico | 11.12 | 80.1% | 29.45 | 0.7728 | 65.2% | 5.10 | 0/0/87/13 | 3.814° |
| Adaptativo Anisotropico | 22.11 | 60.5% | 38.43 | 0.9744 | 111.6% | 3.25 | 0/31/41/28 | 0.323° |
