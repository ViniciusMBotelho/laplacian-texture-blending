#!/usr/bin/env python3
"""
Gera um arquivo HTML unico e 100% autonomo dos SLIDES.
- Embute todas as imagens em Base64 (output/)
- Adiciona botoes visuais de navegacao (Anterior / Proximo)
- Suporta cliques na tela, toque/swipe, roda do mouse e teclado (Setas, Espaco)
- Abre diretamente com 2 cliques (file:///) sem nenhum servidor Python!
"""
import os
import base64

SLIDES_HTML = "slides/index.html"
OUTPUT_STANDALONE = "slides_apresentacao.html"

print("Construindo versao standalone dos Slides...")

with open(SLIDES_HTML, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Embutir imagens em Base64
images = [
    "output/comparativo_completo.png",
    "output/blend_linear_baseline.png",
    "output/blend_laplacian_4levels.png"
]

for img_rel in images:
    if os.path.exists(img_rel):
        with open(img_rel, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")
            data_uri = f"data:image/png;base64,{b64}"
            content = content.replace(f'../{img_rel}', data_uri)
            content = content.replace(f'"{img_rel}"', f'"{data_uri}"')
            print(f"  + Embutida {img_rel} ({os.path.getsize(img_rel)/(1024*1024):.2f} MB)")

# 2. Adicionar estilos dos controles na barra de navegacao
extra_css = """
      /* Controles de navegacao visuais */
      .nav-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-left: auto;
      }
      .slide-btn {
        background: rgba(30, 41, 59, 0.85);
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 6px;
        padding: 5px 12px;
        font-size: 0.82rem;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 5px;
        transition: all 0.2s ease;
      }
      .slide-btn:hover {
        background: #38bdf8;
        color: #04101e;
        border-color: #38bdf8;
      }
      .slide-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
"""
content = content.replace("</style>", f"{extra_css}\n    </style>")

# 3. Adicionar botoes Anterior, Proximo e Tela Cheia no footer nav-bar
nav_replacement = """    <footer id="nav-bar">
      <div class="nav-label">
        <span>Slide <strong id="lbl-cur">1</strong> de <strong id="lbl-total">10</strong></span>
        <span>•</span>
        <span id="lbl-title" style="color: var(--accent)">Apresentação da Ideia</span>
      </div>
      <div class="nav-controls">
        <button id="btn-prev" class="slide-btn" onclick="goPrev()">&#9664; Anterior</button>
        <button id="btn-next" class="slide-btn" onclick="goNext()">Próximo &#9654;</button>
        <button class="slide-btn" onclick="toggleFS()">&#x26F6; Tela Cheia (F)</button>
      </div>
    </footer>"""

content = content.replace("""    <footer id="nav-bar">
      <div class="nav-label">
        <span
          >Slide <strong id="lbl-cur">1</strong> de
          <strong id="lbl-total">10</strong></span
        >
        <span>•</span>
        <span id="lbl-title" style="color: var(--accent)"
          >Apresentação da Ideia</span
        >
      </div>
    </footer>""", nav_replacement)

# 4. Adicionar navegacao por clique na tela e roda do mouse
extra_js = """
      // Atualiza estado dos botoes anterior/proximo
      const origRenderSlide = renderSlide;
      renderSlide = function() {
        origRenderSlide();
        const btnPrev = document.getElementById("btn-prev");
        const btnNext = document.getElementById("btn-next");
        if (btnPrev) btnPrev.disabled = (idx === 0);
        if (btnNext) btnNext.disabled = (idx === total - 1);
      };

      // Clique com botao esquerdo avanca slide (se nao for em botao ou link)
      document.addEventListener("click", (e) => {
        if (e.target.closest("button") || e.target.closest("a") || e.target.closest(".code-card") || e.target.closest(".tab-btn")) {
          return;
        }
        if (e.clientX > window.innerWidth * 0.35) {
          goNext();
        } else {
          goPrev();
        }
      });

      // Suporte a navegacao por roda do mouse
      let wheelThrottle = false;
      window.addEventListener("wheel", (e) => {
        if (wheelThrottle) return;
        wheelThrottle = true;
        setTimeout(() => { wheelThrottle = false; }, 350);
        if (e.deltaY > 20) goNext();
        else if (e.deltaY < -20) goPrev();
      }, { passive: true });

      // Suporte a swipe em telas touch
      let touchStartX = 0;
      window.addEventListener("touchstart", (e) => { touchStartX = e.changedTouches[0].screenX; }, { passive: true });
      window.addEventListener("touchend", (e) => {
        let diff = e.changedTouches[0].screenX - touchStartX;
        if (diff < -50) goNext();
        else if (diff > 50) goPrev();
      }, { passive: true });
"""

content = content.replace("renderSlide();\n    </script>", f"{extra_js}\n      renderSlide();\n    </script>")

with open(OUTPUT_STANDALONE, "w", encoding="utf-8") as f:
    f.write(content)

# Limpar o arquivo antigo caso exista
if os.path.exists("slides_standalone.html"):
    os.remove("slides_standalone.html")
if os.path.exists("standalone_demo.html"):
    os.remove("standalone_demo.html")
if os.path.exists("apresentacao_completa.html"):
    os.remove("apresentacao_completa.html")

size_mb = os.path.getsize(OUTPUT_STANDALONE) / (1024 * 1024)
print(f"Sucesso! Arquivo UNICO dos slides gerado: '{OUTPUT_STANDALONE}' ({size_mb:.2f} MB)")
