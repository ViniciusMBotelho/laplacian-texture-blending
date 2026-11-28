# Resultados — Checkpoint 2 (gerado por `src/laplacian_blend.py --benchmark`)

## Configuração

- Pirâmide em **float32**: cada canal é reduzido com PIL modo `'F'` diretamente do nível 0 para (w>>k, h>>k) com o filtro indicado e re-amostrado com BILINEAR `'F'` para a resolução cheia (simula `texture2DLod` com filtragem bilinear). Sem quantização para uint8 e sem clip entre níveis.
- Referência: NVIDIA (Listing 1) com N=6 níveis, filtro de redução **BOX** (equivale a mip 2x2 box em cascata para dimensões potência de 2).
- PSNR em RGB (faixa 1.0). SSIM em **luminância Rec.601** (0.2989, 0.5870, 0.1140), janela gaussiana σ=1.5 (11x11), C1=(0.01)², C2=(0.03)².
- Variância local: janela 7x7 sobre luminância, média na zona de transição (0.05 < máscara < 0.95).
- Custo: 3 fetches (tex0, tex1, máscara) por nível amostrado. Skip puro = {0,2,4,6}; skip híbrido = {0,1,3,5} (resíduo no nível 5).
- Adaptativo: **simulação 2D** (sem perspectiva real). dist = 0 na base, 1 no topo; completo → skip puro → linear com smoothstep (near=0.35, far=0.75, banda=0.12). Custo nas faixas de transição = soma dos dois regimes (coluna `fetches/px`); o custo com reuso de fetches compartilhados (union) é informado abaixo de cada tabela.
- Tempo: média de 5 repetições em CPU (numpy/PIL). **Não representa custo em GPU**; o adaptativo calcula tudo em tela cheia.
- Normais: blend sobre a codificação [0,1], depois decodifica para [-1,1], renormaliza e re-codifica; erro angular médio vs. referência.

## Caso: (a) 1+2, perlin

Resolução 1024x1024; zona de transição: 209854 px (20.0%).

| Método | fetches/px | Redução vs ref (%) | PSNR (dB) | SSIM | Var. local | Ret. vs ref (%) | Ret. vs linear (%) | Overshoot (%) | Tempo (ms) |
|---|---|---|---|---|---|---|---|---|---|
| Linear | 3.00 | 85.7 | 32.21 | 0.9957 | 0.009528 | 101.8 | 100.0 | 0.000 | 11.3 |
| NVIDIA N=3 (trunc) | 12.00 | 42.9 | 32.87 | 0.9967 | 0.009440 | 100.9 | 99.1 | 0.140 | 221.6 |
| NVIDIA N=4 (trunc) | 15.00 | 28.6 | 34.19 | 0.9977 | 0.009397 | 100.4 | 98.6 | 0.270 | 325.0 |
| NVIDIA N=5 (trunc) | 18.00 | 14.3 | 37.65 | 0.9990 | 0.009367 | 100.1 | 98.3 | 0.437 | 437.0 |
| NVIDIA N=6 (ref) | 21.00 | 0.0 | inf | 1.0000 | 0.009357 | 100.0 | 98.2 | 0.633 | 470.1 |
| Skip puro {0, 2, 4, 6} | 12.00 | 42.9 | 54.64 | 1.0000 | 0.009376 | 100.2 | 98.4 | 0.632 | 193.6 |
| Skip hibrido {0, 1, 3, 5} | 12.00 | 42.9 | 37.62 | 0.9990 | 0.009383 | 100.3 | 98.5 | 0.432 | 197.3 |
| Adaptativo (dist) | 15.78 | 24.9 | 38.69 | 0.9989 | 0.009412 | 100.6 | 98.8 | 0.502 | 461.8 |

Adaptativo — custo médio com reuso de fetches (union): 13.98 fetches/px.

## Caso: (b) 1rot+2rot, perlin

Resolução 1024x1024; zona de transição: 209854 px (20.0%).

| Método | fetches/px | Redução vs ref (%) | PSNR (dB) | SSIM | Var. local | Ret. vs ref (%) | Ret. vs linear (%) | Overshoot (%) | Tempo (ms) |
|---|---|---|---|---|---|---|---|---|---|
| Linear | 3.00 | 85.7 | 32.26 | 0.9958 | 0.009454 | 101.8 | 100.0 | 0.000 | 22.0 |
| NVIDIA N=3 (trunc) | 12.00 | 42.9 | 32.92 | 0.9967 | 0.009368 | 100.9 | 99.1 | 0.160 | 253.1 |
| NVIDIA N=4 (trunc) | 15.00 | 28.6 | 34.22 | 0.9977 | 0.009322 | 100.4 | 98.6 | 0.281 | 314.3 |
| NVIDIA N=5 (trunc) | 18.00 | 14.3 | 37.66 | 0.9990 | 0.009300 | 100.1 | 98.4 | 0.488 | 374.4 |
| NVIDIA N=6 (ref) | 21.00 | 0.0 | inf | 1.0000 | 0.009289 | 100.0 | 98.2 | 0.763 | 448.0 |
| Skip puro {0, 2, 4, 6} | 12.00 | 42.9 | 55.34 | 1.0000 | 0.009308 | 100.2 | 98.5 | 0.771 | 244.2 |
| Skip hibrido {0, 1, 3, 5} | 12.00 | 42.9 | 37.61 | 0.9990 | 0.009315 | 100.3 | 98.5 | 0.491 | 242.3 |
| Adaptativo (dist) | 15.78 | 24.9 | 38.02 | 0.9988 | 0.009339 | 100.5 | 98.8 | 0.649 | 623.1 |

Adaptativo — custo médio com reuso de fetches (union): 13.98 fetches/px.

## Caso: (c1) normal0+normal1, linear

Resolução 512x512; zona de transição: 235520 px (89.8%).

| Método | fetches/px | Redução vs ref (%) | PSNR (dB) | SSIM | Var. local | Ret. vs ref (%) | Ret. vs linear (%) | Overshoot (%) | Tempo (ms) | Erro angular (°) |
|---|---|---|---|---|---|---|---|---|---|---|
| Linear | 3.00 | 85.7 | 69.54 | 1.0000 | 0.002759 | 100.0 | 100.0 | 0.000 | 5.1 | 0.018 |
| NVIDIA N=3 (trunc) | 12.00 | 42.9 | 69.85 | 1.0000 | 0.002759 | 100.0 | 100.0 | 0.074 | 48.1 | 0.017 |
| NVIDIA N=4 (trunc) | 15.00 | 28.6 | 70.72 | 1.0000 | 0.002759 | 100.0 | 100.0 | 0.114 | 60.3 | 0.016 |
| NVIDIA N=5 (trunc) | 18.00 | 14.3 | 73.35 | 1.0000 | 0.002759 | 100.0 | 100.0 | 0.234 | 77.2 | 0.012 |
| NVIDIA N=6 (ref) | 21.00 | 0.0 | inf | 1.0000 | 0.002759 | 100.0 | 100.0 | 0.520 | 91.2 | 0.000 |
| Skip puro {0, 2, 4, 6} | 12.00 | 42.9 | 81.29 | 1.0000 | 0.002759 | 100.0 | 100.0 | 0.563 | 48.0 | 0.003 |
| Skip hibrido {0, 1, 3, 5} | 12.00 | 42.9 | 73.16 | 1.0000 | 0.002759 | 100.0 | 100.0 | 0.240 | 45.8 | 0.013 |
| Adaptativo (dist) | 15.76 | 25.0 | 74.45 | 1.0000 | 0.002759 | 100.0 | 100.0 | 0.386 | 123.0 | 0.006 |

Adaptativo — custo médio com reuso de fetches (union): 13.97 fetches/px.

## Caso: (c2) normal0+normal1, perlin

Resolução 512x512; zona de transição: 52386 px (20.0%).

| Método | fetches/px | Redução vs ref (%) | PSNR (dB) | SSIM | Var. local | Ret. vs ref (%) | Ret. vs linear (%) | Overshoot (%) | Tempo (ms) | Erro angular (°) |
|---|---|---|---|---|---|---|---|---|---|---|
| Linear | 3.00 | 85.7 | 41.21 | 0.9975 | 0.002860 | 104.4 | 100.0 | 0.000 | 5.2 | 1.105 |
| NVIDIA N=3 (trunc) | 12.00 | 42.9 | 44.64 | 0.9994 | 0.002775 | 101.3 | 97.0 | 1.503 | 50.9 | 0.801 |
| NVIDIA N=4 (trunc) | 15.00 | 28.6 | 48.23 | 0.9998 | 0.002753 | 100.5 | 96.3 | 2.749 | 65.1 | 0.548 |
| NVIDIA N=5 (trunc) | 18.00 | 14.3 | 53.04 | 1.0000 | 0.002743 | 100.1 | 95.9 | 4.335 | 80.1 | 0.296 |
| NVIDIA N=6 (ref) | 21.00 | 0.0 | inf | 1.0000 | 0.002739 | 100.0 | 95.8 | 5.713 | 94.8 | 0.000 |
| Skip puro {0, 2, 4, 6} | 12.00 | 42.9 | 51.24 | 0.9997 | 0.002765 | 100.9 | 96.7 | 6.146 | 55.9 | 0.331 |
| Skip hibrido {0, 1, 3, 5} | 12.00 | 42.9 | 49.41 | 0.9997 | 0.002764 | 100.9 | 96.6 | 4.369 | 59.3 | 0.466 |
| Adaptativo (dist) | 15.76 | 25.0 | 46.16 | 0.9992 | 0.002793 | 102.0 | 97.7 | 5.210 | 137.9 | 0.436 |

Adaptativo — custo médio com reuso de fetches (union): 13.97 fetches/px.

## Filtros de redução da pirâmide (caso a, NVIDIA N=6, float32)

PSNR/SSIM medidos contra o resultado com filtro BOX. Overshoot = % de pixels com algum canal < 0 ou > 1 antes do clip.

Variância local do blend linear (mesma zona): 0.009528

| Filtro | Var. local | Ret. vs linear (%) | PSNR vs BOX (dB) | SSIM vs BOX | Overshoot (%) | min | max | Tempo (ms) |
|---|---|---|---|---|---|---|---|---|
| BOX | 0.009357 | 98.2 | inf | 1.0000 | 0.633 | -0.0788 | 1.1019 | 472.3 |
| BILINEAR | 0.009353 | 98.2 | 48.24 | 0.9999 | 0.639 | -0.0783 | 1.1014 | 529.0 |
| BICUBIC | 0.009365 | 98.3 | 51.45 | 1.0000 | 0.910 | -0.0819 | 1.1010 | 569.0 |
| LANCZOS | 0.009368 | 98.3 | 47.84 | 0.9999 | 0.835 | -0.0822 | 1.0971 | 580.0 |
