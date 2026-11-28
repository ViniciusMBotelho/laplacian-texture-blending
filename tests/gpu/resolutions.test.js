import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runValidation } from '../../src/run_validation.mjs';
import { validateReport } from '../../demo_webgl/benchmark_protocol.js';

test('1080p e 4K reais: resolução de PNG, PSNR, SSIM e temporização coincide', {timeout:600000}, async () => {
    const run=await runValidation(['--smoke','--resolution-check','--sessions','1','--outdir','output/validation/resolution-check']);
    const report=JSON.parse(fs.readFileSync(path.join(run.outputRoot,'session-001/resultados_gpu.json'),'utf8'));
    validateReport(report);
    assert.deepEqual([...new Set(report.results.map(r=>`${r.width}x${r.height}`))],['1920x1080','3840x2160']);
    for(const row of report.results) {
        assert.equal(row.quality_width,row.width);assert.equal(row.quality_height,row.height);
        assert.equal(row.sampling_lod_estimator,'aniso_fixed');assert.ok(Number.isFinite(row.ssim_gpu));
    }
    assert.equal(report.results.length,18);assert.equal(report.functionalTestOnly,true);
});
