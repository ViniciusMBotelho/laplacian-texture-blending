import * as THREE from 'three';
import { applyCameraPreset } from './camera_presets.js';

export { BENCHMARK_METHODS } from './benchmark_protocol.js';
import { BENCHMARK_METHODS, SCHEMA_VERSION, applyBenchmarkMethod, benchmarkCases, timingSummary } from './benchmark_protocol.js';
import { measureGpuCaseInterleaved } from './gpu_timer.js';
import { computeTerrainPsnr, terrainPng } from './quality.js';

const MATERIAL_MODE_CODES = { albedo: 0, pbr2: 1, pbr3: 2 };

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

export class BenchmarkRunner {
    constructor(ctx) {
        this.ctx = ctx;
        this.isRunning = false;
        this.lastReport = null;
    }

    async runSuite({ full = false, smoke = false, resolutionCheck = false, sessionId = 'interactive', onProgress = null,
        sampleFrames = smoke ? 3 : 100, warmupFrames = smoke ? 1 : 5,
        warmupDraws = smoke ? 6 : 60, includeFrames = true, onFrame = null } = {}) {
        if (this.isRunning) throw new Error('Benchmark already running.');
        for (const [name, value] of Object.entries({ sampleFrames, warmupFrames, warmupDraws }))
            if (!Number.isInteger(value) || value < (name === 'sampleFrames' ? 1 : 0)) throw new Error(`Invalid ${name}`);
        this.isRunning = true;
        const { renderer, scene3D, camera3D, controls, terrainMaterial, skyMesh, avatarMesh,
            params, ensureMasksUpdated, syncUniforms3D } = this.ctx;
        const savedParams = { ...params };
        const saved = { pixelRatio: renderer.getPixelRatio(), size: renderer.getSize(new THREE.Vector2()),
            camPos: camera3D.position.clone(), camTarget: controls?.target.clone(),
            camFov: camera3D.fov, camAspect: camera3D.aspect, bg: scene3D.background,
            sky: skyMesh?.visible, avatar: avatarMesh?.visible };
        const entries = [], rawQueries = [];
        const cases = benchmarkCases({ full, smoke, resolutionCheck });
        try {
            const hardware = getHardwareMetadata(renderer);
            if (!hardware.hasGpuTimerQuery) throw new Error('GPU timer query unavailable; scientific benchmark requires hardware timer.');
            ensureMasksUpdated(true);
            Object.assign(params, { viewMode: '3d', enable: true, vizMode: 0, splitCompare: false });
            renderer.setPixelRatio(1);
            if (avatarMesh) avatarMesh.visible = false;
            for (const [caseIndex, c] of cases.entries()) {
                const caseId = `${c.resolution}_${c.preset}_${c.materialMode}`;
                onProgress?.({ step: caseIndex + 1, total: cases.length, label: `${caseId}: quality captures` });
                const target = new THREE.WebGLRenderTarget(c.width, c.height, {
                    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
                    format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true });
                try {
                    renderer.setSize(c.width, c.height, false);
                    applyCameraPreset(camera3D, controls, c.preset);
                    camera3D.aspect = c.width / c.height; camera3D.updateProjectionMatrix();
                    params.materialMode = c.materialMode;
                    syncUniforms3D();
                    terrainMaterial.uniforms.resolution.value.set(c.width, c.height);
                    terrainMaterial.uniforms.lodDerivScale.value = 1;
                    const quality = {}, telemetry = {};
                    let reference;
                    const ordered = [BENCHMARK_METHODS.find(m => m.id === 'nvidia_n6'),
                        ...BENCHMARK_METHODS.filter(m => m.id !== 'nvidia_n6')];
                    for (const method of ordered) {
                        applyBenchmarkMethod(params, terrainMaterial.uniforms, method);
                        // Both metrics and telemetry use exactly the timed dimensions.
                        telemetry[method.id] = measureTelemetry3D(renderer, scene3D, camera3D, terrainMaterial,
                            skyMesh, avatarMesh, target, c.width, c.height, c.width);
                        const bytes = captureTerrainFrameBytes(renderer, scene3D, camera3D, terrainMaterial,
                            skyMesh, avatarMesh, target, c.width, c.height);
                        if (method.id === 'nvidia_n6') reference = bytes;
                        quality[method.id] = { psnr: computeTerrainPsnr(bytes, reference),
                            quality_frame: `frames/${caseId}_${method.id}.png`,
                            imageDataUrl: includeFrames ? terrainPng(bytes, c.width, c.height) : null };
                        if (onFrame && quality[method.id].imageDataUrl) {
                            onFrame({ path: quality[method.id].quality_frame, dataUrl: quality[method.id].imageDataUrl });
                            quality[method.id].imageDataUrl = null;
                        }
                    }
                    // Quality readback is completed BEFORE any timing query starts.
                    if (skyMesh) skyMesh.visible = true;
                    const timing = await measureGpuCaseInterleaved(renderer, scene3D, camera3D, terrainMaterial,
                        params, target, BENCHMARK_METHODS, warmupFrames, sampleFrames,
                        (round, total) => onProgress?.({ step: caseIndex + 1, total: cases.length,
                            label: `${caseId}: GPU ${round}/${total}` }), { warmupDraws });
                    const records = timing.records.map(r => ({ ...r, caseId, sessionId }));
                    rawQueries.push(...records);
                    const refStats = timingSummary(records, 'nvidia_n6');
                    for (const method of BENCHMARK_METHODS) {
                        const stats = timingSummary(records, method.id), t = telemetry[method.id], q = quality[method.id];
                        entries.push({ ...c, caseId, sessionId, methodId: method.id, method: method.label,
                            lod_estimator: method.anisotropicLod ? 'aniso' : 'iso', base_filter: method.baseFilter,
                            sampling_lod_estimator: 'aniso_fixed',
                            timerType: timing.timerType, n_requested: stats.requested, n_valid: stats.n,
                            n_discarded: stats.discarded, discardedByReason: stats.discardedByReason,
                            mean_ms: stats.mean, std_ms: stats.std, median_ms: stats.median,
                            p95_ms: stats.p95, q1_ms: stats.q1, q3_ms: stats.q3, iqr_ms: stats.iqr,
                            speedup_vs_ref_pct: stats.mean && refStats.mean ? 100 * (1 - stats.mean / refStats.mean) : null,
                            fetches_px: t.fetchesPx, logical_sample_reduction_pct: 100 * (1 - t.fetchesPx / telemetry.nvidia_n6.fetchesPx),
                            psnr_3d_db: q.psnr, quality_width: c.width, quality_height: c.height,
                            quality_frame: q.quality_frame, quality_reference: 'nvidia_n6',
                            imageDataUrl: q.imageDataUrl, terrain_coverage_pct: t.terrainCoveragePct,
                            pct_near: t.pctNear, pct_mid: t.pctMid, pct_far: t.pctFar, pct_trans: t.pctTrans,
                            mean_lod: t.meanLod });
                    }
                } finally { target.dispose(); }
            }
            const report = { schemaVersion: SCHEMA_VERSION, sessionId, hardware,
                config: { full, smoke, resolutionCheck, sampleFrames, warmupFrames, warmupDraws,
                    nearLimit: params.nearLimit, farLimit: params.farLimit, maxLod: params.maxLod,
                    maxAniso: params.maxAniso, mip: params.mip, threshold: params.threshold, maskGain: params.maskGain,
                    qualityMatchesTimingResolution: true, telemetryMatchesTimingResolution: true,
                    referenceId: 'nvidia_n6', referenceFilter: 'grad', samplingLodEstimator: 'aniso_fixed', timingScope: 'scene_pass_with_sky',
                    maskPreparationTimed: false, cpuFallbackAllowed: false, ablation: 'lod_estimator x base_filter' },
                results: entries, rawQueries };
            this.lastReport = report;
            return report;
        } finally {
            Object.assign(params, savedParams);
            renderer.setPixelRatio(saved.pixelRatio); renderer.setSize(saved.size.x, saved.size.y, false);
            renderer.setRenderTarget(null);
            camera3D.position.copy(saved.camPos); camera3D.fov = saved.camFov; camera3D.aspect = saved.camAspect;
            camera3D.updateProjectionMatrix();
            if (controls && saved.camTarget) { controls.target.copy(saved.camTarget); controls.update(); }
            scene3D.background = saved.bg;
            if (skyMesh) skyMesh.visible = saved.sky;
            if (avatarMesh) avatarMesh.visible = saved.avatar;
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
            'sessionId',
            'caseId',
            'resolution',
            'width', 'height', 'quality_width', 'quality_height',
            'preset',
            'materialMode',
            'method',
            'timerType',
            'lod_estimator', 'base_filter', 'sampling_lod_estimator',
            'n_requested', 'n_valid', 'n_discarded',
            'mean_ms',
            'std_ms',
            'median_ms',
            'p95_ms',
            'q1_ms', 'q3_ms', 'iqr_ms',
            'speedup_vs_ref_pct',
            'fetches_px',
            'logical_sample_reduction_pct',
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
            baseFilter: params.baseFilter,
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
            params.baseFilter = saved.baseFilter;
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
