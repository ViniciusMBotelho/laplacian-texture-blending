# GPU-Friendly Laplacian Texture Blending

Projeto de Pesquisa Aplicada em Computação Gráfica (2026/2)  
**Curso de Bacharelado em Ciência da Computação – IFNMG**  
**Professor Coordenador:** Prof. Wagner Ferreira de Barros  

---

## 1. Descrição do Projeto

Este projeto investiga e reproduz a técnica proposta no artigo:
> **GPU-Friendly Laplacian Texture Blending**  
> *Bartlomiej Wronski (NVIDIA)*  
> Journal of Computer Graphics Techniques (JCGT), Vol. 14, No. 1, 2025.  
> [Artigo Open-Access (JCGT)](http://jcgt.org/published/0014/01/02/) | [NVIDIA Research](https://research.nvidia.com/labs/rtr/publication/wronski2025laplacian/)

### O Problema
Na renderização de mundos virtuais e geração procedural de materiais, a mesclagem (*texture blending*) ingênua de texturas via interpolação linear pontual (*lerp*) introduz dois problemas fundamentais:
1. **Transições estreitas / abruptas:** geram costuras (*seams*) visíveis e artificiais.
2. **Transições largas / suaves:** provocam atenuação de altas frequências, perda de contraste e efeito fantasma (*ghosting*), onde detalhes de ambas as texturas se misturam de forma nebulosa.

### A Abordagem do Artigo
Em vez de depender de pré-cálculos pesados (como transporte ótimo de histogramas ou solvers de Poisson), o autor propõe aproximar a decomposição em pirâmides Laplacianas diretamente no *fragment shader*, utilizando as diferenças entre níveis sucessivos da cadeia de **mipmaps** tradicionais da GPU (Diferença de Gaussianas). As bandas Laplacianas de alta frequência são mescladas com raios curtos, enquanto os níveis Gaussianos grosseiros de baixa frequência são mesclados com raios amplos, preservando a nitidez, os contrastes locais e eliminando costuras.

---

## 2. Estrutura do Repositório

```text
├── .context/               # Diretrizes da disciplina e artigo em PDF
├── demo_webgl/             # Demonstração interativa WebGL/Three.js oficial
│   ├── index.html          # Ponto de entrada da demo
│   ├── main.js             # Implementação dos shaders e interface gráfica
│   └── *.jpg               # Texturas de teste (albedo, perlin noise, normal maps)
├── src/                    # Implementações de referência e scripts da equipe
│   └── laplacian_blend.py  # Executor offline, simulação de mipmaps e métricas
├── output/                 # Resultados visuais e comparativos gerados
└── README.md               # Documentação do projeto e instruções
```

---

## 3. Instruções de Instalação e Execução

### Opção A: Demonstração Interativa WebGL (Navegador)
A demonstração WebGL permite alternar em tempo real entre o blending linear (*baseline*) e o blending Laplaciano, ajustando zoom, corte de limiar e quantidade de níveis de mipmap.

1. Inicie um servidor HTTP local a partir da pasta raiz:
   ```bash
   python3 -m http.server 8000
   ```
2. Abra o navegador no endereço:
   ```text
   http://localhost:8000/demo_webgl/
   ```

### Opção B: Pipeline Offline e Experimentos (Python)
Utilizado para gerar comparativos lado a lado e mensurar a preservação de variância local (contraste).

1. **Requisitos:**
   - Python 3.10+
   - Dependências: `numpy`, `pillow`, `scipy`, `matplotlib` (instale via `pip install numpy pillow scipy matplotlib` se necessário).

2. **Executar com texturas de teste (Albedo):**
   ```bash
   python3 src/laplacian_blend.py --tex0 demo_webgl/1.jpg --tex1 demo_webgl/2.jpg --mask demo_webgl/perlin.jpg --levels 4 --outdir output
   ```

3. **Executar com mapas de normais (Normal Maps):**
   ```bash
   python3 src/laplacian_blend.py --tex0 demo_webgl/normal0.jpg --tex1 demo_webgl/normal1.jpg --mask linear --outdir output/normal_test
   ```

4. **Resultados gerados:**
   - `output/blend_linear_baseline.png`: Resultado da mesclagem linear ingênua.
   - `output/blend_laplacian_4levels.png`: Resultado com decomposição Laplaciana.
   - `output/comparativo_completo.png`: Painel comparativo 2x3 contendo as fontes, a máscara, as duas abordagens e o mapa de diferença residual amplificado.

---

## 4. Planejamento da Investigação (Checkpoint 1)

- **Baseline:** Linear Texture Blending tradicional ponderado por máscara (lerp pontual).
- **Proposta Central de Investigação:** Avaliar o impacto de otimizações e variações no pipeline de amostragem de mipmaps:
  1. *Level Skipping:* Omissão de níveis alternados da pirâmide Laplaciana para reduzir a saturação de amostragem de textura na GPU, mensurando a degradação perceptual (SSIM/PSNR) versus redução no tempo de renderização.
  2. *LOD-Adaptive Blending (Extensão 3D):* Seleção adaptativa da profundidade da pirâmide Laplaciana em tempo real via derivadas de tela (`dFdx`/`dFdy`), reduzindo em até 60–70% o tráfego de textura em fragmentos distantes da câmera.
  3. *Análise de Filtros de Reamostragem:* Comparação entre Box Filter e filtros de maior suporte (Lanczos/Bicúbico) e seu impacto no surgimento de artefatos de escurecimento (*over-darkening/ringing*).
- **Métricas:**
  - Preservação de variância local na zona de transição ($\text{Var}(I)$).
  - SSIM e PSNR contra a referência de 6 níveis completos.
  - Custo de renderização em milissegundos / taxa de amostragem de textura.

---

## 5. Uso de Ferramentas de Inteligência Artificial

Em conformidade com a Seção 3 e Seção 5.1 do edital do projeto:
- **Ferramentas utilizadas:** Google Gemini (Antigravity Assistant).
- **Finalidade e apoio:** Compreensão matemática da decomposição espectral do artigo, identificação e extração dos artefatos da publicação oficial (JCGT), prototipagem do runner de verificação offline em Python (`src/laplacian_blend.py`) e estruturação do plano de viabilidade técnica.
- **Responsabilidade:** Todo o código, equações, parâmetros de execução e dados foram verificados, reproduzidos e validados localmente pela equipe no ambiente Linux de desenvolvimento.
