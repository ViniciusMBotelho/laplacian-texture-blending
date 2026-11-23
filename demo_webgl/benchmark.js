import * as THREE from 'three';
import { applyCameraPreset } from './camera_presets.js';

export const BENCHMARK_METHODS = [
    { id: 'linear', label: 'Linear (Baseline)', mode: 0, anisotropicLod: 1.0 },
    { id: 'nvidia_n6', label: 'NVIDIA N=6 (Ref)', mode: 1, anisotropicLod: 1.0 },
    { id: 'nvidia_n3', label: 'NVIDIA N=3 (Trunc)', mode: 4, anisotropicLod: 1.0 },
    { id: 'skip_pure', label: 'Skip Puro {0,2,4,6}', mode: 2, anisotropicLod: 1.0 },
    { id: 'skip_hybrid', label: 'Skip Hibrido {0,1,3,5}', mode: 3, anisotropicLod: 1.0 },
    { id: 'adap_iso', label: 'Adaptativo Isotropico', mode: 5, anisotropicLod: 0.0 },
    { id: 'adap_aniso', label: 'Adaptativo Anisotropico', mode: 5, anisotropicLod: 1.0 },
];

const MATERIAL_MODE_CODES = { albedo: 0, pbr2: 1, pbr3: 2 };

function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
}

function summarize(values) {
    if (!values.length) {
        return { mean: null, std: null, median: null, p95: null, min: null, max: null, n: 0 };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const mean = sorted.reduce((acc, v) => acc + v, 0) / n;
    const variance = sorted.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / n;
    const mid = Math.floor(n / 2);
    const median = n % 2 === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
    const p95Idx = Math.min(n - 1, Math.floor(0.95 * (n - 1)));
    return {
        mean,
        std: Math.sqrt(variance),
        median,
        p95: sorted[p95Idx],
        min: sorted[0],
        max: sorted[n - 1],
        n,
    };
}

export function getHardwareMetadata(renderer) {
    const gl = renderer.getContext();
    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const timerExt = isWebGL2
        ? gl.getExtension('EXT_disjoint_timer_query_webgl2')
        : gl.getExtension('EXT_disjoint_timer_query');

    return {
        webglVersion: gl.getParameter(gl.VERSION),
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
        maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
        hasGpuTimerQuery: Boolean(timerExt),
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString(),
    };
}

/**
 * Reads exact GPU telemetry (fetches/px, zone coverage, mean LOD) from debugPass = 1.
 */
export function measureTelemetry3D(
    renderer,
    scene3D,
    camera3D,
    terrainMaterial,
    skyMesh,
    avatarMesh,
    rt,
    width,
    height,
    refWidth = width
) {
    const prevDebug = terrainMaterial.uniforms.debugPass.value;
    const prevViz = terrainMaterial.uniforms.vizMode.value;
    const prevSplit = terrainMaterial.uniforms.splitCompare.value;
    const prevDerivScale = terrainMaterial.uniforms.lodDerivScale.value;
    const prevResX = terrainMaterial.uniforms.resolution.value.x;
    const prevResY = terrainMaterial.uniforms.resolution.value.y;
    const prevSkyVis = skyMesh ? skyMesh.visible : true;
    const prevAvVis = avatarMesh ? avatarMesh.visible : false;
    const prevBg = scene3D.background;
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();
    const prevAspect = camera3D.aspect;

    try {
        scene3D.background = null;
        if (skyMesh) skyMesh.visible = false;
        if (avatarMesh) avatarMesh.visible = false;
        terrainMaterial.uniforms.debugPass.value = 1;
        terrainMaterial.uniforms.vizMode.value = 0;
        terrainMaterial.uniforms.splitCompare.value = 0.0;
        terrainMaterial.uniforms.lodDerivScale.value = width / Math.max(refWidth, 1);
        terrainMaterial.uniforms.resolution.value.set(width, height);
        camera3D.aspect = width / height;
        camera3D.updateProjectionMatrix();

        renderer.setRenderTarget(rt);
        renderer.setClearColor(0x000000, 0.0);
        renderer.clear(true, true, false);
        renderer.render(scene3D, camera3D);

        const buf = new Uint8Array(width * height * 4);
        renderer.readRenderTargetPixels(rt, 0, 0, width, height, buf);
        renderer.setRenderTarget(null);

        let terrainPx = 0;
        let sumFetches = 0;
        let sumLod = 0;
        let nNear = 0;
        let nMid = 0;
        let nFar = 0;
        let nTrans = 0;
        let nOther = 0;

        for (let i = 0; i < buf.length; i += 4) {
            if (buf[i + 3] < 128) continue;
            terrainPx++;
            sumFetches += buf[i];
            const reg = buf[i + 1];
            if (reg === 1) nNear++;
            else if (reg === 2) nMid++;
            else if (reg === 3) nFar++;
            else if (reg === 4) nTrans++;
            else nOther++;
            sumLod += (buf[i + 2] / 255.0) * 8.0;
        }

        const totalPx = width * height;
        if (terrainPx === 0) {
            return {
                terrainPixels: 0,
                terrainCoveragePct: 0,
                fetchesPx: 0,
                pctNear: 0,
                pctMid: 0,
                pctFar: 0,
                pctTrans: 0,
                pctOther: 0,
                meanLod: 0,
            };
        }

        return {
            terrainPixels: terrainPx,
            terrainCoveragePct: (terrainPx / totalPx) * 100.0,
            fetchesPx: sumFetches / terrainPx,
            pctNear: (nNear / terrainPx) * 100.0,
            pctMid: (nMid / terrainPx) * 100.0,
            pctFar: (nFar / terrainPx) * 100.0,
            pctTrans: (nTrans / terrainPx) * 100.0,
            pctOther: (nOther / terrainPx) * 100.0,
            meanLod: sumLod / terrainPx,
        };
    } finally {
        scene3D.background = prevBg;
        if (skyMesh) skyMesh.visible = prevSkyVis;
        if (avatarMesh) avatarMesh.visible = prevAvVis;
        terrainMaterial.uniforms.debugPass.value = prevDebug;
        terrainMaterial.uniforms.vizMode.value = prevViz;
        terrainMaterial.uniforms.splitCompare.value = prevSplit;
        terrainMaterial.uniforms.lodDerivScale.value = prevDerivScale;
        terrainMaterial.uniforms.resolution.value.set(prevResX, prevResY);
        camera3D.aspect = prevAspect;
        camera3D.updateProjectionMatrix();
        renderer.setClearColor(prevClearColor, prevClearAlpha);
        renderer.setRenderTarget(null);
    }
}

function captureTerrainFrameBytes(renderer, scene3D, camera3D, terrainMaterial, skyMesh, avatarMesh, rt, width, height) {
    const prevSkyVis = skyMesh ? skyMesh.visible : true;
    const prevAvVis = avatarMesh ? avatarMesh.visible : false;
    const prevBg = scene3D.background;
    const prevDerivScale = terrainMaterial.uniforms.lodDerivScale.value;
    const prevResX = terrainMaterial.uniforms.resolution.value.x;
    const prevResY = terrainMaterial.uniforms.resolution.value.y;
    const prevAspect = camera3D.aspect;
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();

    try {
        scene3D.background = null;
        if (skyMesh) skyMesh.visible = false;
        if (avatarMesh) avatarMesh.visible = false;
        terrainMaterial.uniforms.debugPass.value = 0;
        terrainMaterial.uniforms.vizMode.value = 0;
        terrainMaterial.uniforms.splitCompare.value = 0.0;
        terrainMaterial.uniforms.lodDerivScale.value = 1.0;
        terrainMaterial.uniforms.resolution.value.set(width, height);
        camera3D.aspect = width / height;
        camera3D.updateProjectionMatrix();

        renderer.setRenderTarget(rt);
        renderer.setClearColor(0x000000, 0.0);
        renderer.clear(true, true, false);
        renderer.render(scene3D, camera3D);

        const buf = new Uint8Array(width * height * 4);
        renderer.readRenderTargetPixels(rt, 0, 0, width, height, buf);
        renderer.setRenderTarget(null);
        return buf;
    } finally {
        scene3D.background = prevBg;
        if (skyMesh) skyMesh.visible = prevSkyVis;
        if (avatarMesh) avatarMesh.visible = prevAvVis;
        terrainMaterial.uniforms.lodDerivScale.value = prevDerivScale;
        terrainMaterial.uniforms.resolution.value.set(prevResX, prevResY);
        camera3D.aspect = prevAspect;
        camera3D.updateProjectionMatrix();
        renderer.setClearColor(prevClearColor, prevClearAlpha);
        renderer.setRenderTarget(null);
    }
}

function computeTerrainPsnr(bufA, bufRef) {
    let sqErr = 0.0;
    let count = 0;
    for (let i = 0; i < bufRef.length; i += 4) {
        if (bufRef[i + 3] < 128 || bufA[i + 3] < 128) continue;
        const dr = (bufA[i] - bufRef[i]) / 255.0;
        const dg = (bufA[i + 1] - bufRef[i + 1]) / 255.0;
        const db = (bufA[i + 2] - bufRef[i + 2]) / 255.0;
        sqErr += dr * dr + dg * dg + db * db;
        count += 3;
    }
    if (count === 0) return null;
    const mse = sqErr / count;
    if (mse <= 1e-12) return Infinity;
    return 10.0 * Math.log10(1.0 / mse);
}

/**
 * Measures all benchmark methods for one (resolution, preset, material) case using
 * alternating round-robin interleaving within each animation frame to prevent GPU
 * DVFS idle clock drops and cancel thermal/clock drift across methods.
 */
async function measureGpuCaseInterleaved(
    renderer,
    scene3D,
    camera3D,
    terrainMaterial,
    params,
    benchRT,
    methods,
    warmupRounds,
    sampleRounds,
    onRoundProgress = null
) {
    const gl = renderer.getContext();
    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const ext = isWebGL2
        ? gl.getExtension('EXT_disjoint_timer_query_webgl2')
        : gl.getExtension('EXT_disjoint_timer_query');

    const samplesByMethod = Object.fromEntries(methods.map((m) => [m.id, []]));

    const applyMethodUniforms = (m) => {
        params.mode = m.mode;
        params.anisotropicLod = m.anisotropicLod > 0.5;
        terrainMaterial.uniforms.mode.value = m.mode;
        terrainMaterial.uniforms.anisotropicLod.value = m.anisotropicLod;
    };

    // Continuous GPU clock warm-up (12 renders across 4 ticks of NVIDIA N=6)
    const refMethod = methods.find((m) => m.id === 'nvidia_n6') || methods[0];
    applyMethodUniforms(refMethod);
    for (let tick = 0; tick < 4; tick++) {
        for (let rep = 0; rep < 3; rep++) {
            renderer.setRenderTarget(benchRT);
            renderer.render(scene3D, camera3D);
        }
        await nextFrame();
    }

    const totalRounds = warmupRounds + sampleRounds;

    if (!ext) {
        gl.finish();
        for (let r = 0; r < totalRounds; r++) {
            const order = r % 2 === 0 ? methods : [...methods].reverse();
            for (const m of order) {
                applyMethodUniforms(m);
                const t0 = performance.now();
                renderer.setRenderTarget(benchRT);
                renderer.render(scene3D, camera3D);
                gl.finish();
                if (r >= warmupRounds) {
                    samplesByMethod[m.id].push(performance.now() - t0);
                }
            }
            if (onRoundProgress) onRoundProgress(r + 1, totalRounds);
            await nextFrame();
        }
        renderer.setRenderTarget(null);
        return { timerType: 'cpu_fallback', samplesByMethod };
    }

    const pending = [];

    function drainAvailable() {
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        while (pending.length > 0) {
            const item = pending[0];
            const avail = isWebGL2
                ? gl.getQueryParameter(item.q, gl.QUERY_RESULT_AVAILABLE)
                : ext.getQueryObjectEXT(item.q, ext.QUERY_RESULT_AVAILABLE_EXT);
            if (!avail) break;
            pending.shift();
            if (!disjoint && item.record) {
                const ns = isWebGL2
                    ? gl.getQueryParameter(item.q, gl.QUERY_RESULT)
                    : ext.getQueryObjectEXT(item.q, ext.QUERY_RESULT_EXT);
                samplesByMethod[item.methodId].push(ns / 1e6);
            }
            if (isWebGL2) gl.deleteQuery(item.q);
            else ext.deleteQueryEXT(item.q);
        }
    }

    for (let r = 0; r < totalRounds; r++) {
        const order = r % 2 === 0 ? methods : [...methods].reverse();
        const record = r >= warmupRounds;
        for (const m of order) {
            applyMethodUniforms(m);
            const q = isWebGL2 ? gl.createQuery() : ext.createQueryEXT();
            renderer.setRenderTarget(benchRT);
            if (isWebGL2) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
            else ext.beginQueryEXT(ext.TIME_ELAPSED_EXT, q);

            renderer.render(scene3D, camera3D);

            if (isWebGL2) gl.endQuery(ext.TIME_ELAPSED_EXT);
            else ext.endQueryEXT(ext.TIME_ELAPSED_EXT);

            pending.push({ methodId: m.id, q, record });
        }
        drainAvailable();
        if (onRoundProgress) onRoundProgress(r + 1, totalRounds);
        await nextFrame();
    }

    const deadline = performance.now() + 4000;
    while (pending.length > 0 && performance.now() < deadline) {
        drainAvailable();
        if (pending.length > 0) await nextFrame();
    }

    while (pending.length > 0) {
        const item = pending.shift();
        if (isWebGL2) gl.deleteQuery(item.q);
        else ext.deleteQueryEXT(item.q);
    }

    renderer.setRenderTarget(null);
    return { timerType: 'gpu_timer_query', samplesByMethod };
}

export class BenchmarkRunner {
    constructor(ctx) {
        this.ctx = ctx;
        this.isRunning = false;
        this.lastReport = null;
    }

    async runSuite({ full = false, onProgress = null } = {}) {
        if (this.isRunning) throw new Error('Benchmark already running.');
        this.isRunning = true;

        const {
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
        } = this.ctx;

        const saved = {
            viewMode: params.viewMode,
            cameraMode: params.cameraMode,
            preset: params.preset,
            mode: params.mode,
            materialMode: params.materialMode,
            anisotropicLod: params.anisotropicLod,
            vizMode: params.vizMode,
            splitCompare: params.splitCompare,
            enable: params.enable,
            showAvatar: params.showAvatar,
            pixelRatio: renderer.getPixelRatio(),
            size: renderer.getSize(new THREE.Vector2()),
            camPos: camera3D.position.clone(),
            camTarget: controls ? controls.target.clone() : new THREE.Vector3(),
            camFov: camera3D.fov,
            camAspect: camera3D.aspect,
        };

        const resolutions = full
            ? [
                  { name: '1080p', width: 1920, height: 1080, presets: ['overview', 'grazing', 'closeup', 'aerial'], materials: ['pbr2'] },
                  { name: '1080p_mat', width: 1920, height: 1080, presets: ['overview'], materials: ['albedo', 'pbr3'] },
                  { name: '4K', width: 3840, height: 2160, presets: ['overview', 'grazing'], materials: ['pbr2'] },
              ]
            : [
                  { name: '1080p', width: 1920, height: 1080, presets: ['overview', 'grazing'], materials: ['pbr2'] },
              ];

        const warmupFrames = full ? 3 : 2;
        const sampleFrames = full ? 25 : 18;

        const rtProps = {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            depthBuffer: true,
        };
        const telemetryRT = new THREE.WebGLRenderTarget(320, 180, rtProps);
        const qualityRT = new THREE.WebGLRenderTarget(960, 540, rtProps);

        const entries = [];
        const cases = [];
        for (const r of resolutions) {
            for (const preset of r.presets) {
                for (const matKey of r.materials) {
                    cases.push({ resName: r.name === '1080p_mat' ? '1080p' : r.name, width: r.width, height: r.height, preset, matKey });
                }
            }
        }

        const totalSteps = cases.length;
        let stepIdx = 0;

        try {
            ensureMasksUpdated(true);
            params.viewMode = '3d';
            params.enable = true;
            params.vizMode = 0;
            params.splitCompare = false;
            if (avatarMesh) avatarMesh.visible = false;
            if (skyMesh) skyMesh.visible = true;

            renderer.setPixelRatio(1);

            for (const c of cases) {
                stepIdx++;
                const benchRT = new THREE.WebGLRenderTarget(c.width, c.height, rtProps);
                let refFrameBytes = null;
                let refTimingMean = null;
                let refFetches = null;

                // Measure reference first so PSNR and fetches/px are computed before the timing loop
                const orderedMethods = [
                    BENCHMARK_METHODS.find((m) => m.id === 'nvidia_n6'),
                    ...BENCHMARK_METHODS.filter((m) => m.id !== 'nvidia_n6'),
                ];

                const telemetryById = {};
                const psnrById = {};

                try {
                    if (onProgress) {
                        onProgress({
                            step: stepIdx,
                            total: totalSteps,
                            label: `${c.resName} · ${c.preset} · ${c.matKey} (Telemetria + PSNR)`,
                        });
                    }

                    applyCameraPreset(camera3D, controls, c.preset);
                    camera3D.aspect = c.width / c.height;
                    camera3D.updateProjectionMatrix();

                    for (const m of orderedMethods) {
                        params.mode = m.mode;
                        params.materialMode = c.matKey;
                        params.anisotropicLod = m.anisotropicLod > 0.5;
                        syncUniforms3D();
                        terrainMaterial.uniforms.mode.value = m.mode;
                        terrainMaterial.uniforms.materialMode.value = MATERIAL_MODE_CODES[c.matKey];
                        terrainMaterial.uniforms.anisotropicLod.value = m.anisotropicLod;
                        terrainMaterial.uniforms.vizMode.value = 0;
                        terrainMaterial.uniforms.splitCompare.value = 0.0;
                        terrainMaterial.uniforms.debugPass.value = 0;
                        terrainMaterial.uniforms.resolution.value.set(c.width, c.height);

                        telemetryById[m.id] = measureTelemetry3D(
                            renderer,
                            scene3D,
                            camera3D,
                            terrainMaterial,
                            skyMesh,
                            avatarMesh,
                            telemetryRT,
                            320,
                            180,
                            c.width
                        );

                        const frameBytes = captureTerrainFrameBytes(
                            renderer,
                            scene3D,
                            camera3D,
                            terrainMaterial,
                            skyMesh,
                            avatarMesh,
                            qualityRT,
                            960,
                            540
                        );
                        if (m.id === 'nvidia_n6') {
                            refFrameBytes = frameBytes;
                        }
                        psnrById[m.id] =
                            m.id === 'nvidia_n6'
                                ? Infinity
                                : computeTerrainPsnr(frameBytes, refFrameBytes);
                    }

                    // Restore full scene state (sky visible, benchmark resolution) with no readPixels during timing
                    if (skyMesh) skyMesh.visible = true;
                    if (avatarMesh) avatarMesh.visible = false;
                    terrainMaterial.uniforms.materialMode.value = MATERIAL_MODE_CODES[c.matKey];
                    terrainMaterial.uniforms.debugPass.value = 0;
                    terrainMaterial.uniforms.vizMode.value = 0;
                    terrainMaterial.uniforms.splitCompare.value = 0.0;
                    terrainMaterial.uniforms.lodDerivScale.value = 1.0;
                    terrainMaterial.uniforms.resolution.value.set(c.width, c.height);
                    camera3D.aspect = c.width / c.height;
                    camera3D.updateProjectionMatrix();

                    const timing = await measureGpuCaseInterleaved(
                        renderer,
                        scene3D,
                        camera3D,
                        terrainMaterial,
                        params,
                        benchRT,
                        BENCHMARK_METHODS,
                        warmupFrames,
                        sampleFrames,
                        (rnd, tot) => {
                            if (onProgress) {
                                onProgress({
                                    step: stepIdx,
                                    total: totalSteps,
                                    label: `${c.resName} · ${c.preset} · ${c.matKey} (GPU rodada ${rnd}/${tot})`,
                                });
                            }
                        }
                    );

                    const statsById = {};
                    for (const m of BENCHMARK_METHODS) {
                        statsById[m.id] = summarize(timing.samplesByMethod[m.id] || []);
                    }

                    refTimingMean = statsById.nvidia_n6?.mean ?? null;
                    refFetches = telemetryById.nvidia_n6?.fetchesPx ?? null;

                    for (const m of BENCHMARK_METHODS) {
                        const stats = statsById[m.id];
                        const telemetry = telemetryById[m.id];
                        entries.push({
                            resolution: c.resName,
                            width: c.width,
                            height: c.height,
                            preset: c.preset,
                            materialMode: c.matKey,
                            methodId: m.id,
                            method: m.label,
                            timerType: timing.timerType,
                            mean_ms: stats.mean,
                            std_ms: stats.std,
                            median_ms: stats.median,
                            p95_ms: stats.p95,
                            speedup_vs_ref_pct:
                                refTimingMean && stats.mean
                                    ? ((refTimingMean - stats.mean) / refTimingMean) * 100.0
                                    : 0.0,
                            fetches_px: telemetry.fetchesPx,
                            tmu_reduction_pct:
                                refFetches && refFetches > 0
                                    ? ((refFetches - telemetry.fetchesPx) / refFetches) * 100.0
                                    : 0.0,
                            psnr_3d_db: psnrById[m.id],
                            pct_near: telemetry.pctNear,
                            pct_mid: telemetry.pctMid,
                            pct_far: telemetry.pctFar,
                            pct_trans: telemetry.pctTrans,
                            mean_lod: telemetry.meanLod,
                            terrain_coverage_pct: telemetry.terrainCoveragePct,
                        });
                    }
                } finally {
                    benchRT.dispose();
                }
            }

            const report = {
                hardware: getHardwareMetadata(renderer),
                config: {
                    full,
                    warmupFrames,
                    sampleFrames,
                    nearLimit: params.nearLimit,
                    farLimit: params.farLimit,
                    maxLod: params.maxLod,
                    maxAniso: params.maxAniso,
                    mip: params.mip,
                    threshold: params.threshold,
                    maskGain: params.maskGain,
                },
                results: entries,
            };
            this.lastReport = report;
            return report;
        } finally {
            telemetryRT.dispose();
            qualityRT.dispose();

            params.viewMode = saved.viewMode;
            params.cameraMode = saved.cameraMode;
            params.preset = saved.preset;
            params.mode = saved.mode;
            params.materialMode = saved.materialMode;
            params.anisotropicLod = saved.anisotropicLod;
            params.vizMode = saved.vizMode;
            params.splitCompare = saved.splitCompare;
            params.enable = saved.enable;
            params.showAvatar = saved.showAvatar;

            renderer.setPixelRatio(saved.pixelRatio);
            renderer.setSize(saved.size.x, saved.size.y, false);
            renderer.setRenderTarget(null);

            camera3D.fov = saved.camFov;
            camera3D.aspect = saved.camAspect;
            camera3D.position.copy(saved.camPos);
            camera3D.updateProjectionMatrix();
            if (controls) {
                controls.target.copy(saved.camTarget);
                controls.update();
            }
            if (skyMesh) skyMesh.visible = true;
            if (avatarMesh) avatarMesh.visible = saved.showAvatar && saved.cameraMode === 'avatar';
            syncUniforms3D();

            this.isRunning = false;
        }
    }

    exportJSON() {
        if (!this.lastReport) return null;
        return JSON.stringify(
            this.lastReport,
            (_k, v) => (v === Infinity ? 'Infinity' : v),
            2
        );
    }

    exportCSV() {
        if (!this.lastReport || !this.lastReport.results.length) return '';
        const cols = [
            'resolution',
            'preset',
            'materialMode',
            'method',
            'timerType',
            'mean_ms',
            'std_ms',
            'median_ms',
            'p95_ms',
            'speedup_vs_ref_pct',
            'fetches_px',
            'tmu_reduction_pct',
            'psnr_3d_db',
            'pct_near',
            'pct_mid',
            'pct_far',
            'pct_trans',
            'mean_lod',
        ];
        const lines = [cols.join(',')];
        for (const r of this.lastReport.results) {
            const vals = cols.map((c) => {
                const v = r[c];
                if (v === null || v === undefined) return '';
                if (v === Infinity) return 'inf';
                if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
                return `"${String(v).replace(/"/g, '""')}"`;
            });
            lines.push(vals.join(','));
        }
        return lines.join('\n');
    }

    /**
     * Captures GPU-rendered comparison frames directly from the WebGL framebuffer.
     */
    captureComparisonFrames(preset = 'overview', materialMode = 'pbr2', width = 1280, height = 720) {
        const {
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
        } = this.ctx;

        const saved = {
            viewMode: params.viewMode,
            cameraMode: params.cameraMode,
            preset: params.preset,
            mode: params.mode,
            materialMode: params.materialMode,
            anisotropicLod: params.anisotropicLod,
            vizMode: params.vizMode,
            splitCompare: params.splitCompare,
            enable: params.enable,
            showAvatar: params.showAvatar,
            pixelRatio: renderer.getPixelRatio(),
            size: renderer.getSize(new THREE.Vector2()),
            camPos: camera3D.position.clone(),
            camTarget: controls ? controls.target.clone() : new THREE.Vector3(),
            camFov: camera3D.fov,
            camAspect: camera3D.aspect,
        };

        const maskRT = new THREE.WebGLRenderTarget(width, height, {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            depthBuffer: true,
        });

        try {
            ensureMasksUpdated(true);
            params.viewMode = '3d';
            params.enable = true;
            params.splitCompare = false;
            params.materialMode = materialMode;
            if (avatarMesh) avatarMesh.visible = false;
            if (skyMesh) skyMesh.visible = true;

            renderer.setPixelRatio(1);
            renderer.setSize(width, height, false);
            applyCameraPreset(camera3D, controls, preset);
            camera3D.aspect = width / height;
            camera3D.updateProjectionMatrix();

            const targets = [
                { key: 'linear', mode: 0, aniso: 1.0, viz: 0 },
                { key: 'nvidia_n6', mode: 1, aniso: 1.0, viz: 0 },
                { key: 'skip_pure', mode: 2, aniso: 1.0, viz: 0 },
                { key: 'adap_iso', mode: 5, aniso: 0.0, viz: 0 },
                { key: 'adap_aniso', mode: 5, aniso: 1.0, viz: 0 },
                { key: 'adap_aniso_heatmap', mode: 5, aniso: 1.0, viz: 1 },
            ];

            const frames = {};
            for (const t of targets) {
                params.mode = t.mode;
                params.anisotropicLod = t.aniso > 0.5;
                params.vizMode = t.viz;
                syncUniforms3D();
                terrainMaterial.uniforms.mode.value = t.mode;
                terrainMaterial.uniforms.materialMode.value = MATERIAL_MODE_CODES[materialMode];
                terrainMaterial.uniforms.anisotropicLod.value = t.aniso;
                terrainMaterial.uniforms.vizMode.value = t.viz;
                terrainMaterial.uniforms.resolution.value.set(width, height);

                renderer.setRenderTarget(null);
                renderer.render(scene3D, camera3D);
                frames[t.key] = renderer.domElement.toDataURL('image/png');
            }

            // Capture exact terrain silhouette mask (flipping Y from bottom-up WebGL readPixels)
            const maskBytes = captureTerrainFrameBytes(
                renderer,
                scene3D,
                camera3D,
                terrainMaterial,
                skyMesh,
                avatarMesh,
                maskRT,
                width,
                height
            );
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx2d = canvas.getContext('2d');
            const imgData = ctx2d.createImageData(width, height);
            for (let y = 0; y < height; y++) {
                const srcRow = height - 1 - y;
                for (let x = 0; x < width; x++) {
                    const si = (srcRow * width + x) * 4;
                    const di = (y * width + x) * 4;
                    const v = maskBytes[si + 3] > 128 ? 255 : 0;
                    imgData.data[di] = v;
                    imgData.data[di + 1] = v;
                    imgData.data[di + 2] = v;
                    imgData.data[di + 3] = 255;
                }
            }
            ctx2d.putImageData(imgData, 0, 0);
            frames.terrain_mask = canvas.toDataURL('image/png');

            return frames;
        } finally {
            maskRT.dispose();
            params.viewMode = saved.viewMode;
            params.cameraMode = saved.cameraMode;
            params.preset = saved.preset;
            params.mode = saved.mode;
            params.materialMode = saved.materialMode;
            params.anisotropicLod = saved.anisotropicLod;
            params.vizMode = saved.vizMode;
            params.splitCompare = saved.splitCompare;
            params.enable = saved.enable;
            params.showAvatar = saved.showAvatar;

            renderer.setPixelRatio(saved.pixelRatio);
            renderer.setSize(saved.size.x, saved.size.y, false);
            renderer.setRenderTarget(null);

            camera3D.fov = saved.camFov;
            camera3D.aspect = saved.camAspect;
            camera3D.position.copy(saved.camPos);
            camera3D.updateProjectionMatrix();
            if (controls) {
                controls.target.copy(saved.camTarget);
                controls.update();
            }
            if (skyMesh) skyMesh.visible = true;
            if (avatarMesh) avatarMesh.visible = saved.showAvatar && saved.cameraMode === 'avatar';
            syncUniforms3D();
        }
    }
}
