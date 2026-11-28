# Artigo consolidado com o protocolo v2

`artigo.pdf` é a versão de 11 páginas, com os experimentos históricos e a nova
validação automatizada apresentados separadamente. O template é o da disciplina.

## Compilar

Dentro de `paper/`, com uma distribuição LaTeX completa:

```sh
latexmk -pdf artigo.tex
```

Ou execute `pdflatex artigo.tex`, `bibtex artigo` e mais duas execuções de
`pdflatex artigo.tex`. O PDF incluído foi compilado com Tectonic 0.17.0.

As entradas são `artigo.tex`, `conteudo.tex`, `secao_validacao_v2.tex`,
`referencias.bib`, `tables/validacao_v2.tex` e `figures/`.

## Verificar os registros incluídos

Na raiz do repositório:

```sh
npm ci
node paper/experiments/verify_validation_v2.mjs
```

O verificador confere hashes dos registros/ativos gerados, contagens, métricas
e a tabela usada no manuscrito. Ele não realiza nova coleta nem inventa imagens
ausentes. Os quatro JSONs selecionados estão em `validation/v2/`; cada um
preserva as consultas de GPU, configurações, resultados e ambiente.

O manifesto registra também hashes dos PNGs brutos preservados localmente.
Essas imagens não integram o pacote leve no Git. Para produzir novas capturas,
use os testes descritos em `../docs/TESTES_AUTOMATIZADOS.md`; os resultados
dependem da GPU e do driver e recebem outro diretório de execução.

As tabelas históricas continuam associadas à revisão `10293a4`. A tabela v2
documenta uma validação funcional curta na RTX 4050; seus tempos não substituem
a coleta científica de cinco sessões/100 rodadas. A submissão requer avaliação
do orientador e adequação ao template do veículo escolhido.
