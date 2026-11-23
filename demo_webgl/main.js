import * as THREE from 'three';

import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';

import {
    TERRAIN_SIZE,
    TEX_RES,
    TILE_SIZE,
    createTerrainGeometry,
    createSkyDome,
    createPackedNormalRoughness,
    createLayer3Albedo,
    createAvatar,
    AvatarController,
} from './terrain.js';
import { CAMERA_PRESETS, applyCameraPreset, updateThirdPersonCamera } from './camera_presets.js';
import {
    TRANS_BAND,
    TRANS_BAND_3D,
    MaskShader,
    MaskShader3D,
    CopyShader,
    FinalCombinePassShader,
    TerrainShader,
} from './shaders.js';
import { BenchmarkRunner, getHardwareMetadata, measureTelemetry3D } from './benchmark.js';

const params = {
    viewMode: '3d',
    cameraMode: 'orbit',
    preset: 'overview',
    showAvatar: false,

    mode: 5,
    anisotropicLod: true,
    maxAniso: 8,
    nearLimit: 0.25,
    farLimit: 0.65,
    maxLod: 4.5,
    mip: 6,
    threshold: 0.55,
    maskGain: 8.0,

    materialMode: 'pbr2',
    tex0: 0,
    tex1: 1,
    zoom: 1.0,
    perspectiveTilt: 0.65,
    enable: true,

    vizMode: 0,
    splitCompare: false,

    runQuickBench: () => triggerBenchmark(false),
    runFullBench: () => triggerBenchmark(true),
    downloadJSON: () => downloadText(benchRunner.exportJSON(), 'benchmark_gpu_webgl3d.json', 'application/json'),
    downloadCSV: () => downloadText(benchRunner.exportCSV(), 'benchmark_gpu_webgl3d.csv', 'text/csv'),
    save: saveAsImage,
};

let renderer, effectCopy, effectFinalCombine, effectMask, effectMask3D;
let mips, maskRT1, maskRT2, telemetryRT;
let textures = {};
let packedTextures = {};
let aspectRatio = 1.0;

let scene3D, camera3D, controls, terrainMesh, terrainMaterial, skyMesh, avatarMesh, avatarController;
let benchRunner = null;
let gpuTimer = null;
let rafPending = false;
let lastFrameClock = performance.now();
let masksDirty = true;
let lastMaskParamsKey = '';

let avatarCamYaw = 0.0;
let avatarCamPitch = 0.28;
let avatarCamDist = 9.0;
let isDraggingAvatarCam = false;
let prevDragX = 0;
let prevDragY = 0;

let lastTelemetry3D = null;
let lastTelemetryStateKey = '';
let telemetryLastChangeTime = 0;
let telemetryPending = true;
let forceTelemetryImmediate = true;
const COST_GRID = 64;
let costCache = { key: null, value: null };

const stats = new Stats();
document.body.appendChild(stats.dom);

init();

function init() {
    aspectRatio = window.innerWidth / window.innerHeight;
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    if ('outputEncoding' in renderer) {
        renderer.outputEncoding = THREE.LinearEncoding;
    }

    gpuTimer = initGpuTimer();

    const hwMaxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    params.maxAniso = Math.min(8, hwMaxAniso);

    mips = {};
    let loaded = 0;

    const onTextureLoaded = (tex, name) => {
        tex.wrapS = THREE.MirroredRepeatWrapping;
        tex.wrapT = THREE.MirroredRepeatWrapping;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        tex.anisotropy = params.maxAniso;
        tex.needsUpdate = true;

        if (name === 'mask') {
            let w = tex.image.width;
            let h = tex.image.height;
            const sharedProps = {
                minFilter: THREE.LinearFilter,
                magFilter: THREE.LinearFilter,
                wrapS: THREE.MirroredRepeatWrapping,
                wrapT: THREE.MirroredRepeatWrapping,
                format: THREE.RGBAFormat,
                type: THREE.UnsignedByteType,
            };
            const mipsL = [];
            while (w > 1 && h > 1) {
                mipsL.push(new THREE.WebGLRenderTarget(w, h, sharedProps));
                w = w / 2;
                h = h / 2;
            }
            mips[name] = mipsL;
        }

        textures[name] = tex;
        loaded += 1;
        if (loaded === 7) {
            onAllAssetsReady();
        }
    };

    const loader = new THREE.TextureLoader();
    loader.load('1.jpg', (t) => onTextureLoaded(t, '0'));
    loader.load('2.jpg', (t) => onTextureLoaded(t, '1'));
    loader.load('1rot.jpg', (t) => onTextureLoaded(t, '2'));
    loader.load('2rot.jpg', (t) => onTextureLoaded(t, '3'));
    loader.load('normal0.jpg', (t) => onTextureLoaded(t, '4'));
    loader.load('normal1.jpg', (t) => onTextureLoaded(t, '5'));
    loader.load('perlin.jpg', (t) => onTextureLoaded(t, 'mask'));

    effectCopy = new ShaderPass(CopyShader);
    effectFinalCombine = new ShaderPass(FinalCombinePassShader);
    effectFinalCombine.material.extensions.derivatives = true;
    effectMask = new ShaderPass(MaskShader, null);
    effectMask3D = new ShaderPass(MaskShader3D, null);

    const rtMaskProps = {
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.MirroredRepeatWrapping,
        wrapT: THREE.MirroredRepeatWrapping,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        generateMipmaps: true,
        depthBuffer: false,
    };
    maskRT1 = new THREE.WebGLRenderTarget(1024, 1024, rtMaskProps);
    maskRT2 = new THREE.WebGLRenderTarget(1024, 1024, rtMaskProps);

    telemetryRT = new THREE.WebGLRenderTarget(160, 90, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: true,
    });

    // 3D Scene
    scene3D = new THREE.Scene();
    scene3D.background = new THREE.Color(0x9bb4cc);

    const sunDir = new THREE.Vector3(0.45, 0.72, 0.52).normalize();
    skyMesh = createSkyDome(sunDir);
    scene3D.add(skyMesh);

    const ambientLight = new THREE.HemisphereLight(0xcbe2ff, 0x3b352c, 0.75);
    scene3D.add(ambientLight);
    const sunLight = new THREE.DirectionalLight(0xfff4e0, 1.35);
    sunLight.position.copy(sunDir).multiplyScalar(150);
    scene3D.add(sunLight);

    camera3D = new THREE.PerspectiveCamera(50, aspectRatio, 0.2, 1200);
    controls = new OrbitControls(camera3D, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.maxPolarAngle = Math.PI / 2 - 0.03;
    controls.minDistance = 2.0;
    controls.maxDistance = 220.0;
    applyCameraPreset(camera3D, controls, params.preset);

    const terrainGeo = createTerrainGeometry();
    terrainMaterial = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: THREE.UniformsUtils.clone(TerrainShader.uniforms),
        vertexShader: TerrainShader.vertexShader,
        fragmentShader: TerrainShader.fragmentShader,
    });
    terrainMaterial.uniforms.uvScale.value = TERRAIN_SIZE / TILE_SIZE;
    terrainMaterial.uniforms.texRes.value = TEX_RES;
    terrainMaterial.uniforms.sunDir.value.copy(sunDir);

    terrainMesh = new THREE.Mesh(terrainGeo, terrainMaterial);
    scene3D.add(terrainMesh);

    avatarMesh = createAvatar();
    avatarMesh.visible = false;
    scene3D.add(avatarMesh);
    avatarController = new AvatarController(avatarMesh, 12.0, 14.0);

    setupAvatarCameraInput();
    setupGUI(hwMaxAniso);
    setupBenchmarkModalUI();
    updateHUDState();

    benchRunner = new BenchmarkRunner({
        renderer,
        scene3D,
        camera3D,
        controls,
        terrainMaterial,
        skyMesh,
        avatarMesh,
        params,
        ensureMasksUpdated,
        syncUniforms3D,
    });

    window.__BENCHMARK_API__ = {
        runQuick: () => benchRunner.runSuite({ full: false }),
        runFull: () => benchRunner.runSuite({ full: true }),
        captureComparisonFrames: (preset, materialMode, width, height) =>
            benchRunner.captureComparisonFrames(preset, materialMode, width, height),
        getLastResults: () => benchRunner.lastReport,
        getTelemetry: () => lastTelemetry3D,
        setState: (patch) => {
            Object.assign(params, patch);
            if (patch.preset) applyCameraPreset(camera3D, controls, patch.preset);
            if (patch.maxAniso !== undefined) applyAnisotropyToTextures(params.maxAniso);
            if (patch.cameraMode !== undefined) onCameraModeChanged(params.cameraMode);
            if (gpuTimer) gpuTimer.emaMs = null;
            masksDirty = true;
            telemetryPending = true;
            forceTelemetryImmediate = true;
            syncUniforms3D();
            updateMetricsHUD();
        },
    };

    const elGpuInfo = document.getElementById('hud-gpu-info');
    if (elGpuInfo) {
        const hw = getHardwareMetadata(renderer);
        const gpuRaw = hw.unmaskedRenderer || hw.renderer || 'WebGL 2.0 GPU';
        const gpuShort = gpuRaw.replace(/^ANGLE\s*\([^,]+,\s*/i, '').replace(/\)\s*$/, '');
        elGpuInfo.textContent = gpuShort;
        elGpuInfo.title = `${gpuRaw} | Timer Query: ${hw.hasGpuTimerQuery ? 'Ativo' : 'Indisponivel'}`;
    }
}

function onAllAssetsReady() {
    packedTextures.nr0 = createPackedNormalRoughness(
        textures['4'].image,
        textures['0'].image,
        0.42,
        0.88,
        false,
        params.maxAniso
    );
    packedTextures.nr1 = createPackedNormalRoughness(
        textures['5'].image,
        textures['1'].image,
        0.55,
        0.95,
        false,
        params.maxAniso
    );
    packedTextures.nr2 = createPackedNormalRoughness(
        textures['4'].image,
        textures['2'].image,
        0.28,
        0.72,
        true,
        params.maxAniso
    );
    packedTextures.alb2 = createLayer3Albedo(textures['2'].image, params.maxAniso);

    applyAnisotropyToTextures(params.maxAniso);
    ensureMasksUpdated(true);
    render();
}

function applyAnisotropyToTextures(aniso) {
    const val = Math.max(1, Math.min(renderer.capabilities.getMaxAnisotropy(), aniso));
    for (const k of Object.keys(textures)) {
        if (textures[k]) {
            textures[k].anisotropy = val;
            textures[k].needsUpdate = true;
        }
    }
    for (const k of Object.keys(packedTextures)) {
        if (packedTextures[k]) {
            packedTextures[k].anisotropy = val;
            packedTextures[k].needsUpdate = true;
        }
    }
    if (maskRT1) maskRT1.texture.anisotropy = val;
    if (maskRT2) maskRT2.texture.anisotropy = val;
}

function ensureMasksUpdated(force = false) {
    if (!textures.mask) return;
    const key = `${params.threshold.toFixed(4)}|${params.maskGain.toFixed(2)}`;
    if (!force && !masksDirty && key === lastMaskParamsKey) return;

    const gl = renderer.getContext();
    const generateRtMips = (rt) => {
        const props = renderer.properties.get(rt.texture);
        if (props && props.__webglTexture) {
            gl.bindTexture(gl.TEXTURE_2D, props.__webglTexture);
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.bindTexture(gl.TEXTURE_2D, null);
        }
    };

    effectMask3D.uniforms.tOriginal.value = textures.mask;
    effectMask3D.uniforms.threshold.value = params.threshold;
    effectMask3D.uniforms.gain.value = params.maskGain;
    effectMask3D.uniforms.offset.value.set(0.0, 0.0);
    effectMask3D.uniforms.swapXY.value = 0.0;
    effectMask3D.render(renderer, maskRT1);

    effectMask3D.uniforms.threshold.value = Math.min(0.85, params.threshold + 0.03);
    effectMask3D.uniforms.gain.value = Math.max(2.0, params.maskGain * 0.75);
    effectMask3D.uniforms.offset.value.set(0.37, 0.61);
    effectMask3D.uniforms.swapXY.value = 1.0;
    effectMask3D.render(renderer, maskRT2);

    renderer.setRenderTarget(null);
    generateRtMips(maskRT1);
    generateRtMips(maskRT2);

    masksDirty = false;
    lastMaskParamsKey = key;
}

function setupAvatarCameraInput() {
    const dom = renderer.domElement;
    dom.addEventListener('pointerdown', (e) => {
        if (params.viewMode === '3d' && params.cameraMode === 'avatar') {
            isDraggingAvatarCam = true;
            prevDragX = e.clientX;
            prevDragY = e.clientY;
        }
    });
    window.addEventListener('pointermove', (e) => {
        if (!isDraggingAvatarCam) return;
        const dx = e.clientX - prevDragX;
        const dy = e.clientY - prevDragY;
        prevDragX = e.clientX;
        prevDragY = e.clientY;
        avatarCamYaw -= dx * 0.006;
        avatarCamPitch = Math.max(0.06, Math.min(1.15, avatarCamPitch + dy * 0.005));
    });
    window.addEventListener('pointerup', () => {
        isDraggingAvatarCam = false;
    });
    dom.addEventListener(
        'wheel',
        (e) => {
            if (params.viewMode === '3d' && params.cameraMode === 'avatar') {
                avatarCamDist = Math.max(3.5, Math.min(36.0, avatarCamDist + e.deltaY * 0.01));
            }
        },
        { passive: true }
    );
}

function onCameraModeChanged(modeVal) {
    if (controls) controls.enabled = params.viewMode === '3d' && modeVal === 'orbit';
    if (modeVal === 'preset') {
        applyCameraPreset(camera3D, controls, params.preset);
    } else if (modeVal === 'avatar') {
        params.showAvatar = true;
    }
    if (avatarMesh) {
        avatarMesh.visible = params.viewMode === '3d' && (params.cameraMode === 'avatar' || params.showAvatar);
    }
    updateHUDState();
}

function setupGUI(hwMaxAniso) {
    const gui = new GUI({ width: 340 });

    const triggerDiscreteRefresh = () => {
        if (gpuTimer) gpuTimer.emaMs = null;
        telemetryPending = true;
        forceTelemetryImmediate = true;
    };

    const fScene = gui.addFolder('Cena & Camera');
    fScene
        .add(params, 'viewMode', {
            '3D: Terreno em Perspectiva': '3d',
            '2D: Inspecao Plana (Legado)': '2d',
        })
        .name('viewMode')
        .onChange(() => {
            if (controls) controls.enabled = params.viewMode === '3d' && params.cameraMode === 'orbit';
            if (avatarMesh) avatarMesh.visible = params.viewMode === '3d' && (params.cameraMode === 'avatar' || params.showAvatar);
            triggerDiscreteRefresh();
            updateHUDState();
            updateMetricsHUD();
        });

    fScene
        .add(params, 'cameraMode', {
            'Orbit Livre': 'orbit',
            'Avatar 3a Pessoa (WASD)': 'avatar',
            'Preset Fixo (Reprodutivel)': 'preset',
        })
        .name('cameraMode')
        .onChange((val) => {
            onCameraModeChanged(val);
            triggerDiscreteRefresh();
        });

    fScene
        .add(params, 'preset', {
            'Panoramica (3 Zonas)': 'overview',
            'Angulo Rasante (Anisotropia)': 'grazing',
            'Close-Up (Detalhes PBR)': 'closeup',
            'Vista Aerea (Macro)': 'aerial',
        })
        .name('preset')
        .onChange((val) => {
            if (params.cameraMode !== 'avatar') {
                applyCameraPreset(camera3D, controls, val);
            }
            triggerDiscreteRefresh();
        });

    fScene
        .add(params, 'showAvatar')
        .name('Exibir Avatar')
        .listen()
        .onChange((v) => {
            if (avatarMesh) avatarMesh.visible = params.viewMode === '3d' && (v || params.cameraMode === 'avatar');
        });

    const fAlgo = gui.addFolder('Algoritmo & LOD');
    fAlgo
        .add(params, 'mode', {
            '0: Baseline - Linear Blend': 0,
            '1: NVIDIA Original N=6 (Ref)': 1,
            '2: Skip Puro {0,2,4,6}': 2,
            '3: Skip Hibrido {0,1,3,5}': 3,
            '4: NVIDIA Truncado N=3': 4,
            '5: Proposta Adaptativa (LOD+Skip)': 5,
        })
        .name('mode')
        .listen()
        .onChange(triggerDiscreteRefresh);

    fAlgo.add(params, 'anisotropicLod').name('LOD Anisotropico').listen().onChange(triggerDiscreteRefresh);
    fAlgo
        .add(params, 'maxAniso', 1, Math.max(1, hwMaxAniso), 1)
        .name('maxAniso')
        .onChange((v) => {
            applyAnisotropyToTextures(v);
            triggerDiscreteRefresh();
        });
    fAlgo.add(params, 'nearLimit', 0.08, 0.55, 0.01).name('nearLimit (1->2)');
    fAlgo.add(params, 'farLimit', 0.35, 0.92, 0.01).name('farLimit (2->3)');
    fAlgo.add(params, 'maxLod', 2.0, 6.0, 0.1).name('maxLod (norm)');
    fAlgo.add(params, 'mip', 0, 6, 1).name('mip').onChange(triggerDiscreteRefresh);
    fAlgo
        .add(params, 'threshold', 0.1, 0.9, 0.01)
        .name('maskThreshold')
        .onChange(() => (masksDirty = true));
    fAlgo
        .add(params, 'maskGain', 1.0, 40.0, 0.5)
        .name('maskGain')
        .onChange(() => (masksDirty = true));
    fAlgo.add(params, 'enable').name('enableBlend').onChange(triggerDiscreteRefresh);

    const fMat = gui.addFolder('Material PBR');
    fMat
        .add(params, 'materialMode', {
            'Albedo (2 Camadas)': 'albedo',
            'PBR 2 Camadas (Alb+Norm+Rough)': 'pbr2',
            'PBR 3 Camadas (Multi-Material)': 'pbr3',
        })
        .name('materialMode')
        .listen()
        .onChange(triggerDiscreteRefresh);
    fMat
        .add(params, 'tex0', {
            Rocha0: 0,
            Musgo1: 1,
            RochaRot: 2,
            MusgoRot: 3,
            Normal0: 4,
            Normal1: 5,
        })
        .name('tex0 (Albedo/2D)');
    fMat
        .add(params, 'tex1', {
            Rocha0: 0,
            Musgo1: 1,
            RochaRot: 2,
            MusgoRot: 3,
            Normal0: 4,
            Normal1: 5,
        })
        .name('tex1 (Albedo/2D)');
    fMat.add(params, 'zoom', 0.5, 4.0, 0.05).name('zoom / tiling');
    fMat.add(params, 'perspectiveTilt', 0.0, 1.0, 0.01).name('2D Tilt');

    const fViz = gui.addFolder('Visualizacao & Debug');
    fViz
        .add(params, 'vizMode', {
            '0: Render Normal': 0,
            '1: Heatmap Custo TMU': 1,
            '2: Mapa de LOD (lambda)': 2,
            '3: Mapa de Anisotropia': 3,
        })
        .name('vizMode');
    fViz.add(params, 'splitCompare').name('splitCompare (NVIDIA|Sel)');

    const fBench = gui.addFolder('Benchmark GPU');
    fBench.add(params, 'runQuickBench').name('Rodar Rapido (1080p)');
    fBench.add(params, 'runFullBench').name('Rodar Completo (1080p+4K)');
    fBench.add(params, 'downloadJSON').name('Exportar JSON');
    fBench.add(params, 'downloadCSV').name('Exportar CSV');
    fBench.add(params, 'save').name('Salvar Captura PNG');

    fScene.open();
    fAlgo.open();
    fViz.open();
    fBench.open();
    gui.open();
}

function setupBenchmarkModalUI() {
    const closeBtn = document.getElementById('bench-close');
    const jsonBtn = document.getElementById('bench-dl-json');
    const csvBtn = document.getElementById('bench-dl-csv');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            document.getElementById('bench-modal').style.display = 'none';
        });
    }
    if (jsonBtn) jsonBtn.addEventListener('click', params.downloadJSON);
    if (csvBtn) csvBtn.addEventListener('click', params.downloadCSV);
}

async function triggerBenchmark(full) {
    if (!benchRunner || benchRunner.isRunning) return;
    const modal = document.getElementById('bench-modal');
    const statusEl = document.getElementById('bench-status');
    const tbody = document.getElementById('bench-tbody');
    const hwEl = document.getElementById('bench-hw');
    if (modal) modal.style.display = 'flex';
    if (tbody) tbody.innerHTML = '';
    if (statusEl) statusEl.textContent = 'Inicializando suite de benchmark...';

    try {
        const report = await benchRunner.runSuite({
            full,
            onProgress: (p) => {
                if (statusEl) {
                    statusEl.textContent = `Executando [${p.step}/${p.total}]: ${p.label}`;
                }
            },
        });
        if (hwEl && report.hardware) {
            const gpuName = report.hardware.unmaskedRenderer || report.hardware.renderer;
            const timerTag = report.hardware.hasGpuTimerQuery
                ? 'EXT_disjoint_timer_query_webgl2 (Hardware)'
                : 'CPU Fallback (gl.finish + performance.now)';
            hwEl.textContent = `GPU: ${gpuName} | Timer: ${timerTag} | Max Aniso: ${report.hardware.maxAnisotropy}x`;
        }
        if (statusEl) {
            statusEl.textContent = `Concluido: ${report.results.length} medicoes registradas.`;
        }
        if (tbody) {
            tbody.innerHTML = report.results
                .map((r) => {
                    const psnrTxt =
                        r.psnr_3d_db === Infinity
                            ? 'inf (Ref)'
                            : r.psnr_3d_db !== null
                              ? `${r.psnr_3d_db.toFixed(2)} dB`
                              : '—';
                    const msTxt = r.mean_ms !== null ? `${r.mean_ms.toFixed(3)} ± ${r.std_ms.toFixed(3)}` : '—';
                    return `<tr>
                        <td>${r.resolution}</td>
                        <td>${r.preset}</td>
                        <td>${r.materialMode}</td>
                        <td>${r.method}</td>
                        <td>${msTxt}</td>
                        <td>${r.fetches_px.toFixed(2)}</td>
                        <td>${r.tmu_reduction_pct.toFixed(1)}%</td>
                        <td>${psnrTxt}</td>
                    </tr>`;
                })
                .join('');
        }
    } catch (err) {
        if (statusEl) statusEl.textContent = `Erro no benchmark: ${err.message}`;
    } finally {
        if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(onAnimationFrame);
        }
    }
}

function downloadText(content, filename, mime) {
    if (!content) return;
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function syncUniforms3D() {
    if (!terrainMaterial || !textures['0']) return;
    const u = terrainMaterial.uniforms;
    const matMap = { albedo: 0, pbr2: 1, pbr3: 2 };

    u.tAlbedo0.value = textures[params.tex0] || textures['0'];
    u.tAlbedo1.value = textures[params.tex1] || textures['1'];
    u.tAlbedo2.value = packedTextures.alb2 || textures['2'];
    u.tNormRough0.value = packedTextures.nr0 || textures['4'];
    u.tNormRough1.value = packedTextures.nr1 || textures['5'];
    u.tNormRough2.value = packedTextures.nr2 || textures['4'];
    u.tMask1.value = maskRT1.texture;
    u.tMask2.value = maskRT2.texture;

    u.enable.value = params.enable ? 1.0 : 0.0;
    u.mode.value = Number(params.mode);
    u.materialMode.value = matMap[params.materialMode] ?? 1;
    u.mip.value = Number(params.mip);
    u.zoom.value = params.zoom;
    u.anisotropicLod.value = params.anisotropicLod ? 1.0 : 0.0;
    u.maxAniso.value = params.maxAniso;
    u.maxLod.value = params.maxLod;
    u.nearLimit.value = params.nearLimit;
    u.farLimit.value = params.farLimit;
    u.transBand.value = TRANS_BAND_3D;
    u.vizMode.value = Number(params.vizMode);
    u.splitCompare.value = params.splitCompare ? 1.0 : 0.0;
    u.debugPass.value = 0;
    u.lodDerivScale.value = 1.0;

    const fbSize = renderer.getDrawingBufferSize(new THREE.Vector2());
    u.resolution.value.set(fbSize.x, fbSize.y);
}

function updateHUDState() {
    const avatarHint = document.getElementById('avatar-hint');
    if (avatarHint) {
        avatarHint.style.display = params.viewMode === '3d' && params.cameraMode === 'avatar' ? 'block' : 'none';
    }
}

// ---------------------------------------------------------------------------
// Timer de GPU (EXT_disjoint_timer_query_webgl2)
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
// Estimativa 2D (usada apenas quando viewMode === '2d')
// ---------------------------------------------------------------------------
function regimeCosts(L, matMode) {
    const perLvl = matMode === 'pbr3' ? 8 : matMode === 'pbr2' ? 5 : 3;
    return {
        full: perLvl * (L + 1),
        skip: perLvl * (Math.ceil(L / 2) + 1),
        lin: perLvl,
    };
}

function smoothstepJS(e0, e1, x) {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

function perspUvJS(x, y, a, tilt) {
    const D = 1.0 / Math.max(1.0 - y * tilt * 0.68, 0.18);
    return [(x - 0.5) * a * D + 0.5 * a, y * (1.0 + (D - 1.0) * 0.85)];
}

function distFactorJS(x, y, W, H, tilt) {
    const a = W / H;
    const dx = 1.0 / W;
    const dy = 1.0 / H;
    const flatGrad = Math.max(a * dx + dy, 1e-6);
    const p = perspUvJS(x, y, a, tilt);
    const px = perspUvJS(x + dx, y, a, tilt);
    const py = perspUvJS(x, y + dy, a, tilt);
    const perspGrad = Math.hypot(px[0] - p[0], px[1] - p[1]) + Math.hypot(py[0] - p[0], py[1] - p[1]);
    const derivRatio = Math.max(0, Math.min(1, (perspGrad / flatGrad - 1.0) / Math.max(tilt * 2.2, 0.001)));
    const k = smoothstepJS(0.0, 0.1, tilt);
    const inner = y + (derivRatio - y) * 0.35;
    return Math.max(0, Math.min(1, y + (inner - y) * k));
}

function estimateCost2D() {
    const W = Math.max(1, renderer ? renderer.domElement.width : window.innerWidth);
    const H = Math.max(1, renderer ? renderer.domElement.height : window.innerHeight);
    const L = Math.max(0, Math.min(6, Math.round(params.mip)));
    const key = [W, H, L, params.mode, params.enable, params.splitCompare, params.perspectiveTilt, params.nearLimit, params.farLimit].join('|');
    if (costCache.key === key) return costCache.value;

    const c = regimeCosts(L, 'albedo');
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
            else if (mode === 2 || mode === 3 || mode === 4) eSkip = true;
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
        pctFull: (nFull / N) * 100.0,
        pctSkip: (nSkip / N) * 100.0,
        pctLin: (nLin / N) * 100.0,
        pctTrans: (nTrans / N) * 100.0,
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
    const elLod = document.getElementById('hud-lod');
    const elGpu = document.getElementById('hud-gpu');
    const elSplitBanner = document.getElementById('split-banner');
    const elSplitRight = document.getElementById('split-right-label');
    const elViewHint = document.getElementById('hud-view-hint');

    if (!elMode) return;

    const activeMode = params.enable ? Number(params.mode) : 0;
    const modeMeta = {
        0: { title: '0: Baseline - Linear Blend', badge: 'BASELINE', short: 'Linear Blend' },
        1: { title: '1: NVIDIA Original N=6 (Ref)', badge: 'NVIDIA 2025', short: 'NVIDIA N=6' },
        2: { title: '2: Skip Puro {0,2,4,6}', badge: 'SKIP PURO', short: 'Skip Puro' },
        3: { title: '3: Skip Hibrido {0,1,3,5}', badge: 'SKIP HIBRIDO', short: 'Skip Hibrido' },
        4: { title: '4: NVIDIA Truncado N=3', badge: 'TRUNC N=3', short: 'Truncado N=3' },
        5: { title: '5: Proposta Adaptativa (LOD+Skip)', badge: 'PROPOSTA 3D', short: 'Adaptativa 3D' },
    };
    const meta = modeMeta[activeMode] || modeMeta[5];
    elMode.textContent = meta.title;
    elBadge.textContent = meta.badge;

    const L = Math.max(0, Math.min(6, Math.round(params.mip)));
    const costs = regimeCosts(L, params.viewMode === '3d' ? params.materialMode : 'albedo');
    const fetchesFull = costs.full;

    let taps, pctNear, pctMid, pctFar, pctTrans, meanLodTxt;
    if (params.viewMode === '3d' && lastTelemetry3D) {
        taps = lastTelemetry3D.fetchesPx;
        pctNear = lastTelemetry3D.pctNear;
        pctMid = lastTelemetry3D.pctMid;
        pctFar = lastTelemetry3D.pctFar;
        pctTrans = lastTelemetry3D.pctTrans;
        meanLodTxt = `${lastTelemetry3D.meanLod.toFixed(2)} (${params.anisotropicLod ? 'Aniso' : 'Iso'})`;
        elBaselineRef.textContent = `NVIDIA (${params.materialMode}, mip ${L}): ${fetchesFull} taps`;
    } else {
        const est = estimateCost2D();
        taps = est.avg;
        pctNear = est.pctFull;
        pctMid = est.pctSkip;
        pctFar = est.pctLin;
        pctTrans = est.pctTrans;
        meanLodTxt = 'Simulacao 2D';
        elBaselineRef.textContent = `NVIDIA 2D (mip ${L}): ${fetchesFull} taps`;
    }

    const savingsPct = fetchesFull > 0 ? ((fetchesFull - taps) / fetchesFull) * 100.0 : 0.0;
    elFetches.textContent = `${taps.toFixed(1)} taps`;

    if (savingsPct > 0.05) {
        elSavings.textContent = `-${savingsPct.toFixed(1)}% fetches`;
        elSavings.className = 'hud-metric-value hud-savings-positive';
        elSavingsSub.textContent = `${(fetchesFull - taps).toFixed(1)} leituras/px a menos`;
    } else {
        elSavings.textContent = '0.0% (Referencia)';
        elSavings.className = 'hud-metric-value hud-savings-neutral';
        elSavingsSub.textContent = 'Custo maximo de referencia';
    }

    elZoneNear.textContent = `${costs.full} taps · ${pctNear.toFixed(1)}%`;
    elZoneMid.textContent = `${costs.skip} taps · ${pctMid.toFixed(1)}%`;
    elZoneFar.textContent = `${costs.lin} taps · ${pctFar.toFixed(1)}%`;
    if (elZoneTrans) elZoneTrans.textContent = `reuso union · ${pctTrans.toFixed(1)}%`;
    if (elLod) elLod.textContent = meanLodTxt;

    if (elGpu) {
        if (!gpuTimer) elGpu.textContent = 'GPU timer indisponivel';
        else if (gpuTimer.emaMs === null) elGpu.textContent = 'medindo...';
        else {
            const gpuFps = Math.round(1000.0 / Math.max(gpuTimer.emaMs, 0.001));
            elGpu.textContent = `${gpuTimer.emaMs.toFixed(3)} ms (~${gpuFps} fps GPU)`;
        }
    }

    if (elSplitBanner && elSplitRight) {
        elSplitBanner.style.display = params.splitCompare ? 'flex' : 'none';
        elSplitRight.innerHTML = `${meta.short} &#9654;`;
    }

    if (elViewHint) {
        if (params.viewMode === '3d') {
            elViewHint.innerHTML =
                params.cameraMode === 'avatar'
                    ? '<span style="color:#38bdf8;">&#9654; Avatar 3D:</span> WASD move · Shift corre · Arraste gira camera'
                    : '<span style="color:#38bdf8;">&#9654; Cena 3D Real:</span> Botao esquerdo orbita · Direito move · Scroll aproxima';
        } else {
            elViewHint.innerHTML = '<span style="color:#94a3b8;">&#9654; Inspecao 2D:</span> Projecao em plano de tela cheia';
        }
    }
}

function saveAsImage() {
    render();
    const imgData = renderer.domElement.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `laplacian_3d_${params.preset}_mode${params.mode}.png`;
    link.href = imgData;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function onWindowResize() {
    aspectRatio = window.innerWidth / window.innerHeight;
    if (camera3D) {
        camera3D.aspect = aspectRatio;
        camera3D.updateProjectionMatrix();
    }
    renderer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener('resize', onWindowResize, false);

function onAnimationFrame() {
    rafPending = false;
    if (benchRunner && benchRunner.isRunning) return;
    render();
}

function getTelemetryStateKey(fbWidth, fbHeight) {
    return [
        camera3D.position.x.toFixed(2),
        camera3D.position.y.toFixed(2),
        camera3D.position.z.toFixed(2),
        camera3D.rotation.x.toFixed(3),
        camera3D.rotation.y.toFixed(3),
        camera3D.rotation.z.toFixed(3),
        params.viewMode,
        params.mode,
        params.materialMode,
        params.anisotropicLod ? 1 : 0,
        params.maxAniso,
        params.nearLimit.toFixed(2),
        params.farLimit.toFixed(2),
        params.maxLod.toFixed(2),
        params.mip,
        params.zoom.toFixed(2),
        params.splitCompare ? 1 : 0,
        params.enable ? 1 : 0,
        params.threshold.toFixed(2),
        params.maskGain.toFixed(1),
        fbWidth,
        fbHeight,
    ].join('|');
}

function render() {
    if ((benchRunner && benchRunner.isRunning) || !textures['0']) return;

    const now = performance.now();
    const dt = Math.min((now - lastFrameClock) / 1000.0, 0.05);
    lastFrameClock = now;

    if (params.viewMode === '3d') {
        ensureMasksUpdated(false);

        if (params.cameraMode === 'avatar' && avatarController) {
            avatarController.update(dt, avatarCamYaw);
            updateThirdPersonCamera(camera3D, avatarController.position, avatarCamYaw, avatarCamPitch, avatarCamDist);
            if (avatarMesh) avatarMesh.visible = true;
        } else {
            if (controls && params.cameraMode === 'orbit') controls.update();
            if (avatarMesh) avatarMesh.visible = params.showAvatar;
        }

        syncUniforms3D();

        // Update 3D telemetry via gl.readPixels only on initial load or after camera/state settles (>=350ms)
        const fbSize = renderer.getDrawingBufferSize(new THREE.Vector2());
        const stateKey = getTelemetryStateKey(fbSize.x, fbSize.y);
        if (stateKey !== lastTelemetryStateKey) {
            lastTelemetryStateKey = stateKey;
            telemetryLastChangeTime = now;
            telemetryPending = true;
        }
        const settled = telemetryPending && (now - telemetryLastChangeTime >= 350);
        if (lastTelemetry3D === null || forceTelemetryImmediate || settled) {
            lastTelemetry3D = measureTelemetry3D(
                renderer,
                scene3D,
                camera3D,
                terrainMaterial,
                skyMesh,
                avatarMesh,
                telemetryRT,
                160,
                90,
                fbSize.x
            );
            telemetryPending = false;
            forceTelemetryImmediate = false;
        }

        gpuTimerBegin();
        renderer.setRenderTarget(null);
        renderer.render(scene3D, camera3D);
        gpuTimerEnd();
    } else {
        effectMask.uniforms.threshold.value = params.threshold;
        effectMask.uniforms.tOriginal.value = textures.mask;
        effectMask.render(renderer, mips.mask[0]);

        for (let i = 0; i < 7; i++) {
            effectCopy.uniforms.tOriginal.value = mips.mask[i].texture;
            effectCopy.render(renderer, mips.mask[i + 1]);
        }

        const u2d = effectFinalCombine.uniforms;
        for (let i = 0; i < 8; i++) {
            u2d['m' + i].value = mips.mask[i].texture;
        }
        u2d.mip.value = params.mip;
        u2d.t0.value = textures[params.tex0];
        u2d.t1.value = textures[params.tex1];
        u2d.enable.value = params.enable ? 1.0 : 0.0;
        u2d.mode.value = Number(params.mode);
        u2d.zoom.value = params.zoom;
        u2d.perspectiveTilt.value = params.perspectiveTilt;
        u2d.nearLimit.value = params.nearLimit;
        u2d.farLimit.value = params.farLimit;
        u2d.transBand.value = TRANS_BAND;
        u2d.heatmap.value = Number(params.vizMode) === 1 ? 1.0 : 0.0;
        u2d.splitCompare.value = params.splitCompare ? 1.0 : 0.0;
        u2d.aspectRatio.value = aspectRatio;

        gpuTimerBegin();
        effectFinalCombine.render(renderer, null);
        gpuTimerEnd();
    }

    gpuTimerPoll();

    updateMetricsHUD();
    if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(onAnimationFrame);
    }
    stats.update();
}
