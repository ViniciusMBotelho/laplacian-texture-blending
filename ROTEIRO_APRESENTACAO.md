# Roteiro de Apresentação – Checkpoint 1
## GPU-Friendly Laplacian Texture Blending
**Equipe:** Icaro Vinicius, Vinicius Macedo e Caio Dias  
**Disciplina:** Computação Gráfica (2026/2) – IFNMG  
**Orientador:** Prof. Wagner Ferreira de Barros  
**Artigo Base:** *GPU-Friendly Laplacian Texture Blending* (Bartlomiej Wronski, NVIDIA / JCGT 2025)  
**Tempo Estimado:** 10 a 15 minutos  

---

## 1. Preparação Técnica e Comandos de Operação

### Inicialização do Ambiente
Antes de iniciar a apresentação na TV ou projetor, execute no terminal do projeto:
```bash
python3 -m http.server 8000
```
Abra o navegador no endereço: **`http://localhost:8000/`**

### Teclas de Atalho Essenciais (Operação sem Mouse)
| Tecla | Ação | Descrição |
| :---: | :--- | :--- |
| <kbd>F</kbd> | **Tela Cheia** | Ativa o modo apresentação na TV e **oculta automaticamente** qualquer seletor da tela. |
| <kbd>→</kbd> ou <kbd>Espaço</kbd> | **Avançar Slide** | Transição suave para o próximo tópico. |
| <kbd>←</kbd> | **Voltar Slide** | Retorna ao slide anterior. |
| <kbd>1</kbd> | **Modo Slides** | Alterna instantaneamente para os **Slides da Apresentação**. |
| <kbd>2</kbd> | **Modo Projeto (WebGL)** | Alterna instantaneamente para a **Demonstração Prática Interativa**. |

---

## 2. Roteiro Slide a Slide com Sugestão de Falas

---

### Slide 1: Capa Oficial (Tempo sugerido: ~1 min)
* **Objetivo:** Estabelecer o contexto acadêmico, apresentar a equipe e o artigo base.
* **O que mostrar:** Título, integrantes (Icaro Vinicius, Vinicius Macedo e Caio Dias), Prof. Wagner Barros e Área 3 (Antialiasing e Texturas).
* **Fala sugerida:**
  > *"Boa tarde, professor e colegas. Somos a equipe composta por Icaro Vinicius, Vinicius Macedo e Caio Dias. Hoje apresentamos a proposta do nosso Projeto de Pesquisa em Computação Gráfica na Área 3: Antialiasing, Texturas e Aparência de Materiais. Nosso trabalho parte do artigo publicado em 2025 no Journal of Computer Graphics Techniques pelo pesquisador Bartlomiej Wronski, da NVIDIA, intitulado 'GPU-Friendly Laplacian Texture Blending'. O objetivo do nosso projeto é investigar e avaliar experimentalmente uma técnica em tempo real de mesclagem piramidal de texturas sem necessidade de qualquer pré-computação."*

---

### Slide 2: O Problema em Computação Gráfica (Pergunta 1 do Edital) (~1 min 30s)
* **Objetivo:** Explicar o dilema clássico da mesclagem de materiais em tempo real.
* **O que mostrar:** Os diagramas conceituais de *Transição Estreita (Seams)* e *Transição Ampla (Ghosting)*.
* **Fala sugerida:**
  > *"Em jogos e renderização em tempo real, combinar texturas diferentes — por exemplo, transição entre grama e rocha em terrenos ou materiais procedurais compostos — é feito tradicionalmente por interpolação linear direta (lerp). Porém, essa abordagem ingênua impõe um dilema severo:*
  > 
  > *1. Se usarmos uma **transição estreita**, criamos uma costura visível e artificial (seam), que quebra a naturalidade da cena.*
  > 
  > *2. Se usarmos uma **transição ampla e suave**, os detalhes finos se misturam gerando perda de contraste e o indesejado efeito fantasma (ghosting). Em mapas de normais de materiais PBR, isso é ainda pior: a superfície perde relevo porque as normais colapsam em direção ao vetor neutro.*
  > 
  > *Métodos anteriores tentavam corrigir isso com histogramas pré-calculados ou equações de Poisson, mas eram proibitivos para renderização em tempo real e materiais dinâmicos."*

---

### Slide 3: Contribuição Central do Artigo (Pergunta 2 do Edital) (~1 min 30s)
* **Objetivo:** Explicar a sacada elegante do artigo de usar mipmaps de hardware como pirâmides Laplacianas.
* **O que mostrar:** O fluxograma vetorial conectando Texturas $\to$ Mipmaps $\to$ DoG $\to$ Mesclagem por Frequência.
* **Fala sugerida:**
  > *"A grande sacada do artigo da NVIDIA é unir a clássica teoria de pirâmides Laplacianas de Burt & Adelson com a arquitetura nativa das GPUs modernas, sem custo adicional de memória:*
  > 
  > *Em vez de alocar estruturas extras, o algoritmo aproveita a cadeia de **mipmaps convencionais** que toda textura de GPU já possui para filtragem trilinear.*
  > 
  > *Através de uma Diferença de Gaussianas (DoG), calculada diretamente no pixel shader, cada nível Laplaciano isola uma faixa de frequência:*
  > *As **altas frequências** (detalhes nítidos) são mescladas com raio curto, preservando as bordas e eliminando o ghosting.*
  > *As **baixas frequências** (cores médias globais) são mescladas com raio amplo, garantindo que não existam costuras abruptas.*
  > 
  > *O resultado é uma transição suave, contínua e com contraste intacto."*

---

### Slide 4: Anatomia do Shader em ~15 Linhas (~1 min 30s)
* **Objetivo:** Provar a simplicidade e a eficiência matemática da implementação.
* **Interação ao vivo:** Clique nos 3 blocos de código para alternar a explicação na tela!
* **Fala sugerida:**
  > *"Toda a lógica se resume a cerca de 15 linhas de GLSL no fragment shader:*
  > 
  > *(Clique no Bloco 1)* *Primeiro, amostramos os N+1 níveis de mipmap das duas texturas e da máscara. Como os níveis inferiores têm resoluções progressivamente menores (1/4, 1/16, 1/64), eles ficam quase 100% cacheados nas memórias L1/L2 da GPU.*
  > 
  > *(Clique no Bloco 2)* *Em seguida, calculamos as diferenças de níveis vizinhos (as bandas Laplacianas) e acumulamos ponderando pela máscara de cada nível.*
  > 
  > *(Clique no Bloco 3)* *Por fim, somamos a base Gaussiana mais suave.*
  > 
  > *O overhead medido no artigo em uma resolução 4K com 4 níveis Laplacianos foi de **apenas 0.087 milissegundos**, imperceptível na taxa de quadros."*

---

### Slide 5: Limitação Identificada & Oportunidade (Pergunta 3 do Edital) (~1 min 30s)
* **Objetivo:** Apresentar a justificativa científica e a oportunidade de investigação da equipe.
* **O que mostrar:** A comparação de texture taps (2 vs 5 vs 15 amostragens) e a fórmula do *Level Skipping*.
* **Fala sugerida:**
  > *"Identificamos no próprio artigo uma limitação prática fundamental para a nossa investigação:*
  > 
  > *Para funcionar, o método exige N+1 amostragens de textura. Se estivermos renderizando um material PBR completo (com mapas de Albedo, Normal e Rugosidade), passamos de 2 para **15 leituras de textura por fragmento**! Em GPUs integradas ou dispositivos móveis, isso pode saturar as Unidades de Mapeamento de Textura (TMUs).*
  > 
  > *O autor menciona brevemente na Seção 6.2 uma técnica chamada **Level Skipping**, onde se pulam níveis alternados da pirâmide (por exemplo, amostrar apenas níveis 0, 2, 4), reduzindo quase pela metade o número de leituras.*
  > 
  > *No entanto, o artigo **não investigou sistematicamente** qual é o impacto quantitativo dessa simplificação na qualidade visual (perda de SSIM ou aparecimento de ruído residual)."*

---

### Slide 6: Proposta da Equipe & Hipótese de Pesquisa (Pergunta 4 do Edital) (~1 min 30s)
* **Objetivo:** Apresentar formalmente a pergunta de pesquisa e a curva conceitual de trade-off.
* **O que mostrar:** A pergunta em destaque e o gráfico vetorial de Pareto (Custo vs. Qualidade).
* **Fala sugerida:**
  > *"A nossa pergunta de pesquisa é:*
  > *'Qual é o impacto quantitativo do Level Skipping e de diferentes filtros de interpolação na taxa de retenção de contraste e na similaridade estrutural (SSIM) em materiais em tempo real?'*
  > 
  > *(Aponte para o gráfico)* *Nossa hipótese é encontrar um 'sweet-spot' na curva de Pareto: uma configuração com Level Skipping que economize cerca de 50% dos texture taps, mantendo mais de 95% da qualidade visual do Laplacian completo, viabilizando o algoritmo para hardwares restritos.*
  > 
  > *Além do Level Skipping, investigaremos o impacto de filtros de reconstrução de mipmaps (Box Filter padrão vs. Lanczos/Bicúbico), avaliando o surgimento de artefatos de escurecimento (ringing)."*

---

### Slide 7: Baseline e Metodologia Experimental (Perguntas 5 e 6 do Edital) (~1 min 30s)
* **Objetivo:** Detalhar como a investigação será avaliada com rigor científico.
* **O que mostrar:** Os 3 pilares: Baselines, Casos de Teste e Métricas Objetivas.
* **Fala sugerida:**
  > *"Nossa metodologia seguirá padrões comparáveis e rigorosos:*
  > 
  > *1. **Baselines:** Compararemos contra o Linear Blending tradicional (estreito e suave) e contra a referência teto do artigo com 6 níveis completos.*
  > 
  > *2. **Casos de Teste:** Avaliaremos ruídos procedurais de alta frequência, texturas fotográficas de terrenos reais e mapas de normais PBR iluminados dinamicamente.*
  > 
  > *3. **Métricas Objetivas:** Não nos limitaremos a análises visuais subjetivas. Coletaremos variância local na zona de transição, métricas estruturais SSIM e PSNR, e tempos de quadro em milissegundos."*

---

#### Slide 8: Viabilidade Inicial Comprovada (Pergunta 7 do Edital) (~1 min 30s)
* **Objetivo:** Comprovar o cumprimento da Regra de Viabilidade Inicial com dados e imagens reais já geradas no ambiente.
* **Interação ao vivo:** Clique nos botões acima da imagem para alternar entre as 3 abas (*Grid Comparativo*, *Baseline Linear* e *Laplacian (4 Níveis)*)!
* **Fala sugerida:**
  > *"Comprovamos que o nosso ambiente de desenvolvimento Linux está 100% operacional, cumprindo integralmente a Regra de Viabilidade Inicial do edital:*
  > 
  > *(Clique na aba 'Grid Comparativo')* *Implementamos o algoritmo de referência em Python e simulamos a cadeia completa de mipmaps e DoG em texturas fotográficas de solo e pedras.*
  > 
  > *(Clique na aba 'Baseline Linear' e depois em 'Laplacian')* *Observem a zona de transição: enquanto o Linear Blend perde nitidez e gera um borrão fantasma, o Laplacian Blend manteve **98.5% da variância local original**, preservando o contraste e a textura sem costuras visíveis.*
  > 
  > *Isso comprova que a nossa infraestrutura e o pipeline de experimentação já estão completamente prontos e validados para o projeto."*

---

### Slide 9: Proposta de Melhoria – LOD-Adaptive Blending (3D) (~1 min 30s)
* **Objetivo:** Apresentar a contribuição original e inovação da equipe em relação ao artigo base.
* **O que mostrar:** O problema do horizonte em 3D, o shader dinâmico com `dFdx`/`dFdy`, o diagrama do frustum em perspectiva e a proposta do Debug Heatmap.
* **Fala sugerida:**
  > *"Além da investigação do artigo, propomos uma melhoria inédita voltada para motores de jogos e terrenos 3D: o **LOD-Adaptive Blending**.*
  > 
  > *O artigo original calcula a pirâmide uniforme em todos os pixels da tela. Mas em uma câmera em perspectiva, texels distantes no horizonte já recaem em mips grosseiros. Calcular 6 níveis a 50 metros de distância é puro desperdício de TMU e largura de banda.*
  > 
  > *Nossa proposta utiliza as **derivadas de hardware da GPU (`dFdx` e `dFdy`)** no fragment shader para calcular dinamicamente a pegada do pixel e truncar o laço Laplaciano: perto da câmera mantemos todos os níveis, em média distância reduzimos as bandas, e no horizonte chaveamos suavemente para o lerp simples.*
  > 
  > *Isso gera uma **economia estimada de 50% a 70%** no tráfego de textura sem qualquer perda perceptual. Para auditar isso no Checkpoint 2, integraremos esse **Debug Heatmap em cores falsas** ao vivo na nossa demo WebGL para comprovar a transição contínua e sem popping."*

---

### Slide 10: Conclusão & Abertura para Perguntas (~1 min)
* **Objetivo:** Fechar a apresentação com segurança e abrir para a banca.
* **Fala sugerida:**
  > *"Em síntese, o projeto possui fundamentação teórica sólida em computação gráfica, viabilidade técnica comprovada no nosso ambiente e relevância prática direta para motores de jogos e renderização em tempo real.*
  > 
  > *Muito obrigado pela atenção de todos, e agora estamos abertos para perguntas e sugestões do professor Wagner e dos colegas!"*
  > 
  > *Agradecemos a atenção de todos e estamos abertos a perguntas e sugestões do professor e dos colegas."*

---

## 3. Guia de Respostas para Possíveis Perguntas da Banca

### P1: *"Por que não usar simplesmente a filtragem trilinear tradicional?"*
**Resposta:**  
> *"A filtragem trilinear é feita para antialiasing de minificação de uma única textura quando ela encolhe na tela. No nosso caso, o problema é misturar **duas texturas diferentes** em uma mesma superfície. Se fizermos interpolação linear simples (lerp), perdemos contraste. O método do artigo usa a cadeia de mipmaps trilineares existente justamente para separar as frequências e reconstruir o sinal sem ghosting."*

### P2: *"Qual é o custo de memória desse método?"*
**Resposta:**  
> *"O custo adicional de memória é **zero**. O método não aloca nenhuma textura extra nem pré-calcula tabelas de histogramas. Ele reaproveita estritamente os mipmaps convencionais que a engine gráfica já é obrigada a manter na memória para a filtragem trilinear padrão."*

### P3: *"Por que focar na investigação de Level Skipping?"*
**Resposta:**  
> *"Porque a saturação das Unidades de Mapeamento de Textura (TMUs) é o principal gargalo desse método na prática. Em materiais PBR modernos com 3 a 5 canais (albedo, normal, roughness, metallic), o número de amostragens multiplica rapidamente. O Level Skipping é a estratégia mais promissora para viabilizar essa técnica em placas integradas, dispositivos móveis e jogos competitivos a altas taxas de quadros (120+ FPS)."*

### P4: *"Como vocês garantirão que a medição de tempo seja justa?"*
**Resposta:**  
> *"Utilizaremos queries de timestamp direto na GPU (OpenGL `GL_TIME_ELAPSED` / extensões de timer), executando aquecimento prévio (warm-up) e calculando médias sobre milhares de repetições com sementes e resoluções padronizadas, eliminando a influência de oscilações do sistema operacional."*
