#!/usr/bin/env node
/**
 * Automated WebGL 2.0 GPU Benchmark Driver
 * Launches a local static HTTP server + headless Chromium with hardware WebGL 2.0,
 * executes BenchmarkRunner (EXT_disjoint_timer_query_webgl2), and saves raw GPU
 * results (JSON/CSV) plus GPU-rendered comparison frames (PNG).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
};

function parseArgs(argv) {
    let outdir = 'output/benchmark_gpu';
    let quick = false;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--outdir' && argv[i + 1]) {
            outdir = argv[++i];
        } else if (argv[i] === '--quick') {
            quick = true;
        }
    }
    return { outdir, quick };
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function startStaticServer(rootDir) {
    const absRoot = path.resolve(rootDir);
    const server = http.createServer((req, res) => {
        const cleanUrl = decodeURIComponent((req.url || '/').split('?')[0]);
        let rel = cleanUrl === '/' ? '/index.html' : cleanUrl;
        if (rel.endsWith('/')) rel += 'index.html';
        const filePath = path.resolve(absRoot, '.' + rel);

        if (!filePath.startsWith(absRoot)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }
            const ext = path.extname(filePath).toLowerCase();
            res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
            res.end(data);
        });
    });

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            resolve({ server, port: addr.port });
        });
    });
}

async function waitForDevToolsPort(userDataDir, timeoutMs = 15000) {
    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(portFile)) {
            const txt = fs.readFileSync(portFile, 'utf8').trim();
            const port = Number(txt.split(/\r?\n/)[0]);
            if (Number.isFinite(port) && port > 0) return port;
        }
        await sleep(100);
    }
    throw new Error('Timeout waiting for Chromium DevToolsActivePort');
}

async function waitForPageTarget(cdpPort, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
            if (res.ok) {
                const targets = await res.json();
                const page = targets.find((t) => t.type === 'page');
                if (page) return page;
            }
        } catch {}
        await sleep(120);
    }
    throw new Error('Timeout waiting for CDP page target');
}

class CDPClient {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.nextId = 1;
        this.pending = new Map();
        this.events = [];
    }

    async connect() {
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        });
        this.ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id) {
                const p = this.pending.get(msg.id);
                if (p) {
                    this.pending.delete(msg.id);
                    if (msg.error) p.reject(new Error(msg.error.message));
                    else p.resolve(msg.result);
                }
            } else {
                this.events.push(msg);
            }
        });
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async eval(expression, awaitPromise = true) {
        const res = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise,
            returnByValue: true,
        });
        if (res.exceptionDetails) {
            throw new Error(
                res.exceptionDetails.exception?.description ||
                    res.exceptionDetails.text ||
                    'Runtime exception in browser'
            );
        }
        return res.result ? res.result.value : undefined;
    }

    close() {
        this.ws.close();
    }
}

function saveDataUrlPng(dataUrl, destPath) {
    const prefix = 'data:image/png;base64,';
    if (!dataUrl || !dataUrl.startsWith(prefix)) {
        throw new Error(`Invalid PNG dataURL for ${destPath}`);
    }
    const buf = Buffer.from(dataUrl.slice(prefix.length), 'base64');
    fs.writeFileSync(destPath, buf);
}

function toCSV(results) {
    const cols = [
        'resolution',
        'preset',
        'materialMode',
        'method',
        'timerType',
        'mean_ms',
        'std_ms',
        'median_ms',
        'p95_ms',
        'speedup_vs_ref_pct',
        'fetches_px',
        'tmu_reduction_pct',
        'psnr_3d_db',
        'pct_near',
        'pct_mid',
        'pct_far',
        'pct_trans',
        'mean_lod',
    ];
    const lines = [cols.join(',')];
    for (const r of results) {
        const vals = cols.map((c) => {
            const v = r[c];
            if (v === null || v === undefined) return '';
            if (v === 'Infinity' || v === Infinity) return 'inf';
            if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
            return `"${String(v).replace(/"/g, '""')}"`;
        });
        lines.push(vals.join(','));
    }
    return lines.join('\n');
}

async function main() {
    const { outdir, quick } = parseArgs(process.argv.slice(2));
    const framesDir = path.join(outdir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });

    const { server, port } = await startStaticServer(process.cwd());
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-bench-cdp-'));

    const chrome = spawn(
        '/usr/bin/chromium',
        [
            '--headless=new',
            '--remote-debugging-port=0',
            `--user-data-dir=${userDataDir}`,
            '--window-size=1280,720',
            '--no-sandbox',
            '--enable-webgl',
            '--ignore-gpu-blocklist',
            '--use-gl=angle',
            '--use-angle=gl',
            `http://127.0.0.1:${port}/demo_webgl/`,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    let chromeStderr = '';
    chrome.stderr.on('data', (d) => {
        chromeStderr += d.toString();
    });

    try {
        const cdpPort = await waitForDevToolsPort(userDataDir, 15000);
        const pageTarget = await waitForPageTarget(cdpPort, 15000);
        const cdp = new CDPClient(pageTarget.webSocketDebuggerUrl);
        await cdp.connect();
        await cdp.send('Runtime.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 1280,
            height: 720,
            deviceScaleFactor: 1,
            mobile: false,
        });

        let ready = false;
        for (let i = 0; i < 60; i++) {
            ready = await cdp.eval(
                `Boolean(window.__BENCHMARK_API__ && window.__BENCHMARK_API__.getTelemetry()?.fetchesPx > 0)`,
                false
            );
            if (ready) break;
            await sleep(250);
        }
        if (!ready) {
            throw new Error(`WebGL scene failed to initialize. Chrome stderr:\n${chromeStderr}`);
        }

        // Wait briefly so the GPU timer EMA populates on screen
        await sleep(500);
        const hudCheck = await cdp.eval(`(() => ({
            hasCpuFrameLine: Boolean(document.getElementById('hud-frame')),
            gpuTimerText: document.getElementById('hud-gpu')?.textContent,
            gpuInfoText: document.getElementById('hud-gpu-info')?.textContent,
            fetchesText: document.getElementById('hud-fetches')?.textContent,
        }))()`, false);
        console.log('[GPU Driver] HUD Check:', JSON.stringify(hudCheck));

        console.log(`[GPU Driver] Executando suite ${quick ? 'rapida (1080p)' : 'completa (1080p + 4K)'} na GPU...`);
        const reportJsonText = await cdp.eval(
            `(async () => {
                const report = await window.__BENCHMARK_API__.${quick ? 'runQuick()' : 'runFull()'};
                return JSON.stringify(report, (_k, v) => (v === Infinity ? 'Infinity' : v), 2);
            })()`,
            true
        );

        const report = JSON.parse(reportJsonText);
        console.log(
            `[GPU Driver] Hardware: ${report.hardware.unmaskedRenderer || report.hardware.renderer} | ` +
                `TimerQuery: ${report.hardware.hasGpuTimerQuery} | Medicoes: ${report.results.length}`
        );

        const jsonPath = path.join(outdir, 'resultados_gpu.json');
        const csvPath = path.join(outdir, 'resultados_gpu.csv');
        fs.writeFileSync(jsonPath, reportJsonText, 'utf8');
        fs.writeFileSync(csvPath, toCSV(report.results), 'utf8');

        // Capture GPU-rendered comparison frames for overview and grazing
        for (const preset of ['overview', 'grazing']) {
            console.log(`[GPU Driver] Capturando frames GPU (${preset}, pbr2, 1280x720)...`);
            const frames = await cdp.eval(
                `window.__BENCHMARK_API__.captureComparisonFrames('${preset}', 'pbr2', 1280, 720)`,
                false
            );
            for (const [key, dataUrl] of Object.entries(frames)) {
                saveDataUrlPng(dataUrl, path.join(framesDir, `${preset}_${key}.png`));
            }
        }

        const errors = [];
        for (const ev of cdp.events) {
            if (ev.method === 'Runtime.exceptionThrown') {
                errors.push({ type: 'exception', detail: ev.params.exceptionDetails?.text });
            } else if (
                ev.method === 'Runtime.consoleAPICalled' &&
                (ev.params.type === 'error' || ev.params.type === 'warning')
            ) {
                const txt = (ev.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
                errors.push({ type: ev.params.type, text: txt });
            }
        }
        console.log('[GPU Driver] Console errors/warnings:', JSON.stringify(errors));
        if (errors.some((e) => e.type === 'exception' || e.type === 'error')) {
            throw new Error(`Browser console reported errors: ${JSON.stringify(errors)}`);
        }

        cdp.close();
    } finally {
        chrome.kill('SIGKILL');
        server.close();
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error('[GPU Driver] ERRO:', err);
    process.exit(1);
});
