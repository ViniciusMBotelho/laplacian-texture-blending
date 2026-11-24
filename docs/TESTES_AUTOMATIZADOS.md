# Validação automatizada do benchmark — protocolo v2

Esta cópia de desenvolvimento está na branch local `benchmark-validacao`, baseada
em `checkpoint-2-trabalho` (`10293a4`). O artigo e os resultados históricos não
foram modificados. Os resultados novos ficam em `output/validation/`.

## Preparação

Requisitos: Node.js 22 ou posterior, Python 3.10 ou posterior e Chrome, Edge ou
Chromium. O teste de GPU exige WebGL 2 e `EXT_disjoint_timer_query_webgl2`.
O Three.js é fixado em 0.149.0 no lockfile; o navegador não precisa de CDN.

Na raiz desta cópia (`cd benchmark-validacao` se estiver na pasta original):

```sh
npm ci
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-validation.txt
```

No PowerShell, crie o ambiente com `python -m venv .venv` e ative com
`.\.venv\Scripts\Activate.ps1`. Se o Python tiver outro nome/caminho, configure
`PYTHON` com o executável. No WSL, o navegador também precisa estar acessível no
Linux; um Chromium instalado no WSL pode ser indicado em `CHROME_PATH`.

## Comandos para apresentar ao professor

```sh
npm test
npm run test:gpu
npm run test:gpu:resolutions
```

| Comando | O que verifica |
|---|---|
| `npm test` | Estatísticas conhecidas; validação dos relatórios; perdas e descartes de consultas; matriz 2×2; PSNR/SSIM em sinais conhecidos; janelas estritamente dentro do terreno. Não abre navegador. |
| `npm run test:gpu` | Shaders reais; duas sessões em processos separados; resoluções 320×180 e 640×360; exportação de cada consulta e captura; controle negativo de LOD com regime fixo. |
| `npm run test:gpu:resolutions` | Capturas e métricas reais em 1920×1080 e 3840×2160; dimensões conferidas nos PNGs; timer de GPU e dados brutos. Exige hardware e usa mais memória/tempo. |

Os testes usam `node:test`, o runner nativo do Node, acessível por `npm test`.
Uma falha retorna código de saída diferente de zero. Não há tolerâncias de
speedup fixas: desempenho depende do equipamento e não deve tornar o teste
instável. O teste GPU básico permite renderer por software apenas como validação
funcional; o relatório informa essa condição. Ele nunca troca timer de GPU por
cronômetro de CPU quando a extensão está ausente.

## As três mudanças implementadas

### 1. Qualidade e tempo na mesma resolução

Para cada configuração, o alvo offscreen, a captura RGBA, PSNR, SSIM e telemetria
usam a mesma largura/altura. Não há captura fixa 960×540 ou reaproveitamento de
SSIM 1280×720 nas linhas de 4K. Os pixels do terreno são identificados pelo alfa
da própria captura. O céu é excluído das métricas; ele participa do passe de
cena temporizado. A preparação da máscara e a leitura de pixels ficam fora das
consultas de tempo.

O mesmo PNG é usado para PSNR e SSIM. O Python confere as dimensões reais e
recalcula o PSNR, comparando-o ao calculado no navegador. O SSIM usa luma
Rec.601, faixa 1, janela Gaussiana 11×11, sigma 1,5 e erosão 11×11 da máscara,
excluindo também janelas que ultrapassam a imagem. Não há fallback para janelas
contaminadas pela borda.

### 2. Consultas individuais e sessões independentes

Cada consulta exporta sessão, caso, método, rodada, ordem, fase (aquecimento ou
coleta), instante de submissão, disponibilidade, disjunção, duração e estado.
Os estados são `valid`, `warmup_valid`, `disjoint`, `timeout` e `invalid_result`.
Uma disjunção descarta todas as consultas pendentes, mesmo as ainda indisponíveis.
Consultas expiradas e resultados inválidos também recebem registro explícito.

Cada linha de resultado traz `n_requested`, `n_valid`, `n_discarded`, causas de
descarte, média, mediana, quartis, IQR, P95 e desvio padrão populacional. A
validação exige igualdade com as consultas brutas: uma rodada perdida não pode
desaparecer do denominador. Aquecimento não entra nas estatísticas da coleta.

O padrão de coleta é 60 draws iniciais, cinco rodadas de aquecimento e 100 de
coleta por método. A ordem alterna direta/reversa entre rodadas. Cada sessão
abre um processo e perfil novos de navegador. O resumo entre sessões preserva
as medianas de cada sessão e seu IQR, sem tratar consultas da mesma sessão
como repetições independentes. Os valores padrão são escolhas de protocolo,
não garantia automática de estabilidade estatística.

### 3. Ablação controlada de LOD e filtragem

| Método | Estimador que seleciona os regimes | Filtragem do nível inicial |
|---|---|---|
| `adap_iso` | Isotrópico | `textureGrad` |
| `adap_aniso` | Anisotrópico | `textureGrad` |
| `adap_iso_lod` | Isotrópico | `textureLod` |
| `adap_aniso_lod` | Anisotrópico | `textureLod` |

Além de separar o filtro inicial, o LOD usado para amostrar os níveis seguintes
fica fixado no estimador anisotrópico em todas as células. O seletor altera
somente os pesos/regimes; não altera ocultamente os mips amostrados. Compare
as duas primeiras linhas para o efeito de seleção com filtro constante, e
pares na mesma coluna de estimador para o efeito da filtragem inicial.

A referência comum é `nvidia_n6`, com filtragem inicial `grad` e LOD de
amostragem anisotrópico. O controle negativo força todos os fragmentos ao regime
completo: trocar o seletor deve produzir pixels idênticos para um mesmo filtro.
Esse teste detecta o acoplamento de filtragem que existia no caminho original.

## Coleta experimental, separada dos testes rápidos

```sh
# Suite completa: oito configurações, nove métodos e cinco processos/sessões.
npm run benchmark:gpu

# Dois enquadramentos PBR a 1080p, mantendo cinco sessões.
npm run benchmark:gpu -- --quick

# Verificação funcional curta, uma sessão em resoluções pequenas.
npm run benchmark:smoke
```

Cada execução cria `output/validation/run-<data>/`, sem sobrescrever execuções
anteriores. Dentro dela:

- `session-NNN/resultados_gpu.json`: configuração, hardware, dados brutos,
  agregados, métricas e caminhos das capturas.
- `session-NNN/raw_queries.csv`: uma linha por consulta, incluindo descartes.
- `session-NNN/resultados_gpu.csv` e `tabela_resultados.md`: resultados legíveis.
- `session-NNN/frames/`: PNGs na resolução de cada caso.
- `sessions_summary.json` e `.csv`: resumo dos tempos entre sessões.

É possível escolher o navegador com `--chrome /caminho/do/chromium` ou
`CHROME_PATH`. `--samples N` e `--warmup N` ajustam as rodadas. Coletas curtas e
smoke são marcadas como `functionalTestOnly`; não devem substituir a coleta
experimental. A suite completa pode gerar muitos PNGs de 4K e demorar.

Se a etapa de métricas falhar por falta de dependências, os dados brutos são
preservados. Após instalar as dependências, reanalise sem executar novamente:

```sh
python src/benchmark_gpu.py --analyze output/validation/run-<data>
```

Para servir a demonstração manualmente, após `npm ci`, use
`python -m http.server 8000` e abra `http://localhost:8000/demo_webgl/`.

O schema novo é versão 2. Os números históricos continuam sendo do protocolo
anterior; não são convertidos ou misturados automaticamente com novos resultados.
