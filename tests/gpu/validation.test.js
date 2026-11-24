import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runValidation } from '../../src/run_validation.mjs';
import { validateReport } from '../../demo_webgl/benchmark_protocol.js';

test('WebGL real: duas resoluções, duas sessões, ablação 2x2 e dados brutos auditáveis', {timeout:300000}, async () => {
    const run=await runValidation(['--smoke','--sessions','2','--allow-software','--outdir','output/validation/integration']);
    assert.equal(run.reports.length,2);
    assert.notEqual(run.reports[0].browserProcessId,run.reports[1].browserProcessId);
    for(const session of run.reports){
        const dir=path.join(run.outputRoot,session.sessionId);
        const report=JSON.parse(fs.readFileSync(path.join(dir,'resultados_gpu.json'),'utf8'));
        validateReport(report);assert.equal(report.results.length,18);
        assert.equal(report.config.ablation,'lod_estimator x base_filter');
        for(const row of report.results){
            assert.equal(row.quality_width,row.width);assert.equal(row.quality_height,row.height);
            assert.equal(row.n_valid+row.n_discarded,3);assert.ok(row.n_valid>0);
            assert.ok(row.ssim_valid_centers>0);assert.ok(Number.isFinite(row.ssim_gpu));
            assert.equal(row.timerType,'gpu_timer_query');
            if(row.methodId==='nvidia_n6'){assert.equal(row.psnr_3d_db,'Infinity');assert.equal(row.ssim_gpu,1);}
        }
        assert.ok(fs.statSync(path.join(dir,'raw_queries.csv')).size>100);
        assert.equal(fs.readdirSync(dir).filter(n=>n.startsWith('.browser-profile-')).length,0);
    }
});

test('controle negativo GPU: estimador não altera filtragem quando o regime é fixado em completo', {timeout:180000}, async () => {
    const run=await runValidation(['--smoke','--sessions','1','--allow-software','--full-regime-control','--outdir','output/validation/control']);
    const dir=path.join(run.outputRoot,'session-001');
    const report=JSON.parse(fs.readFileSync(path.join(dir,'resultados_gpu.json'),'utf8'));
    for(const caseId of new Set(report.results.map(r=>r.caseId))){
        const row=id=>report.results.find(r=>r.caseId===caseId && r.methodId===id);
        for(const id of ['adap_iso','adap_aniso']) {
            assert.equal(row(id).psnr_3d_db,'Infinity');assert.equal(row(id).ssim_gpu,1);
        }
        assert.deepEqual(fs.readFileSync(path.join(dir,row('adap_iso_lod').quality_frame)),
            fs.readFileSync(path.join(dir,row('adap_aniso_lod').quality_frame)));
    }
});
