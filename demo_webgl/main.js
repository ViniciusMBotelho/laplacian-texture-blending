import * as THREE from 'three';

import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import Stats from 'three/examples/jsm/libs/stats.module';

const passthroughVS = /* glsl */`
varying vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

const MaskShader = {
    uniforms: {
        'tOriginal': { value: null },
        'threshold': { value: 0.5 },
    },
    vertexShader: passthroughVS,
    fragmentShader: /* glsl */`
        uniform sampler2D tOriginal;
        uniform float threshold;

        varying vec2 vUv;

        void main() {
            vec3 inpColor = texture2D( tOriginal, vUv ).xyz;
            gl_FragColor = vec4(vec3(clamp((inpColor.x - threshold)*140.0, 0.0, 1.0)), 1.0);
        }`
};

const CopyShader = {
    uniforms: {
        'tOriginal': { value: null },
    },
    vertexShader: passthroughVS,
    fragmentShader: /* glsl */`
        uniform sampler2D tOriginal;

        varying vec2 vUv;

        void main() {
            vec2 uv = vUv;
            vec3 inpColor = texture2D( tOriginal, uv ).xyz;
            gl_FragColor = vec4(inpColor, 1.0);
        }`
};

// Largura da faixa de transição entre zonas do modo 3 (em unidades de distFactor).
// Usada no shader (uniform) e na estimativa de custo do HUD (mesmo valor).
const TRANS_BAND = 0.12;

const FinalCombinePassShader = {
    extensions: {
        derivatives: true,
    },
    uniforms: {
        't0': { value: null },
        't1': { value: null },

        'm0': { value: null },
        'm1': { value: null },
        'm2': { value: null },
        'm3': { value: null },
        'm4': { value: null },
        'm5': { value: null },
        'm6': { value: null },
        'm7': { value: null },

        'enable': { value: 1.0 },
        'mode': { value: 3 },
        'zoom': { value: 2.5 },
        'mip': { value: 6 },
        'aspectRatio': { value: 1.0 },
        'perspectiveTilt': { value: 0.65 },
        'nearLimit': { value: 0.35 },
        'farLimit': { value: 0.75 },
        'transBand': { value: TRANS_BAND },
        'heatmap': { value: 0.0 },
        'splitCompare': { value: 0.0 },
    },
    vertexShader: passthroughVS,
    fragmentShader: /* glsl */`
        // #extension GL_OES_standard_derivatives : enable (habilitado via material.extensions.derivatives)
        //
        // Estrutura de custo (leituras de textura por pixel, L = mip):
        //   Modo 0 (Linear)        : t0, t1 no nível 0 + máscara m[L+1]              = 3 leituras
        //   Modo 1 (NVIDIA)        : t0/t1 nos níveis 0..L + máscaras m[1..L+1]       = 3(L+1)
        //   Modo 2 (Level Skipping): t0/t1 só nos níveis pares <= L (+ nível L se L for
        //                            ímpar) + máscaras correspondentes                 = 3(ceil(L/2)+1)
        //   Modo 3 (Adaptativo)    : desvio de fluxo por zona de distFactor; só executa
        //                            os regimes com peso > 0 (2 regimes nas faixas de transição).
        // Cada modo fica em uma função própria e só é chamado quando necessário:
        // nenhuma leitura é feita "por precaução" no início do main().
        uniform sampler2D t0;
        uniform sampler2D t1;

        uniform sampler2D m0;
        uniform sampler2D m1;
        uniform sampler2D m2;
        uniform sampler2D m3;
        uniform sampler2D m4;
        uniform sampler2D m5;
        uniform sampler2D m6;
        uniform sampler2D m7;

        uniform float enable;
        uniform int mode;
        uniform float zoom;
        uniform int mip;

        uniform float aspectRatio;
        uniform float perspectiveTilt;
        uniform float nearLimit;
        uniform float farLimit;
        uniform float transBand;
        uniform float heatmap;
        uniform float splitCompare;

        varying vec2 vUv;

        #define LVL_CNT 6

        // Máscara do nível idx (0..7). GLSL ES 1.0 não permite indexar samplers com
        // índice dinâmico, então a escolha é feita com if encadeados: só UMA leitura
        // de textura é executada por chamada.
        vec4 maskAt(int idx, vec2 p) {
            if (idx <= 0) return texture2D(m0, p);
            else if (idx == 1) return texture2D(m1, p);
            else if (idx == 2) return texture2D(m2, p);
            else if (idx == 3) return texture2D(m3, p);
            else if (idx == 4) return texture2D(m4, p);
            else if (idx == 5) return texture2D(m5, p);
            else if (idx == 6) return texture2D(m6, p);
            return texture2D(m7, p);
        }

        // Modo 0: Linear Blend. 3 leituras: t0, t1 (nível base) e a máscara m[mip+1]
        // (mesma máscara usada no resíduo do código original).
        vec4 blendLinear(vec2 p) {
            vec4 m = maskAt(mip + 1, p);
            return texture2D(t0, p) * m + texture2D(t1, p) * (vec4(1.0) - m);
        }

        // Modo 1: NVIDIA original (pirâmide laplaciana completa, níveis 0..mip).
        // Banda i = G[i] - G[i+1], misturada com m[i+1]; resíduo G[mip] com m[mip+1].
        // O nível do mip é escolhido por bias em texture2D (igual ao código da NVIDIA).
        // Cada nível é lido uma única vez (G[i+1] é reaproveitado como G[i] do passo seguinte).
        // Leituras: 2 (nível 0) + 3*mip (t0, t1, máscara por banda) + 1 (máscara do resíduo) = 3(mip+1).
        vec4 blendFull(vec2 p) {
            vec4 a0 = texture2D(t0, p, 0.0);
            vec4 a1 = texture2D(t1, p, 0.0);
            vec4 acc = vec4(0.0);
            for (int i = 0; i < LVL_CNT; i++) {
                if (i >= mip) break;
                float nb = float(i + 1);
                vec4 b0 = texture2D(t0, p, nb);
                vec4 b1 = texture2D(t1, p, nb);
                vec4 m = maskAt(i + 1, p);
                acc += (a0 - b0) * m + (a1 - b1) * (vec4(1.0) - m);
                a0 = b0;
                a1 = b1;
            }
            vec4 mr = maskAt(mip + 1, p);
            return acc + a0 * mr + a1 * (vec4(1.0) - mr);
        }

        // Modo 2: Level Skipping (passo 2). Bandas G[i] - G[i+2] para i = 0, 2, 4...,
        // misturadas com m[i+1]. Só os níveis pares são lidos.
        // Se mip for ímpar, o último salto é de 1 nível (G[mip-1] - G[mip]), para que o
        // resíduo continue sendo G[mip] e a soma telescópica reconstrua a imagem
        // (mesmo comportamento da versão anterior). Ex.: mip=5 -> níveis 0,2,4,5.
        // Leituras: 3 * (ceil(mip/2) + 1). mip=6 -> níveis 0,2,4,6 -> 12 leituras.
        vec4 blendSkip(vec2 p) {
            vec4 a0 = texture2D(t0, p, 0.0);
            vec4 a1 = texture2D(t1, p, 0.0);
            vec4 acc = vec4(0.0);
            for (int i = 0; i < LVL_CNT; i += 2) {
                if (i >= mip) break;
                int nxt = (i + 2 <= mip) ? (i + 2) : mip;
                float nb = float(nxt);
                vec4 b0 = texture2D(t0, p, nb);
                vec4 b1 = texture2D(t1, p, nb);
                vec4 m = maskAt(i + 1, p);
                acc += (a0 - b0) * m + (a1 - b1) * (vec4(1.0) - m);
                a0 = b0;
                a1 = b1;
            }
            vec4 mr = maskAt(mip + 1, p);
            return acc + a0 * mr + a1 * (vec4(1.0) - mr);
        }

        void main() {
            // Coordenada plana base (sem inclinação de perspectiva)
            vec2 flatUv = vec2(vUv.x * aspectRatio, vUv.y) / vec2(zoom);

            // Projeção de plano em perspectiva (vUv.y = 0 próximo à câmera, vUv.y = 1 horizonte)
            float perspDenom = max(1.0 - vUv.y * perspectiveTilt * 0.68, 0.18);
            float depthFactor = 1.0 / perspDenom;
            vec2 centeredUv = vec2((vUv.x - 0.5) * aspectRatio, vUv.y);
            vec2 uv = vec2(
                (centeredUv.x * depthFactor + 0.5 * aspectRatio) / zoom,
                (centeredUv.y * mix(1.0, depthFactor, 0.85)) / zoom
            );

            // Fator contínuo de distância [0.0, 1.0] combinando derivadas dFdx/dFdy e profundidade vUv.y.
            // Calculado ANTES de qualquer desvio de fluxo (derivadas exigem fluxo uniforme).
            float flatGrad = max(length(dFdx(flatUv)) + length(dFdy(flatUv)), 1e-6);
            float perspGrad = length(dFdx(uv)) + length(dFdy(uv));
            float derivRatio = clamp((perspGrad / flatGrad - 1.0) / max(perspectiveTilt * 2.2, 0.001), 0.0, 1.0);
            float distFactor = clamp(
                mix(vUv.y, mix(vUv.y, derivRatio, 0.35), smoothstep(0.0, 0.1, perspectiveTilt)),
                0.0,
                1.0
            );

            // Seleção do modo ativo
            int activeMode = mode;
            if (enable < 0.5) {
                activeMode = 0;
            }

            // Split Compare: esquerda (vUv.x < 0.5) = NVIDIA Original (Modo 1) | direita = Modo Selecionado
            if (splitCompare > 0.5 && vUv.x < 0.5) {
                activeMode = 1;
            }

            // Limites das zonas do modo 3 (usados também nas linhas-guia do heatmap)
            float nLim = min(nearLimit, farLimit - 0.05);
            float fLim = max(farLimit, nearLimit + 0.05);

            // Regimes realmente executados neste pixel (para o heatmap)
            float execFull = 0.0;
            float execSkip = 0.0;
            float execLin  = 0.0;

            vec4 finalColor = vec4(0.0);
            if (activeMode == 0) {
                finalColor = blendLinear(uv);
                execLin = 1.0;
            } else if (activeMode == 1) {
                finalColor = blendFull(uv);
                execFull = 1.0;
            } else if (activeMode == 2) {
                finalColor = blendSkip(uv);
                execSkip = 1.0;
            } else {
                // Modo 3: Proposta Adaptativa por Distância (LOD + Level Skipping).
                // Pesos das transições: smoothstep devolve exatamente 0.0 ou 1.0 fora da
                // faixa [lim - transBand, lim + transBand]. Um regime só é executado se
                // tiver peso > 0 no resultado final:
                //   zona próxima       -> só pirâmide completa
                //   zona intermediária -> só level skipping
                //   zona distante      -> só linear
                //   faixas de transição -> os dois regimes vizinhos, misturados (sem popping)
                float wNearToMid = smoothstep(nLim - transBand, nLim + transBand, distFactor);
                float wMidToFar  = smoothstep(fLim - transBand, fLim + transBand, distFactor);

                vec4 cFull = vec4(0.0);
                vec4 cSkip = vec4(0.0);
                vec4 cLin  = vec4(0.0);

                // Observação: o desvio é não-uniforme entre pixels, mas uv (e suas derivadas
                // implícitas usadas na seleção de mip) é calculado antes dele, e distFactor
                // varia suavemente na tela, então quads 2x2 quase sempre seguem o mesmo ramo.
                if (wNearToMid < 1.0 && wMidToFar < 1.0) {
                    cFull = blendFull(uv);
                    execFull = 1.0;
                }
                if (wNearToMid > 0.0 && wMidToFar < 1.0) {
                    cSkip = blendSkip(uv);
                    execSkip = 1.0;
                }
                if (wMidToFar > 0.0) {
                    cLin = blendLinear(uv);
                    execLin = 1.0;
                }

                // Mesma fórmula de mistura da versão anterior; termos não executados têm peso 0.
                finalColor = mix(mix(cFull, cSkip, wNearToMid), cLin, wMidToFar);
            }

            // Visualização de Debug Heatmap (regime realmente executado no pixel)
            if (heatmap > 0.5) {
                vec3 colHigh = vec3(0.95, 0.22, 0.20); // Vermelho: Pirâmide Completa
                vec3 colMid  = vec3(0.95, 0.75, 0.15); // Amarelo/Laranja: Level Skipping
                vec3 colLow  = vec3(0.15, 0.82, 0.40); // Verde: Linear Blend

                // Lista ordenada dos regimes executados. Com 1 regime: cor sólida.
                // Com 2 ou 3 regimes (faixa de transição, custo somado): listras
                // diagonais alternando as cores dos regimes executados.
                float nExec = execFull + execSkip + execLin;
                vec3 firstCol  = execFull > 0.5 ? colHigh : (execSkip > 0.5 ? colMid : colLow);
                vec3 secondCol = (execFull > 0.5 && execSkip > 0.5) ? colMid : colLow;
                vec3 thirdCol  = colLow;
                float stripe = mod(floor((gl_FragCoord.x + gl_FragCoord.y) / 10.0), max(nExec, 1.0));
                vec3 heatColor = stripe < 0.5 ? firstCol : (stripe < 1.5 ? secondCol : thirdCol);

                float luma = dot(finalColor.rgb, vec3(0.299, 0.587, 0.114));
                vec3 shadedHeat = mix(finalColor.rgb, heatColor * (0.52 + 0.68 * luma), 0.68);

                // Linhas guias sutis nos limiares nearLimit e farLimit para o modo adaptativo
                if (activeMode == 3) {
                    float nearLine = 1.0 - smoothstep(0.0, 0.004, abs(distFactor - nLim));
                    float farLine  = 1.0 - smoothstep(0.0, 0.004, abs(distFactor - fLim));
                    float guideMask = max(nearLine, farLine) * 0.45;
                    shadedHeat = mix(shadedHeat, vec3(1.0), guideMask);
                }

                finalColor.rgb = shadedHeat;
            }

            // Linha divisória vertical sutil no modo Split Compare
            if (splitCompare > 0.5) {
                float splitLine = 1.0 - smoothstep(0.0008, 0.0022, abs(vUv.x - 0.5));
                finalColor.rgb = mix(finalColor.rgb, vec3(0.22, 0.74, 0.97), splitLine * 0.85);
            }

            gl_FragColor = vec4(finalColor.rgb, 1.0);
        }`
};

const TerrainShader = {
    extensions: {
        derivatives: true,
    },
    uniforms: {
        't0': { value: null },
        't1': { value: null },

        'm0': { value: null },
        'm1': { value: null },
        'm2': { value: null },
        'm3': { value: null },
        'm4': { value: null },
        'm5': { value: null },
        'm6': { value: null },
        'm7': { value: null },

        'enable': { value: 1.0 },
        'mode': { value: 3 },
        'zoom': { value: 2.5 },
        'mip': { value: 6 },
        'perspectiveTilt': { value: 0.65 },
        'nearLimit': { value: 0.35 },
        'farLimit': { value: 0.75 },
        'transBand': { value: TRANS_BAND },
        'heatmap': { value: 0.0 },
        'splitCompare': { value: 0.0 },
        'resolution': { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        varying vec3 vNormal;

        void main() {
            vUv = uv;
            vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
            vWorldPosition = worldPosition.xyz;
            // Transforma a normal para coordenadas de mundo preservando a direção da iluminação
            vNormal = normalize( mat3( modelMatrix ) * normal );
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
    `,
    fragmentShader: /* glsl */`
        uniform sampler2D t0;
        uniform sampler2D t1;

        uniform sampler2D m0;
        uniform sampler2D m1;
        uniform sampler2D m2;
        uniform sampler2D m3;
        uniform sampler2D m4;
        uniform sampler2D m5;
        uniform sampler2D m6;
        uniform sampler2D m7;

        uniform float enable;
        uniform int mode;
        uniform float zoom;
        uniform int mip;

        uniform float perspectiveTilt;
        uniform float nearLimit;
        uniform float farLimit;
        uniform float transBand;
        uniform float heatmap;
        uniform float splitCompare;
        uniform vec2 resolution;

        varying vec2 vUv;
        varying vec3 vWorldPosition;
        varying vec3 vNormal;

        #define LVL_CNT 6

        vec4 maskAt(int idx, vec2 p) {
            if (idx <= 0) return texture2D(m0, p);
            else if (idx == 1) return texture2D(m1, p);
            else if (idx == 2) return texture2D(m2, p);
            else if (idx == 3) return texture2D(m3, p);
            else if (idx == 4) return texture2D(m4, p);
            else if (idx == 5) return texture2D(m5, p);
            else if (idx == 6) return texture2D(m6, p);
            return texture2D(m7, p);
        }

        vec4 blendLinear(vec2 p) {
            vec4 m = maskAt(mip + 1, p);
            return texture2D(t0, p) * m + texture2D(t1, p) * (vec4(1.0) - m);
        }

        vec4 blendFull(vec2 p) {
            vec4 a0 = texture2D(t0, p, 0.0);
            vec4 a1 = texture2D(t1, p, 0.0);
            vec4 acc = vec4(0.0);
            for (int i = 0; i < LVL_CNT; i++) {
                if (i >= mip) break;
                float nb = float(i + 1);
                vec4 b0 = texture2D(t0, p, nb);
                vec4 b1 = texture2D(t1, p, nb);
                vec4 m = maskAt(i + 1, p);
                acc += (a0 - b0) * m + (a1 - b1) * (vec4(1.0) - m);
                a0 = b0;
                a1 = b1;
            }
            vec4 mr = maskAt(mip + 1, p);
            return acc + a0 * mr + a1 * (vec4(1.0) - mr);
        }

        vec4 blendSkip(vec2 p) {
            vec4 a0 = texture2D(t0, p, 0.0);
            vec4 a1 = texture2D(t1, p, 0.0);
            vec4 acc = vec4(0.0);
            for (int i = 0; i < LVL_CNT; i += 2) {
                if (i >= mip) break;
                int nxt = (i + 2 <= mip) ? (i + 2) : mip;
                float nb = float(nxt);
                vec4 b0 = texture2D(t0, p, nb);
                vec4 b1 = texture2D(t1, p, nb);
                vec4 m = maskAt(i + 1, p);
                acc += (a0 - b0) * m + (a1 - b1) * (vec4(1.0) - m);
                a0 = b0;
                a1 = b1;
            }
            vec4 mr = maskAt(mip + 1, p);
            return acc + a0 * mr + a1 * (vec4(1.0) - mr);
        }

        void main() {
            // Coordenada UV com tiling repetido sobre o terreno 3D
            vec2 uv = (vUv * 8.0) / zoom;

            // Posição de tela normalizada em X para o Split Compare
            float screenX = gl_FragCoord.x / max(resolution.x, 1.0);

            // Distância física real da câmera 3D até o fragmento da superfície
            float vDistance = length(cameraPosition - vWorldPosition);

            // Derivadas espaciais UV para acomodar relevo inclinado / ângulos rasantes
            float geomGrad = length(dFdx(vUv * 6.0)) + length(dFdy(vUv * 6.0));

            // Fator contínuo de distância [0.0, 1.0]
            float tiltScale = mix(0.7, 1.35, perspectiveTilt);
            float distNorm = clamp((vDistance - 16.0) / (46.0 / max(tiltScale, 0.1)), 0.0, 1.0);
            float distFactor = clamp(distNorm * 0.90 + clamp(geomGrad * 0.10, 0.0, 0.10), 0.0, 1.0);

            // Modo ativo
            int activeMode = mode;
            if (enable < 0.5) {
                activeMode = 0;
            }

            // Split Compare: metade esquerda da tela = NVIDIA Original (Modo 1)
            if (splitCompare > 0.5 && screenX < 0.5) {
                activeMode = 1;
            }

            float nLim = min(nearLimit, farLimit - 0.05);
            float fLim = max(farLimit, nearLimit + 0.05);

            float execFull = 0.0;
            float execSkip = 0.0;
            float execLin  = 0.0;

            vec4 finalColor = vec4(0.0);
            if (activeMode == 0) {
                finalColor = blendLinear(uv);
                execLin = 1.0;
            } else if (activeMode == 1) {
                finalColor = blendFull(uv);
                execFull = 1.0;
            } else if (activeMode == 2) {
                finalColor = blendSkip(uv);
                execSkip = 1.0;
            } else {
                // Modo 3: Proposta Adaptativa por Distância Real da Câmera
                float wNearToMid = smoothstep(nLim - transBand, nLim + transBand, distFactor);
                float wMidToFar  = smoothstep(fLim - transBand, fLim + transBand, distFactor);

                vec4 cFull = vec4(0.0);
                vec4 cSkip = vec4(0.0);
                vec4 cLin  = vec4(0.0);

                if (wNearToMid < 1.0 && wMidToFar < 1.0) {
                    cFull = blendFull(uv);
                    execFull = 1.0;
                }
                if (wNearToMid > 0.0 && wMidToFar < 1.0) {
                    cSkip = blendSkip(uv);
                    execSkip = 1.0;
                }
                if (wMidToFar > 0.0) {
                    cLin = blendLinear(uv);
                    execLin = 1.0;
                }

                finalColor = mix(mix(cFull, cSkip, wNearToMid), cLin, wMidToFar);
            }

            // Iluminação direcional difusa suave para realçar as colinas e vales do terreno 3D
            vec3 lightDir = normalize(vec3(0.35, 0.85, 0.40));
            float diff = max(dot(normalize(vNormal), lightDir), 0.0);
            float lighting = 0.60 + 0.40 * diff;
            finalColor.rgb *= lighting;

            // Visualização de Debug Heatmap (Custo TMU) sobre as colinas do terreno
            if (heatmap > 0.5) {
                vec3 colHigh = vec3(0.95, 0.22, 0.20); // Vermelho: Pirâmide Completa
                vec3 colMid  = vec3(0.95, 0.75, 0.15); // Amarelo/Laranja: Level Skipping
                vec3 colLow  = vec3(0.15, 0.82, 0.40); // Verde: Linear Blend

                float nExec = execFull + execSkip + execLin;
                vec3 firstCol  = execFull > 0.5 ? colHigh : (execSkip > 0.5 ? colMid : colLow);
                vec3 secondCol = (execFull > 0.5 && execSkip > 0.5) ? colMid : colLow;
                vec3 thirdCol  = colLow;
                float stripe = mod(floor((gl_FragCoord.x + gl_FragCoord.y) / 10.0), max(nExec, 1.0));
                vec3 heatColor = stripe < 0.5 ? firstCol : (stripe < 1.5 ? secondCol : thirdCol);

                float luma = dot(finalColor.rgb, vec3(0.299, 0.587, 0.114));
                vec3 shadedHeat = mix(finalColor.rgb, heatColor * (0.52 + 0.68 * luma), 0.70);

                // Curvas de nível nos limiares de transição de regime
                if (activeMode == 3) {
                    float nearLine = 1.0 - smoothstep(0.0, 0.007, abs(distFactor - nLim));
                    float farLine  = 1.0 - smoothstep(0.0, 0.007, abs(distFactor - fLim));
                    float guideMask = max(nearLine, farLine) * 0.55;
                    shadedHeat = mix(shadedHeat, vec3(1.0), guideMask);
                }

                finalColor.rgb = shadedHeat;
            }

            // Linha divisória vertical do Split Compare
            if (splitCompare > 0.5) {
                float splitLine = 1.0 - smoothstep(0.0008, 0.0022, abs(screenX - 0.5));
                finalColor.rgb = mix(finalColor.rgb, vec3(0.22, 0.74, 0.97), splitLine * 0.85);
            }

            gl_FragColor = vec4(finalColor.rgb, 1.0);
        }
    `
};

const params = {
    viewMode: '3d',
    mode: 3,
    perspectiveTilt: 0.65,
    nearLimit: 0.35,
    farLimit: 0.75,
    heatmap: false,
    splitCompare: false,
    enable: true,
    threshold: 0.6,
    zoom: 2.5,
    mip: 6.0,
    tex0: 1,
    tex1: 3,
    save: saveAsImage,
};

let renderer, effectCopy, effectFinalCombine, effectMask, mips, textures, aspectRatio;
let scene3D, camera3D, controls, terrainMesh, terrainMaterial;

const stats = Stats();
document.body.appendChild(stats.dom);

// Medição de tempo: intervalo entre frames (CPU, performance.now) e GPU (timer query, se houver)
const frameTiming = { last: null, emaMs: null, cpuEmaMs: null };
let gpuTimer = null;
let rafPending = false;

// Grade de amostras de vUv usada na estimativa de custo do HUD (e cache do resultado)
const COST_GRID = 64;
let costCache = { key: null, value: null };

init();

function init() {
    aspectRatio = window.innerWidth / window.innerHeight;
    renderer = new THREE.WebGLRenderer();
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.outputEncoding = THREE.LinearEncoding;

    gpuTimer = initGpuTimer();

    let loaded = 0;
    mips = new Object();
    textures = new Object();
    let loadData = function (tex, name) {
        tex.wrapS = THREE.MirroredRepeatWrapping;
        tex.wrapT = THREE.MirroredRepeatWrapping;
        tex.needsUpdate = true;

        const material = new THREE.MeshBasicMaterial({ map: tex });
        if (name == "mask") {
            let w = tex.image.width;
            let h = tex.image.height;

            let sharedProps = {
                minFilter: THREE.LinearFilter,
                magFilter: THREE.LinearFilter,
                wrapS: THREE.MirroredRepeatWrapping,
                wrapT: THREE.MirroredRepeatWrapping,
                format: THREE.RGBAFormat,
                type: THREE.UnsignedByteType
            };

            let mips_l = [];
            while (w > 1 && h > 1) {
                mips_l.push(new THREE.WebGLRenderTarget(w, h, sharedProps));
                w = w / 2;
                h = h / 2;
            }

            mips[name] = mips_l;
        }

        textures[name] = tex;

        loaded += 1;
        if (loaded == 7)
            render();
    };

    new THREE.TextureLoader().load("1.jpg", function ( texture ) {loadData(texture, "0")});
    new THREE.TextureLoader().load("2.jpg", function ( texture ) {loadData(texture, "1")});
    new THREE.TextureLoader().load("1rot.jpg", function ( texture ) {loadData(texture, "2")});
    new THREE.TextureLoader().load("2rot.jpg", function ( texture ) {loadData(texture, "3")});
    new THREE.TextureLoader().load("normal0.jpg", function ( texture ) {loadData(texture, "4")});
    new THREE.TextureLoader().load("normal1.jpg", function ( texture ) {loadData(texture, "5")});
    new THREE.TextureLoader().load("perlin.jpg", function ( texture ) {loadData(texture, "mask")});

    effectCopy = new ShaderPass(CopyShader);
    effectFinalCombine = new ShaderPass(FinalCombinePassShader);
    effectFinalCombine.material.extensions.derivatives = true;
    effectMask = new ShaderPass(MaskShader, null);

    // Cena 3D Real com Terreno e Câmera Perspectiva Interativa
    scene3D = new THREE.Scene();
    scene3D.background = new THREE.Color(0x090d16);

    camera3D = new THREE.PerspectiveCamera(45, aspectRatio, 0.1, 1000);
    camera3D.position.set(0, 18, 32);

    controls = new OrbitControls(camera3D, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.05; // Evita que a câmera passe abaixo da base
    controls.minDistance = 2;
    controls.maxDistance = 120;
    controls.target.set(0, 0, 0);

    // Malha do Terreno 3D com relevo procedural suave (colinas e vales)
    const terrainGeometry = new THREE.PlaneGeometry(60, 60, 128, 128);
    const pos = terrainGeometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = Math.sin(x * 0.12) * Math.cos(y * 0.12) * 2.4
                + Math.sin(x * 0.05 + y * 0.04) * 3.2
                + Math.cos(x * 0.22 - y * 0.18) * 0.7;
        pos.setZ(i, z);
    }
    terrainGeometry.computeVertexNormals();

    terrainMaterial = new THREE.ShaderMaterial({
        extensions: { derivatives: true },
        uniforms: THREE.UniformsUtils.clone(TerrainShader.uniforms),
        vertexShader: TerrainShader.vertexShader,
        fragmentShader: TerrainShader.fragmentShader,
    });

    terrainMesh = new THREE.Mesh(terrainGeometry, terrainMaterial);
    terrainMesh.rotation.x = -Math.PI / 2;
    scene3D.add(terrainMesh);

    const gui = new GUI({ width: 330 });

    gui.add(params, 'viewMode', {
        '3D: Terreno em Perspectiva': '3d',
        '2D: Inspeção Plana': '2d',
    }).name('viewMode').onChange((val) => {
        if (controls) {
            controls.enabled = (val === '3d');
        }
        updateMetricsHUD();
    });

    gui.add(params, 'mode', {
        '0: Baseline - Linear Blend': 0,
        '1: NVIDIA Original (Completa)': 1,
        '2: Level Skipping (Passo 2)': 2,
        '3: Proposta Adaptativa (LOD + Skip)': 3,
    }).name('mode (Mesclagem)');

    gui.add(params, 'perspectiveTilt', 0.0, 1.0, 0.01).name('perspectiveTilt');
    gui.add(params, 'nearLimit', 0.10, 0.65, 0.01).name('nearLimit (Zona 1→2)');
    gui.add(params, 'farLimit', 0.35, 0.95, 0.01).name('farLimit (Zona 2→3)');
    gui.add(params, 'heatmap').name('heatmap (Custo TMU)');
    gui.add(params, 'splitCompare').name('splitCompare (NVIDIA|Proposta)');

    gui.add(params, 'enable');
    gui.add(params, 'threshold', 0.0, 1.0);
    gui.add(params, 'zoom', 1.0, 4.0);
    gui.add(params, 'mip', 0, 6, 1.0);
    gui.add(params, 'tex0', { Texture0: 0, Texture1: 1, Texture0Rotated: 2, Texture1Rotated: 3, Normal0: 4, Normal1: 5 });
    gui.add(params, 'tex1', { Texture0: 0, Texture1: 1, Texture0Rotated: 2, Texture1Rotated: 3, Normal0: 4, Normal1: 5 });
    gui.add(params, 'save');

    gui.open();
    updateMetricsHUD();
}

window.addEventListener('resize', onWindowResize, false);

// ---------------------------------------------------------------------------
// Timer de GPU (EXT_disjoint_timer_query_webgl2 / EXT_disjoint_timer_query).
// Mede só o passo final (FinalCombinePass), que é onde os modos diferem.
// Resultados chegam com alguns frames de atraso; lidos de forma assíncrona.
// ---------------------------------------------------------------------------
function initGpuTimer() {
    const gl = renderer.getContext();
    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const ext = isWebGL2
        ? gl.getExtension('EXT_disjoint_timer_query_webgl2')
        : gl.getExtension('EXT_disjoint_timer_query');
    if (!ext) return null;
    return { gl, ext, isWebGL2, pending: [], active: null, emaMs: null };
}

function gpuTimerBegin() {
    if (!gpuTimer || gpuTimer.active || gpuTimer.pending.length > 4) return;
    const { gl, ext, isWebGL2 } = gpuTimer;
    const q = isWebGL2 ? gl.createQuery() : ext.createQueryEXT();
    if (isWebGL2) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    else ext.beginQueryEXT(ext.TIME_ELAPSED_EXT, q);
    gpuTimer.active = q;
}

function gpuTimerEnd() {
    if (!gpuTimer || !gpuTimer.active) return;
    const { gl, ext, isWebGL2 } = gpuTimer;
    if (isWebGL2) gl.endQuery(ext.TIME_ELAPSED_EXT);
    else ext.endQueryEXT(ext.TIME_ELAPSED_EXT);
    gpuTimer.pending.push(gpuTimer.active);
    gpuTimer.active = null;
}

function gpuTimerPoll() {
    if (!gpuTimer) return;
    const { gl, ext, isWebGL2, pending } = gpuTimer;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    while (pending.length > 0) {
        const q = pending[0];
        const available = isWebGL2
            ? gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)
            : ext.getQueryObjectEXT(q, ext.QUERY_RESULT_AVAILABLE_EXT);
        if (!available) break;
        pending.shift();
        if (!disjoint) {
            const ns = isWebGL2
                ? gl.getQueryParameter(q, gl.QUERY_RESULT)
                : ext.getQueryObjectEXT(q, ext.QUERY_RESULT_EXT);
            const ms = ns / 1e6;
            gpuTimer.emaMs = gpuTimer.emaMs === null ? ms : gpuTimer.emaMs * 0.9 + ms * 0.1;
        }
        if (isWebGL2) gl.deleteQuery(q);
        else ext.deleteQueryEXT(q);
    }
}

// ---------------------------------------------------------------------------
// Estimativa de custo (leituras de textura por pixel) coerente com o shader.
// ---------------------------------------------------------------------------

// Custo por regime, em leituras de textura. Por nível usado: t0 + t1 + máscara = 3.
function regimeCosts(L) {
    return {
        full: 3 * (L + 1),                 // níveis 0..L
        skip: 3 * (Math.ceil(L / 2) + 1),  // níveis pares <= L (+ L se ímpar)
        lin: 3,                            // t0, t1, máscara
    };
}

function smoothstepJS(e0, e1, x) {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

// uv em perspectiva do shader, sem a divisão por zoom (zoom multiplica igualmente
// flatGrad e perspGrad, então não altera a razão entre eles).
function perspUvJS(x, y, a, tilt) {
    const D = 1.0 / Math.max(1.0 - y * tilt * 0.68, 0.18);
    return [((x - 0.5) * a * D + 0.5 * a), y * (1.0 + (D - 1.0) * 0.85)];
}

// Réplica de distFactor do fragment shader.
// dFdx/dFdy não existem em JS: são aproximados por diferenças finitas de 1 pixel
// (dx = 1/W, dy = 1/H em vUv), que é o que o hardware calcula dentro de cada quad 2x2.
function distFactorJS(x, y, W, H, tilt) {
    const a = W / H;
    const dx = 1.0 / W;
    const dy = 1.0 / H;
    // flatUv = (x*a, y): dFdx -> (a*dx, 0), dFdy -> (0, dy)
    const flatGrad = Math.max(a * dx + dy, 1e-6);
    const p = perspUvJS(x, y, a, tilt);
    const px = perspUvJS(x + dx, y, a, tilt);
    const py = perspUvJS(x, y + dy, a, tilt);
    const perspGrad = Math.hypot(px[0] - p[0], px[1] - p[1]) + Math.hypot(py[0] - p[0], py[1] - p[1]);
    const derivRatio = Math.max(0, Math.min(1, (perspGrad / flatGrad - 1.0) / Math.max(tilt * 2.2, 0.001)));
    const k = smoothstepJS(0.0, 0.1, tilt);
    const inner = y + (derivRatio - y) * 0.35;           // mix(vUv.y, derivRatio, 0.35)
    return Math.max(0, Math.min(1, y + (inner - y) * k)); // mix(vUv.y, inner, k)
}

// Percorre uma grade COST_GRID x COST_GRID de vUv, decide o modo/regimes de cada amostra
// exatamente como o shader (incluindo split-compare e faixas de transição) e soma as leituras.
function estimateCost() {
    const W = Math.max(1, renderer ? renderer.domElement.width : window.innerWidth);
    const H = Math.max(1, renderer ? renderer.domElement.height : window.innerHeight);
    const L = Math.max(0, Math.min(6, Math.round(params.mip)));
    const key = [W, H, L, params.mode, params.enable, params.splitCompare,
        params.perspectiveTilt, params.nearLimit, params.farLimit].join('|');
    if (costCache.key === key) return costCache.value;

    const c = regimeCosts(L);
    const tilt = params.perspectiveTilt;
    const nLim = Math.min(params.nearLimit, params.farLimit - 0.05);
    const fLim = Math.max(params.farLimit, params.nearLimit + 0.05);
    const tb = TRANS_BAND;

    let total = 0;
    let nFull = 0, nSkip = 0, nLin = 0, nTrans = 0;
    const N = COST_GRID * COST_GRID;

    for (let j = 0; j < COST_GRID; j++) {
        const y = (j + 0.5) / COST_GRID;
        for (let i = 0; i < COST_GRID; i++) {
            const x = (i + 0.5) / COST_GRID;

            let mode = params.enable ? Number(params.mode) : 0;
            if (params.splitCompare && x < 0.5) mode = 1;

            let eFull = false, eSkip = false, eLin = false;
            if (mode === 0) eLin = true;
            else if (mode === 1) eFull = true;
            else if (mode === 2) eSkip = true;
            else {
                const d = distFactorJS(x, y, W, H, tilt);
                const wNM = smoothstepJS(nLim - tb, nLim + tb, d);
                const wMF = smoothstepJS(fLim - tb, fLim + tb, d);
                eFull = wNM < 1.0 && wMF < 1.0;
                eSkip = wNM > 0.0 && wMF < 1.0;
                eLin = wMF > 0.0;
            }

            const nExec = (eFull ? 1 : 0) + (eSkip ? 1 : 0) + (eLin ? 1 : 0);
            total += (eFull ? c.full : 0) + (eSkip ? c.skip : 0) + (eLin ? c.lin : 0);
            if (nExec > 1) nTrans++;
            else if (eFull) nFull++;
            else if (eSkip) nSkip++;
            else nLin++;
        }
    }

    const value = {
        L,
        costs: c,
        avg: total / N,
        pctFull: nFull / N,
        pctSkip: nSkip / N,
        pctLin: nLin / N,
        pctTrans: nTrans / N,
    };
    costCache = { key, value };
    return value;
}

function updateMetricsHUD() {
    const elMode = document.getElementById('hud-mode');
    const elBadge = document.getElementById('hud-badge');
    const elFetches = document.getElementById('hud-fetches');
    const elBaselineRef = document.getElementById('hud-baseline-ref');
    const elSavings = document.getElementById('hud-savings');
    const elSavingsSub = document.getElementById('hud-savings-sub');
    const elZoneNear = document.getElementById('hud-zone-near');
    const elZoneMid = document.getElementById('hud-zone-mid');
    const elZoneFar = document.getElementById('hud-zone-far');
    const elZoneTrans = document.getElementById('hud-zone-trans');
    const elFrame = document.getElementById('hud-frame');
    const elGpu = document.getElementById('hud-gpu');
    const elSplitBanner = document.getElementById('split-banner');
    const elSplitRight = document.getElementById('split-right-label');

    if (!elMode) return;

    const est = estimateCost();
    const L = est.L;
    const fetchesFull = est.costs.full;

    const activeMode = params.enable ? Number(params.mode) : 0;

    const modeMeta = {
        0: { title: '0: Baseline - Linear Blend (Lerp)', badge: 'BASELINE', short: 'Linear Blend' },
        1: { title: '1: NVIDIA Original (Pirâmide Completa)', badge: 'NVIDIA 2025', short: 'NVIDIA Original' },
        2: { title: '2: Level Skipping (Salto de Níveis - Passo 2)', badge: 'SKIPPING', short: 'Level Skipping' },
        3: { title: '3: Proposta Adaptativa (LOD + Level Skipping)', badge: 'PROPOSTA', short: 'Proposta Adaptativa' },
    };

    const meta = modeMeta[activeMode] || modeMeta[3];
    // Média de leituras/pixel na tela inteira (inclui a metade esquerda em modo 1 no split-compare)
    const taps = est.avg;
    const savingsPct = fetchesFull > 0 ? ((fetchesFull - taps) / fetchesFull) * 100.0 : 0.0;

    elMode.textContent = meta.title;
    elBadge.textContent = meta.badge;
    elFetches.textContent = `~${taps.toFixed(1)} taps`;
    elBaselineRef.textContent = `NVIDIA (mip ${L}): ${fetchesFull.toFixed(0)} taps · grade ${COST_GRID}×${COST_GRID}`;

    if (savingsPct > 0.05) {
        elSavings.textContent = `-${savingsPct.toFixed(1)}% fetches`;
        elSavings.className = 'hud-metric-value hud-savings-positive';
        elSavingsSub.textContent = `~${(fetchesFull - taps).toFixed(1)} leituras/px a menos`;
    } else {
        elSavings.textContent = '0.0% (Referência)';
        elSavings.className = 'hud-metric-value hud-savings-neutral';
        elSavingsSub.textContent = 'Custo máximo em toda a tela';
    }

    const pct = (v) => `${(v * 100).toFixed(1)}%`;
    elZoneNear.textContent = `${est.costs.full} taps · ${pct(est.pctFull)}`;
    elZoneMid.textContent = `${est.costs.skip} taps · ${pct(est.pctSkip)}`;
    elZoneFar.textContent = `${est.costs.lin} taps · ${pct(est.pctLin)}`;
    if (elZoneTrans) elZoneTrans.textContent = `soma de 2 regimes · ${pct(est.pctTrans)}`;

    if (elFrame) {
        if (frameTiming.emaMs !== null) {
            const fps = 1000.0 / frameTiming.emaMs;
            const cpu = frameTiming.cpuEmaMs !== null ? ` · CPU ${frameTiming.cpuEmaMs.toFixed(2)} ms` : '';
            elFrame.textContent = `${frameTiming.emaMs.toFixed(2)} ms (${fps.toFixed(0)} fps)${cpu}`;
        } else {
            elFrame.textContent = '—';
        }
    }
    if (elGpu) {
        if (!gpuTimer) elGpu.textContent = 'GPU timer indisponível';
        else if (gpuTimer.emaMs === null) elGpu.textContent = 'medindo…';
        else elGpu.textContent = `${gpuTimer.emaMs.toFixed(3)} ms`;
    }

    if (elSplitBanner && elSplitRight) {
        elSplitBanner.style.display = params.splitCompare ? 'flex' : 'none';
        elSplitRight.innerHTML = `${meta.short} &#9654;`;
    }

    const elViewHint = document.getElementById('hud-view-hint');
    if (elViewHint) {
        if (params.viewMode === '3d') {
            elViewHint.innerHTML = '<span style="color:#38bdf8;">&#9654; Cena 3D Real:</span> Botão esquerdo orbita · Direito move · Scroll aproxima';
        } else {
            elViewHint.innerHTML = '<span style="color:#94a3b8;">&#9654; Inspeção 2D:</span> Projeção em plano de tela cheia';
        }
    }
}

function saveAsImage() {
    render();
    var imgData;
    var strDownloadMime = "image/octet-stream";
    var strMime = "image/jpeg";
    imgData = renderer.domElement.toDataURL(strMime);
    imgData = imgData.replace(strMime, strDownloadMime);
    var link = document.createElement('a');
    if (typeof link.download === 'string') {
        document.body.appendChild(link);
        link.download = 'snapshot.jpg';
        link.href = imgData;
        link.click();
        document.body.removeChild(link); //remove the link when done
    } else {
        location.replace(uri);
    }
}

function onWindowResize() {
    aspectRatio = window.innerWidth / window.innerHeight;
    if (camera3D) {
        camera3D.aspect = aspectRatio;
        camera3D.updateProjectionMatrix();
    }
    renderer.setSize(window.innerWidth, window.innerHeight);
    render();
}

// Callback do requestAnimationFrame: mede o intervalo entre frames (média móvel).
// O intervalo é limitado pelo vsync; o tempo de GPU do passo final vem do timer query.
function onAnimationFrame(timestamp) {
    rafPending = false;
    const now = (typeof timestamp === 'number') ? timestamp : performance.now();
    if (frameTiming.last !== null) {
        const dt = now - frameTiming.last;
        if (dt > 0 && dt < 1000) {
            frameTiming.emaMs = frameTiming.emaMs === null ? dt : frameTiming.emaMs * 0.95 + dt * 0.05;
        }
    }
    frameTiming.last = now;
    render();
}

function render() {
    const cpuStart = performance.now();

    effectMask.uniforms['threshold'].value = params.threshold;
    effectMask.uniforms['tOriginal'].value = textures["mask"];
    effectMask.render(renderer, mips["mask"][0]);

    for (let i = 0; i < 7; i++) {
        effectCopy.uniforms['tOriginal'].value = mips["mask"][i].texture;
        effectCopy.render(renderer, mips["mask"][i + 1]);
    }

    const syncUniforms = (target) => {
        for (let i = 0; i < 8; i++) {
            target['m' + i].value = mips["mask"][i].texture;
        }
        target['mip'].value = params.mip;
        target['t0'].value = textures[params.tex0];
        target['t1'].value = textures[params.tex1];
        target['enable'].value = params.enable ? 1.0 : 0.0;
        target['mode'].value = Number(params.mode);
        target['zoom'].value = params.zoom;
        target['perspectiveTilt'].value = params.perspectiveTilt;
        target['nearLimit'].value = params.nearLimit;
        target['farLimit'].value = params.farLimit;
        target['transBand'].value = TRANS_BAND;
        target['heatmap'].value = params.heatmap ? 1.0 : 0.0;
        target['splitCompare'].value = params.splitCompare ? 1.0 : 0.0;
    };

    if (params.viewMode === '3d' && terrainMaterial && scene3D && camera3D) {
        if (controls) controls.update();
        syncUniforms(terrainMaterial.uniforms);
        terrainMaterial.uniforms['resolution'].value.set(window.innerWidth, window.innerHeight);

        gpuTimerBegin();
        renderer.setRenderTarget(null);
        renderer.render(scene3D, camera3D);
        gpuTimerEnd();
    } else {
        syncUniforms(effectFinalCombine.uniforms);
        effectFinalCombine.uniforms['aspectRatio'].value = aspectRatio;

        gpuTimerBegin();
        effectFinalCombine.render(renderer, null);
        gpuTimerEnd();
    }

    gpuTimerPoll();

    const cpuMs = performance.now() - cpuStart;
    frameTiming.cpuEmaMs = frameTiming.cpuEmaMs === null ? cpuMs : frameTiming.cpuEmaMs * 0.95 + cpuMs * 0.05;

    updateMetricsHUD();
    // Um único laço de animação: render() chamado por resize/save não cria laços extras
    // (isso duplicaria os frames e distorceria a medição de tempo).
    if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(onAnimationFrame);
    }
    stats.update();
}
