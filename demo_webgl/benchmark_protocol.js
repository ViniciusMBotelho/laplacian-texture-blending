/** Shared protocol, independent of rendering; used by production and tests. */
export const SCHEMA_VERSION = 2;
export const BENCHMARK_METHODS = [
    { id: 'linear', label: 'Linear', mode: 0, anisotropicLod: 1, baseFilter: 'grad' },
    { id: 'nvidia_n6', label: 'Completo N=6', mode: 1, anisotropicLod: 1, baseFilter: 'grad' },
    { id: 'nvidia_n3', label: 'Truncado N=3', mode: 4, anisotropicLod: 1, baseFilter: 'grad' },
    { id: 'skip_pure', label: 'Salto par', mode: 2, anisotropicLod: 1, baseFilter: 'grad' },
    { id: 'skip_hybrid', label: 'Hibrido', mode: 3, anisotropicLod: 1, baseFilter: 'grad' },
    // Factorial ablation: selection and base filtering are independent.
    { id: 'adap_iso', label: 'Adaptativo iso / grad', mode: 5, anisotropicLod: 0, baseFilter: 'grad' },
    { id: 'adap_aniso', label: 'Adaptativo aniso / grad', mode: 5, anisotropicLod: 1, baseFilter: 'grad' },
    { id: 'adap_iso_lod', label: 'Adaptativo iso / lod', mode: 5, anisotropicLod: 0, baseFilter: 'lod' },
    { id: 'adap_aniso_lod', label: 'Adaptativo aniso / lod', mode: 5, anisotropicLod: 1, baseFilter: 'lod' },
];

export function applyBenchmarkMethod(params, uniforms, method) {
    params.mode = method.mode;
    params.anisotropicLod = Boolean(method.anisotropicLod);
    params.baseFilter = method.baseFilter;
    uniforms.mode.value = method.mode;
    uniforms.anisotropicLod.value = method.anisotropicLod;
    uniforms.baseFilter.value = method.baseFilter === 'grad' ? 1 : 0;
}

export function benchmarkCases({ full = false, smoke = false, resolutionCheck = false } = {}) {
    if (resolutionCheck) return [
        { resolution: '1080p', width: 1920, height: 1080, preset: 'overview', materialMode: 'pbr2' },
        { resolution: '4K', width: 3840, height: 2160, preset: 'grazing', materialMode: 'pbr2' },
    ];
    if (smoke) return [
        { resolution: '320x180', width: 320, height: 180, preset: 'overview', materialMode: 'pbr2' },
        { resolution: '640x360', width: 640, height: 360, preset: 'grazing', materialMode: 'pbr2' },
    ];
    const result = [];
    const add = (resolution, width, height, presets, materials) => {
        for (const preset of presets) for (const materialMode of materials)
            result.push({ resolution, width, height, preset, materialMode });
    };
    add('1080p', 1920, 1080, full ? ['overview', 'grazing', 'closeup', 'aerial'] : ['overview', 'grazing'], ['pbr2']);
    if (full) {
        add('1080p', 1920, 1080, ['overview'], ['albedo', 'pbr3']);
        add('4K', 3840, 2160, ['overview', 'grazing'], ['pbr2']);
    }
    return result;
}

export function summarize(values) {
    if (values.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid timing sample');
    if (!values.length) return { mean: null, std: null, median: null, p95: null, q1: null, q3: null, iqr: null, n: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const quantile = p => {
        const index = (sorted.length - 1) * p;
        const low = Math.floor(index), high = Math.ceil(index);
        return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
    };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return { mean, std: Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length),
        median: quantile(.5), p95: quantile(.95), q1: quantile(.25), q3: quantile(.75),
        iqr: quantile(.75) - quantile(.25), min: sorted[0], max: sorted.at(-1), n: values.length };
}

export function timingSummary(records, methodId) {
    const measured = records.filter(r => r.methodId === methodId && r.phase === 'measure');
    const valid = measured.filter(r => r.status === 'valid');
    return { ...summarize(valid.map(r => r.elapsedMs)), requested: measured.length,
        discarded: measured.length - valid.length,
        discardedByReason: Object.fromEntries(['disjoint', 'timeout', 'invalid_result'].map(reason =>
            [reason, measured.filter(r => r.status === reason).length])) };
}

export function validateReport(report) {
    if (report.schemaVersion !== SCHEMA_VERSION) throw new Error('Expected benchmark schema v2');
    if (!report.results?.length || !report.rawQueries?.length) throw new Error('Empty benchmark');
    const expectedIds = BENCHMARK_METHODS.map(m => m.id).sort();
    for (const caseId of new Set(report.results.map(r => r.caseId))) {
        const ids = report.results.filter(r => r.caseId === caseId).map(r => r.methodId).sort();
        if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) throw new Error('Incomplete or duplicate method matrix');
    }
    for (const query of report.rawQueries) {
        if (!['valid', 'warmup_valid', 'disjoint', 'timeout', 'invalid_result'].includes(query.status))
            throw new Error('Unresolved or unknown query status');
        if (query.status === 'valid' && (!Number.isFinite(query.elapsedMs) || query.elapsedMs <= 0 || query.disjoint))
            throw new Error('Invalid query marked valid');
        if (!report.results.some(r => r.caseId === query.caseId && r.methodId === query.methodId))
            throw new Error('Orphan query');
    }
    for (const row of report.results) {
        if (row.quality_width !== row.width || row.quality_height !== row.height)
            throw new Error('Quality/timing resolution mismatch');
        if (!row.quality_frame || row.quality_reference !== 'nvidia_n6') throw new Error('Missing quality provenance');
        const raw = report.rawQueries.filter(r => r.caseId === row.caseId);
        const stats = timingSummary(raw, row.methodId);
        if (row.n_valid !== stats.n || row.n_discarded !== stats.discarded || row.n_requested !== stats.requested)
            throw new Error('Raw/aggregate count mismatch');
        if (row.n_valid + row.n_discarded !== row.n_requested) throw new Error('Unaccounted queries');
        if (report.config.sampleFrames !== row.n_requested) throw new Error('Requested query count differs from protocol');
        if (row.mean_ms !== stats.mean || row.median_ms !== stats.median) throw new Error('Raw/aggregate timing mismatch');
        if (row.n_valid === 0) throw new Error(`No valid GPU timings: ${row.caseId}/${row.methodId}`);
        const expected = BENCHMARK_METHODS.find(m => m.id === row.methodId);
        if (!expected || row.base_filter !== expected.baseFilter || row.lod_estimator !== (expected.anisotropicLod ? 'aniso' : 'iso'))
            throw new Error('Ablation metadata mismatch');
        if (row.sampling_lod_estimator !== 'aniso_fixed') throw new Error('Sampling LOD is not controlled');
    }
    return true;
}
