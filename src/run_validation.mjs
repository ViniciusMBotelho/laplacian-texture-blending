import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { main } from './validation_driver.mjs';

export async function runValidation(argv) {
    const run = await main(argv);
    const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    await new Promise((resolve, reject) => {
        const child = spawn(python, [fileURLToPath(new URL('./validation_metrics.py', import.meta.url)), '--analyze', run.outputRoot],
            { stdio: 'inherit', windowsHide: true });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Quality analysis failed (${code}). Install requirements-validation.txt; raw sessions preserved at ${run.outputRoot}`)));
    });
    return run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
    runValidation(process.argv.slice(2)).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
