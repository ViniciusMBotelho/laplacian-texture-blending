import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Python: PSNR/SSIM conhecidos, máscara e suporte completo da janela', () => {
    const python=process.env.PYTHON || (process.platform==='win32'?'python':'python3');
    const result=spawnSync(python,[fileURLToPath(new URL('./test_validation_metrics.py',import.meta.url))],
        {encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,`${result.error || ''}\n${result.stdout}\n${result.stderr}\nConfigure PYTHON and install requirements-validation.txt.`);
});
