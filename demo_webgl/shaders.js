import * as THREE from 'three';

export const TRANS_BAND = 0.12;
export const TRANS_BAND_3D = 0.08;

export const passthroughVS = /* glsl */ `
varying vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

export const MaskShader = {
    uniforms: {
        'tOriginal': { value: null },
        'threshold': { value: 0.5 },
    },
    vertexShader: passthroughVS,
    fragmentShader: /* glsl */ `
        uniform sampler2D tOriginal;
        uniform float threshold;

        varying vec2 vUv;

        void main() {
            vec3 inpColor = texture2D( tOriginal, vUv ).xyz;
            gl_FragColor = vec4(vec3(clamp((inpColor.x - threshold) * 140.0, 0.0, 1.0)), 1.0);
        }`,
};

export const MaskShader3D = {
    uniforms: {
        'tOriginal': { value: null },
        'threshold': { value: 0.55 },
        'gain': { value: 8.0 },
        'offset': { value: new THREE.Vector2(0.0, 0.0) },
        'swapXY': { value: 0.0 },
    },
    vertexShader: passthroughVS,
    fragmentShader: /* glsl */ `
        uniform sampler2D tOriginal;
        uniform float threshold;
        uniform float gain;
        uniform vec2 offset;
        uniform float swapXY;

        varying vec2 vUv;

        void main() {
            vec2 p = swapXY > 0.5 ? vUv.yx : vUv;
            vec3 inpColor = texture2D( tOriginal, fract(p + offset) ).xyz;
            float m = clamp((inpColor.x - threshold) * gain + 0.5, 0.0, 1.0);
            gl_FragColor = vec4(vec3(m), 1.0);
        }`,
};

export const CopyShader = {
    uniforms: {
        'tOriginal': { value: null },
    },
    vertexShader: passthroughVS,
    fragmentShader: /* glsl */ `
        uniform sampler2D tOriginal;

        varying vec2 vUv;

        void main() {
            vec3 inpColor = texture2D( tOriginal, vUv ).xyz;
            gl_FragColor = vec4(inpColor, 1.0);
        }`,
};

export const FinalCombinePassShader = {
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
        'mode': { value: 5 },
        'zoom': { value: 2.5 },
        'mip': { value: 6 },
        'aspectRatio': { value: 1.0 },
        'perspectiveTilt': { value: 0.65 },
        'nearLimit': { value: 0.25 },
        'farLimit': { value: 0.65 },
        'transBand': { value: TRANS_BAND },
        'heatmap': { value: 0.0 },
        'splitCompare': { value: 0.0 },
    },
    vertexShader: passthroughVS,
    fragmentShader: /* glsl */ `
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

        vec4 blendFull(vec2 p, int maxMip) {
            vec4 a0 = texture2D(t0, p, 0.0);
            vec4 a1 = texture2D(t1, p, 0.0);
            vec4 acc = vec4(0.0);
            for (int i = 0; i < LVL_CNT; i++) {
                if (i >= maxMip) break;
                float nb = float(i + 1);
                vec4 b0 = texture2D(t0, p, nb);
                vec4 b1 = texture2D(t1, p, nb);
                vec4 m = maskAt(i + 1, p);
                acc += (a0 - b0) * m + (a1 - b1) * (vec4(1.0) - m);
                a0 = b0;
                a1 = b1;
            }
            vec4 mr = maskAt(maxMip + 1, p);
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

        vec4 blendSkipHybrid(vec2 p) {
            if (mip <= 0) {
                vec4 m0v = maskAt(1, p);
                return texture2D(t0, p, 0.0) * m0v + texture2D(t1, p, 0.0) * (vec4(1.0) - m0v);
            }
            vec4 a0 = texture2D(t0, p, 0.0);
            vec4 a1 = texture2D(t1, p, 0.0);
            vec4 b0 = texture2D(t0, p, 1.0);
            vec4 b1 = texture2D(t1, p, 1.0);
            vec4 m = maskAt(1, p);
            vec4 acc = (a0 - b0) * m + (a1 - b1) * (vec4(1.0) - m);
            a0 = b0;
            a1 = b1;
            int lastLv = 1;
            for (int i = 1; i < LVL_CNT; i += 2) {
                int nxt = i + 2;
                if (nxt >= mip) break;
                float nb = float(nxt);
                b0 = texture2D(t0, p, nb);
                b1 = texture2D(t1, p, nb);
                m = maskAt(i + 1, p);
                acc += (a0 - b0) * m + (a1 - b1) * (vec4(1.0) - m);
                a0 = b0;
                a1 = b1;
                lastLv = nxt;
            }
            vec4 mr = maskAt(lastLv + 1, p);
            return acc + a0 * mr + a1 * (vec4(1.0) - mr);
        }

        void main() {
            vec2 flatUv = vec2(vUv.x * aspectRatio, vUv.y) / vec2(zoom);
            float perspDenom = max(1.0 - vUv.y * perspectiveTilt * 0.68, 0.18);
            float depthFactor = 1.0 / perspDenom;
            vec2 centeredUv = vec2((vUv.x - 0.5) * aspectRatio, vUv.y);
            vec2 uv = vec2(
                (centeredUv.x * depthFactor + 0.5 * aspectRatio) / zoom,
                (centeredUv.y * mix(1.0, depthFactor, 0.85)) / zoom
            );

            float flatGrad = max(length(dFdx(flatUv)) + length(dFdy(flatUv)), 1e-6);
            float perspGrad = length(dFdx(uv)) + length(dFdy(uv));
            float derivRatio = clamp((perspGrad / flatGrad - 1.0) / max(perspectiveTilt * 2.2, 0.001), 0.0, 1.0);
            float distFactor = clamp(
                mix(vUv.y, mix(vUv.y, derivRatio, 0.35), smoothstep(0.0, 0.1, perspectiveTilt)),
                0.0,
                1.0
            );

            int activeMode = mode;
            if (enable < 0.5) activeMode = 0;
            if (splitCompare > 0.5 && vUv.x < 0.5) activeMode = 1;

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
                finalColor = blendFull(uv, mip);
                execFull = 1.0;
            } else if (activeMode == 2) {
                finalColor = blendSkip(uv);
                execSkip = 1.0;
            } else if (activeMode == 3) {
                finalColor = blendSkipHybrid(uv);
                execSkip = 1.0;
            } else if (activeMode == 4) {
                finalColor = blendFull(uv, min(mip, 3));
                execSkip = 1.0;
            } else {
                float wNearToMid = smoothstep(nLim - transBand, nLim + transBand, distFactor);
                float wMidToFar  = smoothstep(fLim - transBand, fLim + transBand, distFactor);

                vec4 cFull = vec4(0.0);
                vec4 cSkip = vec4(0.0);
                vec4 cLin  = vec4(0.0);

                if (wNearToMid < 1.0 && wMidToFar < 1.0) {
                    cFull = blendFull(uv, mip);
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

            if (heatmap > 0.5) {
                vec3 colHigh = vec3(0.95, 0.22, 0.20);
                vec3 colMid  = vec3(0.95, 0.75, 0.15);
                vec3 colLow  = vec3(0.15, 0.82, 0.40);

                float nExec = execFull + execSkip + execLin;
                vec3 firstCol  = execFull > 0.5 ? colHigh : (execSkip > 0.5 ? colMid : colLow);
                vec3 secondCol = (execFull > 0.5 && execSkip > 0.5) ? colMid : colLow;
                vec3 thirdCol  = colLow;
                float stripe = mod(floor((gl_FragCoord.x + gl_FragCoord.y) / 10.0), max(nExec, 1.0));
                vec3 heatColor = stripe < 0.5 ? firstCol : (stripe < 1.5 ? secondCol : thirdCol);

                float luma = dot(finalColor.rgb, vec3(0.299, 0.587, 0.114));
                vec3 shadedHeat = mix(finalColor.rgb, heatColor * (0.52 + 0.68 * luma), 0.68);

                if (activeMode == 5) {
                    float nearLine = 1.0 - smoothstep(0.0, 0.004, abs(distFactor - nLim));
                    float farLine  = 1.0 - smoothstep(0.0, 0.004, abs(distFactor - fLim));
                    shadedHeat = mix(shadedHeat, vec3(1.0), max(nearLine, farLine) * 0.45);
                }
                finalColor.rgb = shadedHeat;
            }

            if (splitCompare > 0.5) {
                float splitLine = 1.0 - smoothstep(0.0008, 0.0022, abs(vUv.x - 0.5));
                finalColor.rgb = mix(finalColor.rgb, vec3(0.22, 0.74, 0.97), splitLine * 0.85);
            }

            gl_FragColor = vec4(finalColor.rgb, 1.0);
        }`,
};

/**
 * WebGL 2.0 (GLSL ES 3.00) 3D Terrain Shader supporting:
 * - 6 blending modes (Linear, NVIDIA N=6, Skip Pure, Skip Hybrid, NVIDIA Trunc N=3, LOD-Adaptive)
 * - Anisotropic Jacobian LOD estimator (dFdx/dFdy eigenvalues) + textureGrad at level 0
 * - Union fetch reuse across smoothstep transition bands
 * - Multi-layer PBR (Albedo 2-layer, PBR 2-layer, PBR 3-layer) with Cook-Torrance GGX lighting
 * - Visualization modes (Normal, TMU Heatmap, LOD Lambda, Anisotropy Ratio) + Telemetry debugPass
 */
export const TerrainShader = {
    glslVersion: THREE.GLSL3,
    uniforms: {
        tAlbedo0: { value: null },
        tAlbedo1: { value: null },
        tAlbedo2: { value: null },
        tNormRough0: { value: null },
        tNormRough1: { value: null },
        tNormRough2: { value: null },
        tMask1: { value: null },
        tMask2: { value: null },

        enable: { value: 1.0 },
        mode: { value: 5 },
        materialMode: { value: 1 },
        mip: { value: 6 },
        zoom: { value: 1.0 },
        uvScale: { value: 40.0 },
        texRes: { value: 1024.0 },
        lodDerivScale: { value: 1.0 },
        anisotropicLod: { value: 1.0 },
        maxAniso: { value: 8.0 },
        maxLod: { value: 4.5 },
        nearLimit: { value: 0.25 },
        farLimit: { value: 0.65 },
        transBand: { value: TRANS_BAND_3D },

        vizMode: { value: 0 },
        splitCompare: { value: 0.0 },
        debugPass: { value: 0 },

        resolution: { value: new THREE.Vector2(1280, 720) },
        fogColor: { value: new THREE.Color(0x9bb4cc) },
        fogDensity: { value: 0.0028 },
        sunDir: { value: new THREE.Vector3(0.45, 0.72, 0.52).normalize() },
    },
    vertexShader: /* glsl */ `
        out vec2 vUv;
        out vec3 vWorldPosition;
        out vec3 vNormal;

        void main() {
            vUv = uv;
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            vNormal = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
    `,
    fragmentShader: /* glsl */ `
        precision highp float;

        uniform sampler2D tAlbedo0;
        uniform sampler2D tAlbedo1;
        uniform sampler2D tAlbedo2;
        uniform sampler2D tNormRough0;
        uniform sampler2D tNormRough1;
        uniform sampler2D tNormRough2;
        uniform sampler2D tMask1;
        uniform sampler2D tMask2;

        uniform float enable;
        uniform int mode;
        uniform int materialMode;
        uniform int mip;
        uniform float zoom;
        uniform float uvScale;
        uniform float texRes;
        uniform float lodDerivScale;
        uniform float anisotropicLod;
        uniform float maxAniso;
        uniform float maxLod;
        uniform float nearLimit;
        uniform float farLimit;
        uniform float transBand;

        uniform int vizMode;
        uniform float splitCompare;
        uniform int debugPass;

        uniform vec2 resolution;
        uniform vec3 fogColor;
        uniform float fogDensity;
        uniform vec3 sunDir;

        in vec2 vUv;
        in vec3 vWorldPosition;
        in vec3 vNormal;

        layout(location = 0) out vec4 fragColor;

        #define MAX_MIPS 6
        #define PI 3.14159265359

        struct LayerSample {
            vec3 alb0;
            vec3 alb1;
            vec3 alb2;
            vec4 nr0;
            vec4 nr1;
            vec4 nr2;
            float m1;
            float m2;
        };

        vec4 sampleAtLevel(sampler2D tex, vec2 uv, vec2 dPdx, vec2 dPdy, float k, float lambdaEff) {
            if (k < 0.5 && anisotropicLod > 0.5) {
                return textureGrad(tex, uv, dPdx, dPdy);
            }
            return textureLod(tex, uv, max(lambdaEff, k));
        }

        LayerSample fetchMaterialLevel(
            vec2 uv,
            vec2 dPdx,
            vec2 dPdy,
            float k,
            float lambdaEff,
            float altWeight,
            inout int fetchCounter
        ) {
            LayerSample s;
            s.alb0 = sampleAtLevel(tAlbedo0, uv, dPdx, dPdy, k, lambdaEff).rgb;
            s.alb1 = sampleAtLevel(tAlbedo1, uv, dPdx, dPdy, k, lambdaEff).rgb;
            // Convention consistent with Python benchmark: mask=0 -> Layer0, mask=1 -> Layer1
            s.m1 = sampleAtLevel(tMask1, uv, dPdx, dPdy, k, lambdaEff).r;
            fetchCounter += 3;

            if (materialMode >= 1) {
                s.nr0 = sampleAtLevel(tNormRough0, uv, dPdx, dPdy, k, lambdaEff);
                s.nr1 = sampleAtLevel(tNormRough1, uv, dPdx, dPdy, k, lambdaEff);
                fetchCounter += 2;
            } else {
                s.nr0 = vec4(0.5, 0.5, 1.0, 0.8);
                s.nr1 = vec4(0.5, 0.5, 1.0, 0.8);
            }

            if (materialMode >= 2) {
                s.alb2 = sampleAtLevel(tAlbedo2, uv, dPdx, dPdy, k, lambdaEff).rgb;
                s.nr2 = sampleAtLevel(tNormRough2, uv, dPdx, dPdy, k, lambdaEff);
                s.m2 = sampleAtLevel(tMask2, uv, dPdx, dPdy, k, lambdaEff).r * altWeight;
                fetchCounter += 3;
            } else {
                s.alb2 = vec3(0.0);
                s.nr2 = vec4(0.5, 0.5, 1.0, 0.8);
                s.m2 = 0.0;
            }
            return s;
        }

        void accumulateBand(
            LayerSample lo,
            LayerSample hi,
            inout vec3 accAlb,
            inout vec4 accNr
        ) {
            vec3 dAlb0 = lo.alb0 - hi.alb0;
            vec3 dAlb1 = lo.alb1 - hi.alb1;
            vec3 baseBandAlb = mix(dAlb0, dAlb1, lo.m1);
            if (materialMode >= 2) {
                vec3 dAlb2 = lo.alb2 - hi.alb2;
                accAlb += mix(baseBandAlb, dAlb2, lo.m2);
            } else {
                accAlb += baseBandAlb;
            }

            if (materialMode >= 1) {
                vec4 dNr0 = lo.nr0 - hi.nr0;
                vec4 dNr1 = lo.nr1 - hi.nr1;
                vec4 baseBandNr = mix(dNr0, dNr1, lo.m1);
                if (materialMode >= 2) {
                    vec4 dNr2 = lo.nr2 - hi.nr2;
                    accNr += mix(baseBandNr, dNr2, lo.m2);
                } else {
                    accNr += baseBandNr;
                }
            }
        }

        void accumulateResidual(
            LayerSample res,
            inout vec3 accAlb,
            inout vec4 accNr
        ) {
            vec3 baseResAlb = mix(res.alb0, res.alb1, res.m1);
            if (materialMode >= 2) {
                accAlb += mix(baseResAlb, res.alb2, res.m2);
            } else {
                accAlb += baseResAlb;
            }

            if (materialMode >= 1) {
                vec4 baseResNr = mix(res.nr0, res.nr1, res.m1);
                if (materialMode >= 2) {
                    accNr += mix(baseResNr, res.nr2, res.m2);
                } else {
                    accNr += baseResNr;
                }
            }
        }

        void evaluateBlend(
            int activeMode,
            vec2 uv,
            vec2 dPdx,
            vec2 dPdy,
            float lambdaEff,
            float distFactor,
            float nLim,
            float fLim,
            float altWeight,
            out vec3 outAlb,
            out vec4 outNr,
            out int outFetches,
            out int outRegimeId,
            out float outExecFull,
            out float outExecSkip,
            out float outExecLin
        ) {
            outFetches = 0;
            outExecFull = 0.0;
            outExecSkip = 0.0;
            outExecLin = 0.0;
            int maxM = clamp(mip, 0, MAX_MIPS);

            if (activeMode == 0) {
                // Linear baseline
                LayerSample s0 = fetchMaterialLevel(uv, dPdx, dPdy, 0.0, lambdaEff, altWeight, outFetches);
                outAlb = vec3(0.0);
                outNr = vec4(0.0);
                accumulateResidual(s0, outAlb, outNr);
                outRegimeId = 3;
                outExecLin = 1.0;
                return;
            }

            if (activeMode == 1 || activeMode == 4) {
                // Full N=6 (mode 1) or Truncated N=3 (mode 4)
                int limitM = (activeMode == 4) ? min(maxM, 3) : maxM;
                LayerSample prev = fetchMaterialLevel(uv, dPdx, dPdy, 0.0, lambdaEff, altWeight, outFetches);
                outAlb = vec3(0.0);
                outNr = vec4(0.0);
                for (int k = 1; k <= MAX_MIPS; k++) {
                    if (k > limitM) break;
                    LayerSample curr = fetchMaterialLevel(uv, dPdx, dPdy, float(k), lambdaEff, altWeight, outFetches);
                    accumulateBand(prev, curr, outAlb, outNr);
                    prev = curr;
                }
                accumulateResidual(prev, outAlb, outNr);
                outRegimeId = (activeMode == 4) ? 5 : 1;
                if (activeMode == 1) outExecFull = 1.0;
                else outExecSkip = 1.0;
                return;
            }

            if (activeMode == 2) {
                // Skip Puro {0, 2, 4, 6}
                LayerSample prev = fetchMaterialLevel(uv, dPdx, dPdy, 0.0, lambdaEff, altWeight, outFetches);
                outAlb = vec3(0.0);
                outNr = vec4(0.0);
                for (int k = 2; k <= MAX_MIPS; k += 2) {
                    if (k > maxM) break;
                    LayerSample curr = fetchMaterialLevel(uv, dPdx, dPdy, float(k), lambdaEff, altWeight, outFetches);
                    accumulateBand(prev, curr, outAlb, outNr);
                    prev = curr;
                }
                if ((maxM % 2) != 0) {
                    LayerSample curr = fetchMaterialLevel(uv, dPdx, dPdy, float(maxM), lambdaEff, altWeight, outFetches);
                    accumulateBand(prev, curr, outAlb, outNr);
                    prev = curr;
                }
                accumulateResidual(prev, outAlb, outNr);
                outRegimeId = 2;
                outExecSkip = 1.0;
                return;
            }

            if (activeMode == 3) {
                // Skip Hibrido {0, 1, 3, 5}
                LayerSample prev = fetchMaterialLevel(uv, dPdx, dPdy, 0.0, lambdaEff, altWeight, outFetches);
                outAlb = vec3(0.0);
                outNr = vec4(0.0);
                if (maxM >= 1) {
                    LayerSample curr1 = fetchMaterialLevel(uv, dPdx, dPdy, 1.0, lambdaEff, altWeight, outFetches);
                    accumulateBand(prev, curr1, outAlb, outNr);
                    prev = curr1;
                    for (int k = 3; k < MAX_MIPS; k += 2) {
                        if (k >= maxM) break;
                        LayerSample curr = fetchMaterialLevel(uv, dPdx, dPdy, float(k), lambdaEff, altWeight, outFetches);
                        accumulateBand(prev, curr, outAlb, outNr);
                        prev = curr;
                    }
                }
                accumulateResidual(prev, outAlb, outNr);
                outRegimeId = 5;
                outExecSkip = 1.0;
                return;
            }

            // Mode 5: LOD-Adaptive with Union Fetch Reuse across smoothstep bands
            float wNM = smoothstep(nLim - transBand, nLim + transBand, distFactor);
            float wMF = smoothstep(fLim - transBand, fLim + transBand, distFactor);

            float wFull = (1.0 - wNM) * (1.0 - wMF);
            float wSkip = wNM * (1.0 - wMF);
            float wLin = wMF;

            bool needFull = (wFull > 0.0);
            bool needSkip = (wSkip > 0.0);
            bool needLin = (wLin > 0.0);

            outExecFull = needFull ? 1.0 : 0.0;
            outExecSkip = needSkip ? 1.0 : 0.0;
            outExecLin = needLin ? 1.0 : 0.0;

            int activeCount = (needFull ? 1 : 0) + (needSkip ? 1 : 0) + (needLin ? 1 : 0);
            if (activeCount > 1) outRegimeId = 4;
            else if (needFull) outRegimeId = 1;
            else if (needSkip) outRegimeId = 2;
            else outRegimeId = 3;

            vec3 albFull = vec3(0.0);
            vec4 nrFull = vec4(0.0);
            vec3 albSkip = vec3(0.0);
            vec4 nrSkip = vec4(0.0);
            vec3 albLin = vec3(0.0);
            vec4 nrLin = vec4(0.0);

            if (needFull) {
                LayerSample s0 = fetchMaterialLevel(uv, dPdx, dPdy, 0.0, lambdaEff, altWeight, outFetches);
                if (needLin) {
                    accumulateResidual(s0, albLin, nrLin);
                }

                LayerSample prevFull = s0;
                LayerSample prevSkip = s0;
                for (int k = 1; k <= MAX_MIPS; k++) {
                    if (k > maxM) break;
                    LayerSample curr = fetchMaterialLevel(uv, dPdx, dPdy, float(k), lambdaEff, altWeight, outFetches);
                    accumulateBand(prevFull, curr, albFull, nrFull);
                    prevFull = curr;

                    if (needSkip && (((k % 2) == 0) || (k == maxM))) {
                        accumulateBand(prevSkip, curr, albSkip, nrSkip);
                        prevSkip = curr;
                    }
                }
                accumulateResidual(prevFull, albFull, nrFull);
                if (needSkip) {
                    accumulateResidual(prevSkip, albSkip, nrSkip);
                }
            } else if (needSkip) {
                LayerSample s0 = fetchMaterialLevel(uv, dPdx, dPdy, 0.0, lambdaEff, altWeight, outFetches);
                if (needLin) {
                    accumulateResidual(s0, albLin, nrLin);
                }

                LayerSample prevSkip = s0;
                for (int k = 2; k <= MAX_MIPS; k += 2) {
                    if (k > maxM) break;
                    LayerSample curr = fetchMaterialLevel(uv, dPdx, dPdy, float(k), lambdaEff, altWeight, outFetches);
                    accumulateBand(prevSkip, curr, albSkip, nrSkip);
                    prevSkip = curr;
                }
                if ((maxM % 2) != 0) {
                    LayerSample curr = fetchMaterialLevel(uv, dPdx, dPdy, float(maxM), lambdaEff, altWeight, outFetches);
                    accumulateBand(prevSkip, curr, albSkip, nrSkip);
                    prevSkip = curr;
                }
                accumulateResidual(prevSkip, albSkip, nrSkip);
            } else {
                LayerSample s0 = fetchMaterialLevel(uv, dPdx, dPdy, 0.0, lambdaEff, altWeight, outFetches);
                accumulateResidual(s0, albLin, nrLin);
            }

            outAlb = albFull * wFull + albSkip * wSkip + albLin * wLin;
            outNr = nrFull * wFull + nrSkip * wSkip + nrLin * wLin;
        }

        // GGX / Cook-Torrance PBR helper functions
        float distributionGGX(vec3 N, vec3 H, float roughness) {
            float a = roughness * roughness;
            float a2 = a * a;
            float NdotH = max(dot(N, H), 0.0);
            float denom = (NdotH * NdotH * (a2 - 1.0) + 1.0);
            return a2 / max(PI * denom * denom, 1e-5);
        }

        float geometrySchlickGGX(float NdotV, float roughness) {
            float r = roughness + 1.0;
            float k = (r * r) / 8.0;
            return NdotV / max(NdotV * (1.0 - k) + k, 1e-5);
        }

        float geometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
            return geometrySchlickGGX(max(dot(N, V), 0.0), roughness) *
                   geometrySchlickGGX(max(dot(N, L), 0.0), roughness);
        }

        vec3 fresnelSchlick(float cosTheta, vec3 F0) {
            return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
        }

        vec3 turboColormap(float t) {
            t = clamp(t, 0.0, 1.0);
            vec3 c0 = vec3(0.18, 0.25, 0.85);
            vec3 c1 = vec3(0.10, 0.78, 0.72);
            vec3 c2 = vec3(0.95, 0.82, 0.16);
            vec3 c3 = vec3(0.90, 0.18, 0.12);
            if (t < 0.33) return mix(c0, c1, t / 0.33);
            if (t < 0.66) return mix(c1, c2, (t - 0.33) / 0.33);
            return mix(c2, c3, (t - 0.66) / 0.34);
        }

        void main() {
            // World-scale texture coordinates (must be computed in uniform control flow before branching)
            vec2 uv = (vUv * uvScale) / max(zoom, 0.05);
            vec2 dPdx = dFdx(uv);
            vec2 dPdy = dFdy(uv);

            // Real Anisotropic Jacobian LOD Estimator (eigenvalues of J^T * J in texel space)
            vec2 jx = dPdx * texRes * lodDerivScale;
            vec2 jy = dPdy * texRes * lodDerivScale;
            float A = dot(jx, jx);
            float B = dot(jy, jy);
            float C = dot(jx, jy);
            float tr = A + B;
            float disc = sqrt(max((A - B) * (A - B) + 4.0 * C * C, 0.0));
            float rhoMax = sqrt(max(0.5 * (tr + disc), 1e-12));
            float rhoMin = sqrt(max(0.5 * (tr - disc), 1e-12));
            float anisoRatio = clamp(rhoMax / max(rhoMin, 1e-6), 1.0, maxAniso);

            float lambdaIso = max(0.0, log2(max(rhoMax, 1e-6)));
            float lambdaAniso = max(0.0, log2(max(max(rhoMin, rhoMax / maxAniso), 1e-6)));
            float lambdaEff = mix(lambdaIso, lambdaAniso, anisotropicLod);
            float distFactor = clamp(lambdaEff / max(maxLod, 0.5), 0.0, 1.0);

            float screenX = gl_FragCoord.x / max(resolution.x, 1.0);

            int activeMode = mode;
            if (enable < 0.5) activeMode = 0;
            if (splitCompare > 0.5 && screenX < 0.5) activeMode = 1;

            float nLim = min(nearLimit, farLimit - 0.05);
            float fLim = max(farLimit, nearLimit + 0.05);
            float altWeight = clamp((vWorldPosition.y - 1.0) / 5.0, 0.0, 1.0);

            vec3 alb;
            vec4 nr;
            int fetchesExec = 0;
            int regimeId = 0;
            float execFull = 0.0;
            float execSkip = 0.0;
            float execLin = 0.0;

            evaluateBlend(
                activeMode,
                uv,
                dPdx,
                dPdy,
                lambdaEff,
                distFactor,
                nLim,
                fLim,
                altWeight,
                alb,
                nr,
                fetchesExec,
                regimeId,
                execFull,
                execSkip,
                execLin
            );

            if (debugPass == 1) {
                fragColor = vec4(
                    float(clamp(fetchesExec, 0, 255)) / 255.0,
                    float(regimeId) / 255.0,
                    clamp(lambdaEff / 8.0, 0.0, 1.0),
                    1.0
                );
                return;
            }

            alb = clamp(alb, 0.0, 1.0);
            vec3 Ngeom = normalize(vNormal);
            vec3 L = normalize(sunDir);
            vec3 V = normalize(cameraPosition - vWorldPosition);
            vec3 shadedColor;

            if (materialMode == 0) {
                float diff = max(dot(Ngeom, L), 0.0);
                float hemi = 0.5 + 0.5 * Ngeom.y;
                vec3 ambient = mix(vec3(0.14, 0.13, 0.11), vec3(0.26, 0.31, 0.38), hemi);
                shadedColor = alb * (ambient + vec3(1.05, 0.99, 0.90) * diff * 0.85);
            } else {
                vec3 tangentN = nr.rgb * 2.0 - 1.0;
                tangentN = normalize(vec3(tangentN.xy, max(tangentN.z, 0.08)));

                vec3 upRef = abs(Ngeom.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
                vec3 T = normalize(cross(upRef, Ngeom));
                vec3 B = cross(Ngeom, T);
                vec3 Nw = normalize(T * tangentN.x + B * tangentN.y + Ngeom * tangentN.z);

                float roughness = clamp(nr.a, 0.08, 1.0);
                vec3 H = normalize(V + L);
                vec3 F0 = vec3(0.04);
                float NDF = distributionGGX(Nw, H, roughness);
                float G = geometrySmith(Nw, V, L, roughness);
                vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);

                vec3 spec = (NDF * G * F) / max(4.0 * max(dot(Nw, V), 0.0) * max(dot(Nw, L), 0.0), 1e-4);
                vec3 kD = vec3(1.0) - F;
                float NdotL = max(dot(Nw, L), 0.0);

                float hemi = 0.5 + 0.5 * Nw.y;
                vec3 ambient = mix(vec3(0.13, 0.12, 0.11), vec3(0.25, 0.30, 0.37), hemi);
                vec3 radiance = vec3(1.45, 1.38, 1.24);
                shadedColor = alb * ambient + (kD * alb + spec) * radiance * NdotL;
            }

            if (vizMode == 1) {
                vec3 colHigh = vec3(0.95, 0.22, 0.20);
                vec3 colMid = vec3(0.95, 0.75, 0.15);
                vec3 colLow = vec3(0.15, 0.82, 0.40);

                float nExec = execFull + execSkip + execLin;
                vec3 firstCol = execFull > 0.5 ? colHigh : (execSkip > 0.5 ? colMid : colLow);
                vec3 secondCol = (execFull > 0.5 && execSkip > 0.5) ? colMid : colLow;
                vec3 thirdCol = colLow;
                float stripe = mod(floor((gl_FragCoord.x + gl_FragCoord.y) / 10.0), max(nExec, 1.0));
                vec3 heatColor = stripe < 0.5 ? firstCol : (stripe < 1.5 ? secondCol : thirdCol);

                float luma = dot(shadedColor, vec3(0.299, 0.587, 0.114));
                shadedColor = mix(shadedColor, heatColor * (0.52 + 0.68 * luma), 0.72);

                if (activeMode == 5) {
                    float nearLine = 1.0 - smoothstep(0.0, 0.008, abs(distFactor - nLim));
                    float farLine = 1.0 - smoothstep(0.0, 0.008, abs(distFactor - fLim));
                    shadedColor = mix(shadedColor, vec3(1.0), max(nearLine, farLine) * 0.65);
                }
            } else if (vizMode == 2) {
                vec3 lodCol = turboColormap(lambdaEff / max(maxLod, 0.5));
                shadedColor = mix(shadedColor, lodCol, 0.78);
            } else if (vizMode == 3) {
                float anisoNorm = clamp((anisoRatio - 1.0) / max(maxAniso - 1.0, 1.0), 0.0, 1.0);
                vec3 anisoCol = turboColormap(anisoNorm);
                shadedColor = mix(shadedColor, anisoCol, 0.78);
            } else {
                // Smooth atmospheric distance fog only in normal visualization mode
                float dist = length(cameraPosition - vWorldPosition);
                float fogFactor = 1.0 - exp(-pow(dist * fogDensity, 1.6));
                shadedColor = mix(shadedColor, fogColor, clamp(fogFactor, 0.0, 1.0));
            }

            if (splitCompare > 0.5) {
                float splitLine = 1.0 - smoothstep(0.0008, 0.0022, abs(screenX - 0.5));
                shadedColor = mix(shadedColor, vec3(0.22, 0.74, 0.97), splitLine * 0.85);
            }

            fragColor = vec4(clamp(shadedColor, 0.0, 1.0), 1.0);
        }
    `,
};
