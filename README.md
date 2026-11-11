# GPU-Friendly Laplacian Texture Blending

**Pesquisa Aplicada e Otimizações em Computação Gráfica (2026/2)**  
**Curso de Bacharelado em Ciência da Computação – IFNMG Campus Montes Claros**  
**Equipe:** Icaro Vinicius, Vinicius Macedo, Caio Dias  
**Orientador:** Prof. Wagner Ferreira de Barros  
**Status:** Checkpoint 2 — Implementação da Proposta e Resultados Preliminares (Novembro de 2026)

---

## 1. Descrição do Projeto

Este projeto investiga, reproduz e estende a técnica apresentada no artigo:

> **GPU-Friendly Laplacian Texture Blending**  
> *Bartlomiej Wronski (NVIDIA)*  
> Journal of Computer Graphics Techniques (JCGT), Vol. 14, No. 1, 2025.  
> [Artigo Open-Access (JCGT)](http://jcgt.org/published/0014/01/02/) | [NVIDIA Research](https://research.nvidia.com/labs/rtr/publication/wronski2025laplacian/)

### O Problema da Mesclagem Linear
Na renderização de terrenos e composição procedural de materiais em tempo real, a interpolação linear padrão (*alpha blending* via `mix(I1, I2, alpha)`) impõe um compromisso severo:
- **Transições estreitas:** produzem costuras visíveis (*seams*) artificiais.
- **Transições largas:** destroem até 50% da variância local no ponto médio ($\alpha = 0{,}5$), gerando perda severa de contraste, aspecto borrado e efeito fantasma (*ghosting*).

### A Abordagem de Wronski (NVIDIA, 2025)
Wronski propõe decompor o sinal em bandas de frequência Laplacianas dentro de um único *fragment shader*, utilizando as diferenças entre níveis sucessivos da cadeia de **mipmaps** de hardware da GPU (Diferença de Gaussianas). Altas frequências transicionam rapidamente; baixas frequências transicionam suavemente. Contudo, avaliar uma pirâmide completa de $K=6$ níveis ($7$ níveis de mipmap, $0$ a $6$) requer **21 leituras de textura por fragmento** (duas texturas e uma máscara por nível), sobrecarregando as Unidades de Mapeamento de Textura (TMUs), sobretudo em fragmentos distantes da câmera.

---

## 2. Propostas Implementadas (Checkpoint 2)

Neste Checkpoint 2, implementamos e validamos duas extensões complementares à formulação original:

1. **Salto de Níveis na Pirâmide (*Level Skipping*):**
   - **Variante Pura $\{0, 2, 4, 6\}$:** amostra apenas níveis pares com passo $\Delta k = 2$, reduzindo o custo de 21 para 12 leituras de textura por fragmento (**redução de 42,9%**). Demonstramos algebricamente que a soma telescópica permanece estritamente preservada fora da transição.
   - **Variante Híbrida $\{0, 1, 3, 5\}$:** preserva a primeira banda fina intacta ($\Delta k = 1$) e aplica saltos duplos a partir do nível 1, minimizando *overshooting* com os mesmos 12 acessos.

2. **Mesclagem Adaptativa Contínua por Distância (*LOD-Adaptive Blending*):**
   - Particiona o espaço de renderização em três regimes operacionais:
     - **Zona Próxima:** Pirâmide completa ou *Level Skipping* Híbrido (fidelidade máxima).
     - **Zona Intermediária:** *Level Skipping* Puro (12 leituras).
     - **Zona Distante:** *Linear Blending* direto no nível de mipmap corrente (3 leituras).
   - Transição contínua via interpolação hermítica cúbica (`smoothstep`) aplicada sobre os pesos da máscara, **eliminando completamente descontinuidades visuais (*popping*)**.

3. **Instrumentação e Heatmap em WebGL 2.0 / Three.js:**
   - Visualizador de custo de amostragem em tempo real (*Heatmap de TMU*): Vermelho (Alto custo / Zona Próxima), Amarelo (Médio custo / Intermediária) e Verde (Baixo custo / Distante).
   - HUD dinâmico exibindo *fetches*/pixel estimados, porcentagem de economia de TMU e medição de framerate com suporte a timer de GPU.

---

## 3. Resultados Quantitativos Preliminares

Os dados abaixo foram mensurados diretamente em precisão de ponto flutuante (*float32*), sem quantização intermediária para 8 bits, por meio do benchmark automatizado `src/laplacian_blend.py --benchmark`.

### Tabela 1: Caso (a) Terreno Albedo (Texturas 1+2, Máscara Perlin, 1024×1024)
*Zona de transição: 209.854 pixels (20,0% da área total).*

| Método / Configuração | Níveis Amostrados | Fetches/px | Redução TMU | PSNR (dB) | SSIM | Var. Local | Retenção vs Lin. | Overshoot |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Linear Blending (`mix`) | $\{0\}$ | 3,00 | -85,7% | 32,21 | 0,9957 | 0,009528 | 100,0% | 0,000% |
| NVIDIA $N=3$ (truncado) | $\{0, 1, 2, 3\}$ | 12,00 | -42,9% | 32,87 | 0,9967 | 0,009440 | 99,1% | 0,140% |
| NVIDIA $N=4$ (truncado) | $\{0, \dots, 4\}$ | 15,00 | -28,6% | 34,19 | 0,9977 | 0,009397 | 98,6% | 0,270% |
| NVIDIA $N=5$ (truncado) | $\{0, \dots, 5\}$ | 18,00 | -14,3% | 37,65 | 0,9990 | 0,009367 | 98,3% | 0,437% |
| **NVIDIA $N=6$ (Referência)** | $\{0, \dots, 6\}$ | 21,00 | 0,0% | $\infty$ | 1,0000 | 0,009357 | 98,2% | 0,633% |
| **Skip Puro $\{0, 2, 4, 6\}$ (Prop.)** | $\{0, 2, 4, 6\}$ | **12,00** | **-42,9%** | **54,64** | **1,0000** | 0,009376 | 98,4% | 0,632% |
| **Skip Híbrido $\{0, 1, 3, 5\}$ (Prop.)** | $\{0, 1, 3, 5\}$ | **12,00** | **-42,9%** | **37,62** | **0,9990** | 0,009383 | 98,5% | 0,432% |
| **Adaptativo por Distância (Prop.)** | Dinâmico | **15,78**\* | **-24,9%**\* | **38,69** | **0,9989** | 0,009412 | 98,8% | 0,502% |

*\* Custo no modelo aditivo de transição; com reuso de amostragens compartilhadas na união das faixas, o custo médio reduz-se para **13,98 fetches/px (-33,4%)**.*

### Tabela 2: Mapas de Normais PBR e Análise de Filtros de Redução

| Caso de Teste | Método / Filtro | Custo (fetches) | Métrica Principal | Observação |
|---|---|:---:|---|---|
| **Normais (c2)** | Linear Blending | 3,00 | Erro angular: $1{,}105^\circ$ | Perda de relevo especular |
| **Normais (c2)** | NVIDIA $N=3$ (truncado) | 12,00 | Erro angular: $0{,}801^\circ$ | Truncamento prematuro |
| **Normais (c2)** | **Skip Puro $\{0,2,4,6\}$** | **12,00** | **Erro angular: $0{,}331^\circ$** | **Supera $N=3$ e $N=4$ ($0{,}548^\circ$)** |
| **Normais (c2)** | Skip Híbrido $\{0,1,3,5\}$ | 12,00 | Erro angular: $0{,}466^\circ$ | Menor índice de overshoot |
| **Filtros ($N=6$)** | Box (Referência) | 21,00 | Overshoot: 0,633% | Filtro padrão de mipmap da GPU |
| **Filtros ($N=6$)** | Bilinear | 21,00 | PSNR: 48,24 dB / Over: 0,639% | Comportamento equivalente ao Box |
| **Filtros ($N=6$)** | Bicúbico (Catmull-Rom) | 21,00 | PSNR: 51,45 dB / Over: 0,910% | Lóbulos negativos elevam overshoot |
| **Filtros ($N=6$)** | Lanczos ($a=2$) | 21,00 | PSNR: 47,84 dB / Over: 0,835% | Maior propensão a ringing |

### Principais Descobertas:
1. **Superioridade do Level Skipping:** Sob o mesmo orçamento de 12 fetches, o *Skip Puro* supera expressivamente o truncamento simples $N=3$ (**54,64 dB vs. 32,87 dB** no albedo e **0,331° vs. 0,801°** em normais). Isso ocorre porque atingir o nível grosseiro $k=6$ preserva a rampa suave macroscópica da transição.
2. **Continuidade sem Popping:** A mesclagem adaptativa 2D atinge 38,69 dB e SSIM 0,9989 sem qualquer linha visível de corte.
3. **Estabilidade de Filtros:** Filtros de maior suporte aumentam o *overshoot* sem ganho perceptivo em SSIM, confirmando a adequação da cadeia nativa Box/Bilinear de GPU.

---

## 4. Instruções de Execução

### Opção A: Demonstração Interativa WebGL (Three.js)

1. Inicie um servidor HTTP local a partir da raiz do repositório:
   ```bash
   python3 -m http.server 8000
   ```
2. Abra o navegador em:
   ```text
   http://localhost:8000/demo_webgl/
   ```
3. **Controles na Interface (lil-gui e HUD):**
   - `mode (Mesclagem)`: Alterna entre Baseline Linear (0), NVIDIA Completa (1), Level Skipping (2) e Proposta Adaptativa (3).
   - `heatmap`: Ativa o mapa de calor de custo de TMU (Vermelho = Alto, Amarelo = Médio, Verde = Baixo).
   - `splitCompare`: Divisão de tela interativa para contraste visual instantâneo.
   - `perspectiveTilt`: Inclina a geometria em perspectiva para simular visualização de terreno 3D.
   - `nearLimit` / `farLimit`: Ajusta os limiares de transição contínua entre regimes de distância.
   - `HUD`: Exibe em tempo real o custo em *fetches*/px, economia percentual e métricas de desempenho.

### Opção B: Pipeline Científico e Benchmark (Python)

1. **Requisitos:**
   - Python 3.10+
   - Dependências: `pip install numpy pillow scipy matplotlib`

2. **Executar a Suíte Oficial do Checkpoint 2 (Benchmark):**
   ```bash
   python3 src/laplacian_blend.py --benchmark
   ```
   *Gera e atualiza automaticamente os artefatos de dados e gráficos:*
   - `output/tabela_resultados.md`: Tabela formatada em Markdown com todos os casos e métricas.
   - `output/resultados_checkpoint2.json`: Dados quantitativos brutos em JSON.
   - `output/comparativo_checkpoint2.png`: Painel comparativo visual lado a lado com resíduos amplificados ($5\times$).
   - `output/curva_pareto_custo_qualidade.png`: Gráfico da fronteira de Pareto (Fetches vs. PSNR).

3. **Execução Customizada com Parâmetros Manuais:**
   ```bash
   python3 src/laplacian_blend.py --tex0 demo_webgl/1.jpg --tex1 demo_webgl/2.jpg --mask demo_webgl/perlin.jpg --levels 4 --outdir output
   ```

---

## 5. Estrutura do Repositório

```text
├── .context/                          # Artigo de referência (PDF) e diretrizes da disciplina
├── demo_webgl/                        # Demonstração interativa WebGL 2.0 / Three.js
│   ├── index.html                     # Interface gráfica, HUD de métricas e estilos
│   ├── main.js                        # Shaders GLSL (Level Skipping, Adaptativo e Heatmap)
│   ├── 1.jpg, 2.jpg                   # Texturas de albedo de terreno
│   ├── 1rot.jpg, 2rot.jpg             # Texturas para validação de hex-tiling/rotação
│   ├── normal0.jpg, normal1.jpg       # Mapas de normais PBR
│   └── perlin.jpg                     # Máscara procedural de ruído de Perlin
├── paper/                             # Artigo científico em LaTeX (formato conferência)
│   ├── artigo.tex                     # Código-fonte principal do artigo
│   └── referencias.bib                # Referências bibliográficas (BibTeX)
├── src/                               # Implementações de referência em Python
│   └── laplacian_blend.py             # Pipeline em float32, rotinas de benchmark e métricas
├── output/                            # Dados, gráficos e figuras geradas
│   ├── tabela_resultados.md           # Tabela consolidada do Checkpoint 2
│   ├── resultados_checkpoint2.json    # Dados JSON estruturados
│   ├── comparativo_checkpoint2.png    # Painel comparativo visual
│   └── curva_pareto_custo_qualidade.png # Curva de Pareto Custo vs. Qualidade
└── README.md                          # Documentação técnica do projeto
```

---

## 6. Cronograma até a Entrega Final (29/11/2026)

| Período | Foco Principal | Entregáveis |
|---|---|---|
| **Semana 1**<br>*(12/11 a 18/11)* | Medição de Tempo em GPU | Integração da extensão `EXT_disjoint_timer_query_webgl2` no protótipo Three.js para medição precisa de milissegundos por quadro em resoluções 1080p e 4K. |
| **Semana 2**<br>*(19/11 a 24/11)* | Anisotropia e Terreno Multi-Material | Extensão do estimador de LOD para tratar pegadas elípticas em ângulos rasantes e composição de terreno com 3 camadas simultâneas (albedo + normais + rugosidade). |
| **Semana 3**<br>*(25/11 a 29/11)* | Consolidação e Defesa Final | Revisão final do texto em LaTeX no padrão da disciplina, consolidação dos gráficos de hardware e gravação da demonstração em vídeo para a apresentação final. |

---

## 7. Uso de Ferramentas de Inteligência Artificial

Em estrita conformidade com as diretrizes da disciplina e as normas éticas do edital:
- **Ferramenta utilizada:** Google Gemini (Antigravity Assistant).
- **Escopo de assistência:** Suporte na formalização matemática da soma telescópica com passo duplo, otimização das rotinas vetoriais em NumPy/SciPy para a bancada de testes em ponto flutuante (*float32*), e auxílio na estruturação tipográfica dos documentos em LaTeX.
- **Validação e Integridade:** Todas as equações, códigos de *shader*, execuções de benchmark, análises críticas e conclusões foram implementadas, testadas e validadas diretamente pela equipe de autores em ambiente Linux local.
