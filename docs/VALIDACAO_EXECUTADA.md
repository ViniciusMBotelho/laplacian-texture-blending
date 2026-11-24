# Verificação executada em 24/11/2026

Ambiente de integração: Chrome headless 136, Windows, WebGL 2 via ANGLE/D3D11,
NVIDIA GeForce RTX 4050 Laptop GPU. A extensão de timer de GPU estava disponível.
Os testes rápidos usaram Node.js 24.11.1 e Python 3.12.14.

## Resultados

- `npm test`: **25 testes aprovados**, sem falhas ou testes ignorados. Um deles
  executa cinco casos Python de PSNR/SSIM, máscara e suporte da janela.
- `npm run test:gpu`: **dois testes aprovados**. A integração abre duas sessões
  independentes e verifica 18 combinações por sessão nas resoluções 320×180 e
  640×360. O controle negativo abre outra sessão e confirma pixels idênticos
  ao trocar o seletor sob regime completo e filtragem constante.
- `npm run test:gpu:resolutions`: **um teste aprovado**, com 18 combinações em
  1920×1080 e 3840×2160. As dimensões reais dos PNGs e os metadados de tempo
  coincidiram; PSNR e SSIM vieram das mesmas capturas.

As integrações utilizaram três rodadas de coleta e uma de aquecimento por
método, adequadas à verificação funcional. Esses tempos não constituem a coleta
experimental de cinco sessões/100 rodadas prevista pelo comando de benchmark.
As métricas de qualidade, a instrumentação e os testes foram incorporados à revisão do artigo. Os tempos curtos não foram usados para anunciar ganhos de desempenho.

## Registros locais

Os registros estão em `output/validation/`, que não é versionado:

- `integration/run-2026-11-24T15-23-24-055Z/`: duas sessões, 144 consultas
  registradas, incluindo aquecimento.
- `control/run-2026-11-24T15-23-36-825Z/`: controle negativo, 72 consultas.
- `resolution-check/run-2026-11-24T15-24-22-048Z/`: 1080p/4K, 72 consultas,
  exportação de imagens por etapas, com análise de qualidade concluída.

Cada sessão preserva JSON, CSV de consultas, CSV de resultados, tabela de
métricas e PNGs. Os perfis temporários do navegador foram removidos ao terminar.
O teste de resolução exige hardware; renderer por software só é tolerado nos
testes funcionais pequenos e recebe identificação explícita no relatório.

Uma execução exploratória mais ampla foi interrompida antes de concluir, durante
o desenvolvimento do transporte de capturas. Ela não tem relatório final e não
é evidência de aprovação. Os resultados listados acima correspondem a testes
concluídos. O transporte final exporta cada captura por etapas para limitar o
acúmulo de PNGs base64 na memória.

O artigo foi atualizado em uma etapa posterior, incorporando essas validações. O pipeline offline de mesclagem e os JSONs históricos em
`output/benchmark_gpu/` foram preservados.
