#!/usr/bin/env python3
"""
Gera um arquivo HTML unico e mestre: 'apresentacao_completa.html'
contendo os SLIDES + a DEMO 3D WebGL alternaveis pelas teclas 1 e 2,
tudo 100% offline via Base64, sem precisar de nenhum servidor Python rodando!
"""
import os
import base64

print("Empacotando Apresentacao Completa (Slides + WebGL)...")

# 1. Gerar slides standalone
with open("slides/index.html", "r", encoding="utf-8") as f:
    slides_code = f.read()

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
            slides_code = slides_code.replace(f'../{img_rel}', data_uri)
            slides_code = slides_code.replace(f'"{img_rel}"', f'"{data_uri}"')

# 2. Gerar demo webgl standalone
demo_images = ["1.jpg", "2.jpg", "1rot.jpg", "2rot.jpg", "normal0.jpg", "normal1.jpg", "perlin.jpg"]
b64_textures = {}
for img in demo_images:
    p = os.path.join("demo_webgl", img)
    with open(p, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")
        b64_textures[img] = f"data:image/jpeg;base64,{b64}"

with open("demo_webgl/main.js", "r", encoding="utf-8") as f:
    js_content = f.read()
for img, uri in b64_textures.items():
    js_content = js_content.replace(f'"{img}"', f'"{uri}"')

with open("demo_webgl/index.html", "r", encoding="utf-8") as f:
    webgl_html = f.read()
webgl_html = webgl_html.replace('<script type="module" src="main.js"></script>', f'<script type="module">\n{js_content}\n</script>')

# 3. Ler index.html mestre e embutir os frames via srcdoc
with open("index.html", "r", encoding="utf-8") as f:
    master_html = f.read()

# Substituir os iframes src por srcdoc escapado
import html
slides_escaped = html.escape(slides_code)
webgl_escaped = html.escape(webgl_html)

master_html = master_html.replace('src="slides/index.html"', f'srcdoc="{slides_escaped}"')
master_html = master_html.replace('src="demo_webgl/index.html"', f'srcdoc="{webgl_escaped}"')

OUTPUT_FILE = "apresentacao_completa.html"
with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    f.write(master_html)

size_mb = os.path.getsize(OUTPUT_FILE) / (1024 * 1024)
print(f"Sucesso absoluto! Gerado: '{OUTPUT_FILE}' ({size_mb:.2f} MB)")
print("Pressione '1' para Slides, '2' para WebGL, 'F' para Tela Cheia - tudo funciona offline!")
