import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BENCHMARK_METHODS, applyBenchmarkMethod, benchmarkCases, summarize, timingSummary, validateReport } from '../demo_webgl/benchmark_protocol.js';
import { aggregateSessions, csv, parseArgs, resolveStaticPath } from '../src/benchmark_driver_lib.mjs';
import { report } from './fixtures.js';
import path from 'node:path';
import { BenchmarkRunner } from '../demo_webgl/benchmark.js';

test('ablação 2x2 mantém o filtro constante ao comparar estimadores', () => {
    const cells = BENCHMARK_METHODS.filter(m => m.mode === 5);
    assert.equal(cells.length, 4);
    assert.deepEqual(new Set(cells.map(m => `${m.anisotropicLod}/${m.baseFilter}`)), new Set(['0/grad','1/grad','0/lod','1/lod']));
    for (const filter of ['grad','lod']) assert.equal(cells.filter(m => m.baseFilter === filter).length,2);
});
test('uniformes de seleção e filtragem são controlados separadamente', () => {
    const p={},u={mode:{value:0},anisotropicLod:{value:0},baseFilter:{value:0}};
    applyBenchmarkMethod(p,u,BENCHMARK_METHODS.find(m => m.id === 'adap_iso'));
    assert.equal(u.anisotropicLod.value,0); assert.equal(u.baseFilter.value,1);
    applyBenchmarkMethod(p,u,BENCHMARK_METHODS.find(m => m.id === 'adap_aniso_lod'));
    assert.equal(u.anisotropicLod.value,1); assert.equal(u.baseFilter.value,0);
});
test('matriz completa contém 1080p e 4K; smoke cobre duas resoluções diferentes', () => {
    const full=benchmarkCases({full:true}); assert.equal(full.length,8);
    assert.equal(full.filter(c => c.width===3840 && c.height===2160).length,2);
    assert.deepEqual(benchmarkCases({smoke:true}).map(c=>[c.width,c.height]),[[320,180],[640,360]]);
});
test('estatísticas conhecidas e IQR preservam amostras originais', () => {
    const values=[4,1,3,2],stats=summarize(values);
    assert.equal(stats.mean,2.5);assert.equal(stats.median,2.5);assert.equal(stats.iqr,1.5);assert.equal(stats.n,4);
    assert.deepEqual(values,[4,1,3,2]); assert.equal(summarize([]).mean,null);
    assert.throws(()=>summarize([NaN]));assert.throws(()=>summarize([-1]));
});
test('warmup e descarte não entram na média', () => {
    const records=[{methodId:'m',phase:'warmup',status:'warmup_valid',elapsedMs:999},
        {methodId:'m',phase:'measure',status:'valid',elapsedMs:2},
        {methodId:'m',phase:'measure',status:'timeout',elapsedMs:null}];
    const stats=timingSummary(records,'m');assert.equal(stats.mean,2);assert.equal(stats.requested,2);
    assert.equal(stats.n,1);assert.equal(stats.discardedByReason.timeout,1);
});
test('relatório consistente passa e resolução misturada é rejeitada', () => {
    const r=report();assert.equal(validateReport(r),true);r.results[0].quality_width=960;
    assert.throws(()=>validateReport(r),/resolution mismatch/);
});
test('não é permitido perder uma consulta entre os dados brutos e agregados', () => {
    const r=report();r.rawQueries.pop();assert.throws(()=>validateReport(r),/count mismatch/);
});
test('metadados incorretos de filtro invalidam a ablação', () => {
    const r=report();r.results.find(r=>r.methodId==='adap_iso').base_filter='lod';
    assert.throws(()=>validateReport(r),/Ablation/);
});
test('dados legados não são rotulados como protocolo novo', () => {
    const r=report();r.schemaVersion=1;assert.throws(()=>validateReport(r),/schema v2/);
});
test('matriz incompleta, consulta pendente e contagem de protocolo incorreta são rejeitadas', () => {
    const a=report();a.results.pop();assert.throws(()=>validateReport(a),/matrix/);
    const b=report();b.rawQueries[0].status='pending';assert.throws(()=>validateReport(b),/query status/);
    const c=report();c.config.sampleFrames=3;assert.throws(()=>validateReport(c),/protocol/);
});
test('sessões independentes são resumidas por sessão, sem pooling de consultas', () => {
    const summary=aggregateSessions([report('s1'),report('s2',10)]);
    assert.equal(summary.n_sessions,2);assert.deepEqual(summary.results[0].session_medians_ms,[3,13]);
    assert.equal(summary.results[0].median_of_session_medians_ms,8);
    assert.equal(summary.results[0].iqr_of_session_medians_ms,5);
    assert.throws(()=>aggregateSessions([report('s1'),report('s1')]),/Duplicate/);
});
test('sessões com protocolos ou hardware diferentes não são misturadas', () => {
    const a=report('a'),b=report('b');b.hardware.unmaskedRenderer='other';
    assert.throws(()=>aggregateSessions([a,b]),/hardware/);
    b.hardware=a.hardware;b.config.sampleFrames=100;
    assert.throws(()=>aggregateSessions([a,b]),/protocol/);
});
test('CSV preserva identificação de rodada e escapa campos', () => {
    const result=csv([{sessionId:'s1',round:2,note:'a,"b"',elapsedMs:1.23456789}]);
    assert.match(result,/sessionId,round,note,elapsedMs/);assert.match(result,/"a,""b"""/);assert.match(result,/1.23456789/);
});
test('CSV da interface também exporta resolução, filtro e contagem de consultas do protocolo novo', () => {
    const runner=new BenchmarkRunner({});runner.lastReport=report();
    const header=runner.exportCSV().split('\n')[0];
    for(const field of ['n_valid','n_discarded','quality_width','base_filter','sampling_lod_estimator','iqr_ms'])assert.ok(header.split(',').includes(field));
    assert.ok(!header.includes('tmu_reduction_pct'));
});
test('CLI rejeita parâmetros inválidos e não aceita opções desconhecidas', () => {
    assert.equal(parseArgs(['--sessions','2','--smoke']).sessions,2);
    for(const args of [['--sessions','0'],['--sessions','1.5'],['--outdir'],['--unknown']]) assert.throws(()=>parseArgs(args));
});
test('servidor local não permite leitura fora da raiz', () => {
    const root=path.resolve('root');assert.equal(resolveStaticPath(root,'/demo_webgl/'),path.join(root,'demo_webgl/index.html'));
    assert.throws(()=>resolveStaticPath(root,'/../private.txt'));assert.throws(()=>resolveStaticPath(root,'/%2e%2e/private.txt'));
});
