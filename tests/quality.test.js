import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTerrainPsnr } from '../demo_webgl/quality.js';

test('PSNR ignora céu e calcula erro RGB somente no terreno', () => {
    const ref=new Uint8Array([0,0,0,255,0,0,0,0]),cand=new Uint8Array([255,255,255,255,255,0,0,0]);
    assert.equal(computeTerrainPsnr(cand,ref),0);
    cand.set([0,0,0],0);assert.equal(computeTerrainPsnr(cand,ref),Infinity);
});
test('PSNR rejeita máscaras diferentes, dimensões inválidas e terreno vazio', () => {
    assert.throws(()=>computeTerrainPsnr(new Uint8Array(4),new Uint8Array(8)),/shape/);
    assert.throws(()=>computeTerrainPsnr(new Uint8Array([0,0,0,0]),new Uint8Array([0,0,0,255])),/masks/);
    assert.throws(()=>computeTerrainPsnr(new Uint8Array(4),new Uint8Array(4)),/No valid/);
});
