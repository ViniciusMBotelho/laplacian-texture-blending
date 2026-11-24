import { applyBenchmarkMethod } from './benchmark_protocol.js';

/** Lossless query ledger. Disjoint invalidates ALL pending queries, even unavailable ones. */
export class QueryLedger {
    constructor(gl, ext) { this.gl = gl; this.ext = ext; this.pending = []; this.records = []; }
    add(query, metadata) {
        const record = { ...metadata, status: 'pending', elapsedMs: null, durationNs: null,
            disjoint: false, available: false };
        this.records.push(record); this.pending.push({ query, record });
    }
    poll() {
        const { gl, ext } = this;
        const disjoint = Boolean(gl.getParameter(ext.GPU_DISJOINT_EXT));
        const remaining = [];
        for (const item of this.pending) {
            const { query, record } = item;
            const available = Boolean(gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE));
            record.available = available;
            if (disjoint) { record.status = 'disjoint'; record.disjoint = true; }
            else if (!available) { remaining.push(item); continue; }
            else {
                const ns = gl.getQueryParameter(query, gl.QUERY_RESULT);
                if (!Number.isFinite(ns) || ns <= 0) record.status = 'invalid_result';
                else { record.durationNs = ns; record.elapsedMs = ns / 1e6; record.status = record.phase === 'warmup' ? 'warmup_valid' : 'valid'; }
            }
            gl.deleteQuery(query);
        }
        this.pending = remaining;
    }
    timeout() {
        for (const { query, record } of this.pending) {
            record.status = 'timeout'; this.gl.deleteQuery(query);
        }
        this.pending = [];
    }
}

export async function measureGpuCaseInterleaved(renderer, scene, camera, material, params, target,
    methods, warmupRounds, sampleRounds, onProgress = null, options = {}) {
    const gl = renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) throw new Error('EXT_disjoint_timer_query_webgl2 unavailable: GPU timing required (no CPU fallback).');
    const nextFrame = options.nextFrame || (() => new Promise(resolve => requestAnimationFrame(resolve)));
    const now = options.now || (() => performance.now());
    const ledger = new QueryLedger(gl, ext);
    const warmupDraws = options.warmupDraws ?? 60;
    const deadlineMs = options.deadlineMs ?? 10000;
    applyBenchmarkMethod(params, material.uniforms, methods.find(m => m.id === 'nvidia_n6') || methods[0]);
    try {
        for (let i = 0; i < warmupDraws; i++) {
            renderer.setRenderTarget(target); renderer.render(scene, camera);
            if (i % 3 === 2) await nextFrame();
        }
        for (let round = 0; round < warmupRounds + sampleRounds; round++) {
            ledger.poll();
            const order = round % 2 === 0 ? methods : [...methods].reverse();
            for (const [orderIndex, method] of order.entries()) {
                applyBenchmarkMethod(params, material.uniforms, method);
                renderer.setRenderTarget(target);
                const query = gl.createQuery();
                if (!query) throw new Error('Unable to allocate GPU query');
                try {
                    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
                    try { renderer.render(scene, camera); }
                    finally { gl.endQuery(ext.TIME_ELAPSED_EXT); }
                } catch (error) { gl.deleteQuery(query); throw error; }
                ledger.add(query, { round, orderIndex, methodId: method.id,
                    phase: round < warmupRounds ? 'warmup' : 'measure', submittedAtMs: now() });
            }
            ledger.poll();
            onProgress?.(round + 1, warmupRounds + sampleRounds);
            await nextFrame();
        }
        const deadline = now() + deadlineMs;
        while (ledger.pending.length && now() < deadline) { ledger.poll(); if (ledger.pending.length) await nextFrame(); }
        ledger.timeout();
        return { timerType: 'gpu_timer_query', records: ledger.records };
    } finally { ledger.timeout(); renderer.setRenderTarget(null); }
}
