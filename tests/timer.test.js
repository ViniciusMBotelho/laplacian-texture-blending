import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryLedger, measureGpuCaseInterleaved } from '../demo_webgl/gpu_timer.js';
import { BENCHMARK_METHODS, timingSummary } from '../demo_webgl/benchmark_protocol.js';
import { fakeGpu } from './fixtures.js';

test('consulta válida preserva ns e ms, disponibilidade e rodada', () => {
    const {gl,ext,deleted}=fakeGpu(),ledger=new QueryLedger(gl,ext),q=gl.createQuery();q.ns=2e6;
    ledger.add(q,{methodId:'m',phase:'measure',round:7,orderIndex:2});ledger.poll();
    assert.equal(ledger.records[0].elapsedMs,2);assert.equal(ledger.records[0].durationNs,2e6);
    assert.equal(ledger.records[0].round,7);assert.equal(ledger.records[0].available,true);assert.deepEqual(deleted,[q.id]);
});
test('disjoint invalida inclusive consultas ainda indisponíveis e não ressuscita', () => {
    const {gl,ext,deleted}=fakeGpu(),ledger=new QueryLedger(gl,ext);
    const a=gl.createQuery(),b=gl.createQuery();b.available=false;
    for(const q of [a,b])ledger.add(q,{methodId:'m',phase:'measure'});
    gl.disjoint=true;ledger.poll();gl.disjoint=false;b.available=true;ledger.poll();
    assert.deepEqual(ledger.records.map(r=>r.status),['disjoint','disjoint']);
    assert.equal(ledger.pending.length,0);assert.equal(deleted.length,2);assert.equal(timingSummary(ledger.records,'m').n,0);
});
test('timeout gera descarte explícito e libera consultas', () => {
    const {gl,ext,deleted}=fakeGpu(),ledger=new QueryLedger(gl,ext),q=gl.createQuery();q.available=false;
    ledger.add(q,{methodId:'m',phase:'measure'});ledger.poll();ledger.timeout();
    assert.equal(ledger.records[0].status,'timeout');assert.equal(deleted.length,1);
});
test('tempos negativos, não finitos ou zero são rejeitados', () => {
    const {gl,ext}=fakeGpu(),ledger=new QueryLedger(gl,ext);
    for(const ns of [-1,NaN,Infinity,0]){const q=gl.createQuery();q.ns=ns;ledger.add(q,{phase:'measure'});}
    ledger.poll();assert.ok(ledger.records.every(r=>r.status==='invalid_result'));
});
test('runner real exporta cada rodada intercalada e separa warmup', async () => {
    const {gl}=fakeGpu();const targets=[];
    const renderer={getContext:()=>gl,setRenderTarget:t=>targets.push(t),render:()=>{}};
    const uniforms={mode:{value:0},anisotropicLod:{value:0},baseFilter:{value:0}};
    const result=await measureGpuCaseInterleaved(renderer,{}, {},{uniforms},{},{},BENCHMARK_METHODS,1,2,null,
        {warmupDraws:0,nextFrame:async()=>{},now:()=>0});
    assert.equal(result.records.length,27);assert.equal(result.records.filter(r=>r.status==='valid').length,18);
    assert.equal(result.records[0].methodId,'linear');assert.equal(result.records[9].methodId,'adap_aniso_lod');
    assert.equal(targets.at(-1),null);
    for(const method of BENCHMARK_METHODS)assert.equal(timingSummary(result.records,method.id).n,2);
});
test('runner exige timer de GPU e nunca substitui por cronômetro CPU', async () => {
    await assert.rejects(measureGpuCaseInterleaved({getContext:()=>({getExtension:()=>null})}, {}, {}, {}, {}, {}, [],0,1),/no CPU fallback/);
});
