import { BENCHMARK_METHODS, timingSummary } from '../demo_webgl/benchmark_protocol.js';

export function report(sessionId = 'session-001', offset = 0) {
    const caseId = '320x180_overview_pbr2';
    const rawQueries = BENCHMARK_METHODS.flatMap(method => [2, 4].map((ms, round) => ({
        sessionId, caseId, methodId: method.id, phase: 'measure', round, orderIndex: 0,
        elapsedMs: ms + offset, durationNs: (ms + offset)*1e6, status: 'valid', available: true, disjoint: false,
    })));
    return { schemaVersion: 2, sessionId, config: { sampleFrames: 2 },
        hardware: { unmaskedRenderer: 'test GPU' }, rawQueries,
        results: BENCHMARK_METHODS.map(method => {
            const stats = timingSummary(rawQueries, method.id);
            return { caseId, sessionId, methodId: method.id, width: 320, height: 180,
                quality_width: 320, quality_height: 180, quality_frame: `frames/${method.id}.png`, quality_reference: 'nvidia_n6',
                lod_estimator: method.anisotropicLod ? 'aniso' : 'iso', base_filter: method.baseFilter,
                sampling_lod_estimator: 'aniso_fixed',
                n_requested: stats.requested, n_valid: stats.n, n_discarded: stats.discarded,
                mean_ms: stats.mean, median_ms: stats.median };
        }) };
}

export function fakeGpu() {
    let id = 0;
    const deleted = [], ext = { GPU_DISJOINT_EXT: 1, TIME_ELAPSED_EXT: 2 };
    const gl = { QUERY_RESULT_AVAILABLE: 3, QUERY_RESULT: 4, disjoint: false,
        getExtension: () => ext, getParameter: () => gl.disjoint,
        getQueryParameter: (q, kind) => kind === 3 ? q.available : q.ns,
        deleteQuery: q => { deleted.push(q.id); }, createQuery: () => ({ id: ++id, available: true, ns: 1e6 + id*100 }),
        beginQuery: () => {}, endQuery: () => {} };
    return { gl, ext, deleted };
}
