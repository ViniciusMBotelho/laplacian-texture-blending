/** Verify the frozen records and manuscript table without recollecting GPU data. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { validateReport } from '../../demo_webgl/benchmark_protocol.js';

const paper=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.join(paper,'validation/v2');
const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const reports=new Map();
let queries=0,valid=0,discarded=0;
for(const record of manifest.records){
    const file=path.join(directory,record.file);
    assert.equal(hash(file),record.report_sha256,`Report hash: ${record.file}`);
    const report=JSON.parse(fs.readFileSync(file,'utf8'));
    validateReport(report);
    assert.equal(report.config.sampleFrames,3);
    assert.equal(report.config.warmupFrames,1);
    assert.equal(report.results.length,18);
    assert.equal(report.softwareRenderer,false);
    for(const row of report.results){
        assert.ok(Number.isFinite(row.ssim_gpu));
        assert.ok(row.ssim_valid_centers>0);
        assert.equal(row.n_valid,3);assert.equal(row.n_discarded,0);
    }
    queries+=report.rawQueries.length;
    valid+=report.results.reduce((sum,row)=>sum+row.n_valid,0);
    discarded+=report.results.reduce((sum,row)=>sum+row.n_discarded,0);
    reports.set(record.id,report);
}
assert.equal(queries,288);assert.equal(valid,216);assert.equal(discarded,0);
assert.equal(manifest.total_queries,queries);
assert.equal(manifest.total_valid_measure_queries,valid);
assert.notEqual(reports.get('integration_001').browserProcessId,reports.get('integration_002').browserProcessId);

for(const [file,expected] of Object.entries(manifest.generated_assets_sha256))
    assert.equal(hash(path.join(paper,file)),expected,`Generated asset hash: ${file}`);
const table=fs.readFileSync(path.join(paper,'tables/validacao_v2.tex'),'utf8');
const labels={linear:'Linear',nvidia_n6:'Completo 6',nvidia_n3:'Truncado 3',skip_pure:'Salto par',skip_hybrid:'Híbrido',
    adap_iso:'Adaptativo iso./grad',adap_aniso:'Adaptativo aniso./grad',adap_iso_lod:'Adaptativo iso./lod',adap_aniso_lod:'Adaptativo aniso./lod'};
const fmt=(v,n)=>v==='Infinity'?'$\\infty$':Number(v).toFixed(n).replace('.',',');
for(const [method,label] of Object.entries(labels)){
    const rows=['1080p','4K'].map(res=>reports.get('resolution_001').results.find(r=>r.resolution===res && r.methodId===method));
    const expected=label+' & '+rows.flatMap(r=>[fmt(r.psnr_3d_db,2),fmt(r.ssim_gpu,6)]).join(' & ');
    assert.ok(table.includes(expected),`Manuscript table mismatch: ${method}`);
}
const control=reports.get('control_001');
assert.equal(control.config.nearLimit,2);assert.equal(control.config.farLimit,3);
for(const row of control.results.filter(r=>['adap_iso','adap_aniso'].includes(r.methodId))){
    assert.equal(row.psnr_3d_db,'Infinity');assert.equal(row.ssim_gpu,1);
}
const controlHashes=manifest.records.find(r=>r.id==='control_001').png_sha256;
for(const row of control.results.filter(r=>r.methodId==='adap_iso_lod')){
    const other=control.results.find(r=>r.caseId===row.caseId && r.methodId==='adap_aniso_lod');
    assert.equal(controlHashes[row.quality_frame],controlHashes[other.quality_frame]);
}
console.log(`Verified: ${reports.size} records, ${queries} queries, ${valid} valid measurement queries; table, assets and negative control agree.`);
console.log('Raw PNG hashes identify preserved local captures; PNG files are not included in this lightweight package.');
