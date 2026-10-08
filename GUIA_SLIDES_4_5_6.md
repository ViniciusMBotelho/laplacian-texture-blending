# Guia de Apresentação • Slides 4, 5 e 6
**Disciplina:** Computação Gráfica (2026/2) – IFNMG  
**Professor:** Wagner Ferreira de Barros  
**Artigo Base:** *GPU-Friendly Laplacian Texture Blending* (Bartlomiej Wronski, NVIDIA / JCGT 2025)  
**Apresentador:** Responsável pelos Slides 4, 5 e 6  

---

## 🗺️ Visão Geral do seu Bloco

* **Papel no Grupo:** Apresentar a **viabilidade técnica de implementação na GPU** e a **proposta científica da equipe**.
* **Tempo estimado do bloco:** ~3 a 4 minutos (cerca de 1 min a 1 min 20s por slide).
* **Conexão de Entrada (transição do Slide 3 para o 4):**
  > *"O [Colega anterior] acabou de nos mostrar a fundamentação teórica da decomposição em frequências. Agora, vou mostrar a vocês como essa teoria se traduz em código real de GPU e onde reside a nossa oportunidade de pesquisa."*
* **Conexão de Saída (transição do Slide 6 para o 7):**
  > *"Agora, para mostrar como a gente vai medir esse ponto ideal na prática e os testes que já realizamos no nosso ambiente, passo a palavra para o [Próximo Colega]."*

---

## 🖥️ SLIDE 4: Anatomia do Shader em ~15 Linhas de GLSL

### 1. A Essência em 3 Passos Simples
* **Passo 1 (Coleta dos Mipmaps):** O shader apenas busca na GPU as versões borradas que ela já tem salvas por padrão (a Pirâmide Gaussiana), sem ter o trabalho de calcular nada do zero.
* **Passo 2 (Subtração e Mistura dos Detalhes):** Ao subtrair um nível borrado do outro, a gente cria a **Pirâmide Laplaciana** (que são só os detalhes finos, as pedrinhas e relevos) e mistura eles sem borrar.
* **Passo 3 (Devolução do Fundo Suave):** Devolvemos a cor de fundo borrada que sobrou, aplicando uma transição bem suave e ampla para não ter corte duro nem emenda visível.

### 2. O que é o Fragment Shader?
É um mini-programa que roda direto dentro da GPU para cada pixel da tela individualmente, respondendo à pergunta: *"Que cor final este ponto deve ter agora?"*. Toda a fusão complexa roda em apenas 15 linhas de código!

### 3. Overhead Medido (+0.087 ms em 4K)
Demora apenas 0.087 milissegundos em resolução 4K na RTX 4090 — menos de 0,5% do orçamento de um quadro a 60 FPS (16.6 ms).

### 4. Fala Sugerida (Slide 4)
> *"Pessoal, olhando para o slide parece um código intimidador de shader, mas a ideia aqui é extremamente simples e elegante:*
> 
> *Pensem em uma mesa de som de DJ. Se você misturar duas músicas de uma vez só, vira uma bagunça sonora. Mas se você separar o grave, o médio e o agudo, a transição fica perfeita.*
> 
> *Esse shader faz exatamente isso com texturas em três etapas rápidas:*
> 
> *(Clique no Bloco 1)* *Primeiro, ele aproveita as versões borradas que a própria placa de vídeo já guarda na memória.*
> 
> *(Clique no Bloco 2)* *Depois, ao subtrair uma camada da outra, ele separa apenas os detalhes finos — as pedrinhas e folhinhas — e mistura esses detalhes sem borrar.*
> 
> *(Clique no Bloco 3)* *Por fim, ele junta a cor de fundo suavemente, sem deixar nenhuma linha de corte visível.*
> 
> *E o melhor de tudo está nesse número aqui à direita: todo esse processo adiciona apenas **0.087 milissegundos** em resolução 4K. É praticamente de graça para a placa de vídeo."*

---

## ⚠️ SLIDE 5: Limitação Técnica & Oportunidade (Pergunta 3 do Edital)

### 1. Elementos Visuais na Tela
* **Cartão Vermelho (Esquerda):** *O Gargalo nas Unidades de Textura (TMUs)* com a progressão de leituras (2 vs 10 vs 15 a 30 amostragens).
* **Cartão Verde (Direita):** *A Oportunidade: Salto de Níveis (Level Skipping)* com a fórmula $\hat{L}_k \approx \text{Mip}[k] - \text{Mip}[k+2]$ e a lacuna científica identificada.

### 2. Por que existe um gargalo de hardware?
* Na **Mistura Tradicional**, cada ponto na tela faz apenas **2 leituras** (1 da textura A + 1 da textura B).
* Na **Mistura Laplaciana** com 4 níveis, salta para **10 leituras** no total (5 da textura A + 5 da textura B).
* Em materiais realistas modernos (**PBR**: Cor Base + Relevo 3D + Rugosidade/Brilho), chega a **15 até 30 leituras de textura por ponto na tela!**
* Em placas integradas ou celulares (*mobile GPUs*), essa sobrecarga de memória reduz a taxa de quadros (*FPS*).

### 3. A Oportunidade e a Lacuna na Literatura
O autor da NVIDIA propõe o **Salto de Níveis** (*Level Skipping* - Seção 6.2), pulando níveis alternados da pirâmide com a aproximação $Mip[k] - Mip[k+2]$, economizando quase 50% das viagens à memória. Contudo, **ele não mediu cientificamente** se isso causa perda visível de qualidade de imagem (*SSIM / PSNR*).

### 4. Fala Sugerida (Slide 5)
> *"No entanto, identificamos no próprio artigo uma limitação prática crucial que responde à Pergunta 3 do edital:*
> 
> *Para funcionar, o método exige várias viagens à memória de textura. Se estendermos o algoritmo para um material realista completo de jogos modernos — com cor, relevo e brilho —, saltamos de 2 para **15 a 30 leituras de textura por ponto na tela**.*
> 
> *Em placas de vídeo integradas de notebooks ou celulares, isso sobrecarrega as Unidades de Textura (TMUs) e derruba a taxa de quadros (FPS).*
> 
> *Na Seção 6.2, o autor propõe o **Salto de Níveis** (Level Skipping), pulando níveis alternados da pirâmide com a aproximação $Mip[k] - Mip[k+2]$, cortando as viagens à memória quase pela metade.*
> 
> *A oportunidade científica que encontramos é que **o artigo original não mediu o impacto real dessa simplificação**: ele não avaliou se isso causa perda visível de qualidade ou fidelidade de imagem."*

---

## 🎯 SLIDE 6: Proposta da Equipe & Gráfico de Trade-off (Pergunta 4 do Edital)

### 1. O Gráfico da Curva de Pareto (Custo vs. Qualidade)
* **Eixo Horizontal (Custo):** Leituras de textura na placa de vídeo.
* **Eixo Vertical (Qualidade):** Fidelidade visual e retenção de detalhes (*SSIM*).
* **Linear Lerp (Ponto Vermelho):** Muito leve, mas imagem borrada.
* **Full 6 Níveis (Ponto Roxo):** Qualidade de cinema, mas pesado demais.
* **Sweet-Spot Proposto (Ponto Verde com Estrela):** O ponto confortável que a equipe vai investigar: metade do custo com mais de 95% de fidelidade visual.

### 2. Os 2 Eixos Experimentais da Pesquisa
* **Eixo 1 (Salto de Níveis):** Testar estratégias de pulo (1 vs 2 níveis) em várias resoluções.
* **Eixo 2 (Filtros de Interpolação):** Avaliar se filtros avançados (*Lanczos / Bicúbico*) evitam que a transição fique escura em relação ao *Box Filter* padrão da GPU.

### 3. Fala Sugerida (Slide 6)
> *"E como tudo é um trade-off, nossa proposta gira em torno exatamente dessa ideia. O autor já fez a parte difícil, que foi traduzir um modelo matemático de 40 anos em 15 linhas de código; o que a gente vai testar agora é qual o ponto ideal entre queimar a GPU e ter um novo algoritmo que não diferencia em nada de um blending tradicional.*
> 
> *A gente vai avaliar qual seria a melhor estratégia de level skipping e o impacto de diferentes filtros de interpolação na taxa de retenção de contraste.*
> 
> *Agora, para mostrar como a gente vai medir esse ponto ideal na prática e os testes que já realizamos no nosso ambiente, passo a palavra para o [Próximo Colega]."*

---

## 🧠 Banco de Perguntas e Respostas da Banca (Prof. Wagner Barros)

### ❓ Pergunta 1: *"Por que vocês chamam de DoG (Difference of Gaussians) se a GPU usa Box Filter para gerar mipmaps e interpolação bilinear?"*
* **Sua Resposta:** 
  > *"Excelente observação, professor. Matematicamente, a pirâmide de mipmaps de hardware é uma aproximação discreta da escala Gaussiana. Embora o filtro de decimação na criação de mipmaps seja tipicamente um box filter de $2\times 2$, a aplicação recursiva de sucessivas convoluções e o upsampling bilinear de hardware convergem, pelo Teorema Central do Limite, para uma função Gaussiana efetiva. O artigo demonstra que essa aproximação possui erro perceptual negligenciável para o olho humano em tempo real."*

### ❓ Pergunta 2: *"Mas a GPU moderna não esconde latência de textura trocando warps/wavefronts de execução? Por que 15 a 30 taps seriam um problema tão grande?"*
* **Sua Resposta:**
  > *"Sim, a GPU esconde latência de memória intercalando warps, desde que haja warps suficientes prontos para executar (alta ocupação). Contudo, em cenas complexas de jogos com shaders pesados (uber-shaders com iluminação volumétrica, sombras e PBR), o uso de registradores por thread é elevado, o que restringe a ocupação do multiprocessador. Se cada fragmento demandar 15 a 30 fetches de textura, a pressão sobre as TMUs e sobre as caches L1/L2 atinge o limiar de saturação, transformando o gargalo de computacional (ALU) para dependência de banda de memória (memory-bound), especialmente em GPUs integradas e mobile."*

### ❓ Pergunta 3: *"Ao fazer Level Skipping ($Mip[k] - Mip[k+2]$), a soma telescópica das bandas ainda reconstrói a imagem original com perfeição?"*
* **Sua Resposta:**
  > *"Sim, professor! A propriedade telescópica se mantém matematicamente: $(Mip_0 - Mip_2) + (Mip_2 - Mip_4) + Mip_4 = Mip_0$. A imagem reconstrói exatamente a textura original onde a máscara é 0 ou 1. A única diferença ocorre na largura da transição das frequências intermediárias, pois a banda omitida (nível 1) é agregada junto ao nível 0. É exatamente isso que estamos quantificando: o quanto essa dilatação da transição intermediária afeta o SSIM e a percepção humana."*

### ❓ Pergunta 4: *"O que é SSIM e por que não usar apenas PSNR ou MSE para medir a qualidade?"*
* **Sua Resposta:**
  > *"O MSE e o PSNR medem apenas o erro médio quadrático pixel a pixel, sendo altamente sensíveis a pequenos deslocamentos espaciais e não refletindo a percepção biológica do olho humano. Já o SSIM (Structural Similarity Index) avalia luminância, contraste e correlação estrutural em janelas locais. Como nosso objetivo no blend de texturas é justamente preservar o contraste e os microdetalhes estocásticos sem criar desfoque (ghosting), o SSIM é a métrica padrão-ouro da literatura para capturar se a estrutura da textura foi mantida."*
