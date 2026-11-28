#!/usr/bin/env python3
"""
Gera um arquivo HTML unico e autonomo (standalone) da aplicacao WebGL,
embutindo todas as texturas em base64 e o script JS, permitindo abrir
diretamente via double-click (file:///) no navegador sem precisar de servidor HTTP!
"""
import os
import base64
import re

DEMO_DIR = "demo_webgl"
OUTPUT_HTML = "standalone_demo.html"

print("Construindo versao standalone da demonstracao WebGL...")

# 1. Carregar e codificar todas as texturas em base64
images = ["1.jpg", "2.jpg", "1rot.jpg", "2rot.jpg", "normal0.jpg", "normal1.jpg", "perlin.jpg"]
b64_textures = {}
for img in images:
    path = os.path.join(DEMO_DIR, img)
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")
        b64_textures[img] = f"data:image/jpeg;base64,{b64}"
    print(f"  + Embutida {img} ({os.path.getsize(path)/1024:.1f} KB)")

# 2. Ler main.js e substituir as chamadas de load locais pelas URLs em base64
with open(os.path.join(DEMO_DIR, "main.js"), "r", encoding="utf-8") as f:
    js_content = f.read()

# Injetar as texturas base64 diretamente no JS
for img, b64_uri in b64_textures.items():
    js_content = js_content.replace(f'"{img}"', f'"{b64_uri}"')

# 3. Ler o HTML base e injetar o JS inlined
with open(os.path.join(DEMO_DIR, "index.html"), "r", encoding="utf-8") as f:
    html_content = f.read()

# Substituir <script type="module" src="main.js"></script> pelo codigo JS direto
replacement = f"<script type=\"module\">\n{js_content}\n</script>"
html_content = html_content.replace('<script type="module" src="main.js"></script>', replacement)

with open(OUTPUT_HTML, "w", encoding="utf-8") as f:
    f.write(html_content)

size_mb = os.path.getsize(OUTPUT_HTML) / (1024 * 1024)
print(f"Sucesso! Arquivo gerado: '{OUTPUT_HTML}' ({size_mb:.2f} MB)")
print("Agora voce pode abrir o arquivo diretamente no navegador com dois cliques (file://) sem rodar o servidor Python!")
