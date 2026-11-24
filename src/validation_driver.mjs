import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, findChrome, resolveStaticPath, csv, aggregateSessions } from './benchmark_driver_lib.mjs';
import { validateReport } from '../demo_webgl/benchmark_protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.jpg': 'image/jpeg', '.png': 'image/png' };

async function startServer() {
    const server = http.createServer((req, res) => {
        let file;
        try { file = resolveStaticPath(ROOT, req.url || '/'); } catch { res.writeHead(403); res.end(); return; }
        fs.readFile(file, (err, data) => {
            res.writeHead(err ? 404 : 200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
            res.end(err ? '' : data);
        });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return { server, port: server.address().port };
}

class CDP {
    constructor(socket) { this.socket = socket; this.id = 0; this.pending = new Map(); this.errors = []; }
    static async connect(url) {
        const socket = new WebSocket(url), client = new CDP(socket);
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true });
        });
        socket.addEventListener('message', event => {
            const msg = JSON.parse(event.data);
            if (msg.id) {
                const request = client.pending.get(msg.id); if (!request) return;
                client.pending.delete(msg.id);
                msg.error ? request.reject(new Error(msg.error.message)) : request.resolve(msg.result);
            } else if (msg.method === 'Runtime.bindingCalled') {
                try { client.onBinding?.(msg.params.name, JSON.parse(msg.params.payload)); }
                catch (error) { client.errors.push(error.message); }
            } else if (msg.method === 'Runtime.exceptionThrown') client.errors.push(msg.params.exceptionDetails);
            else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
                client.errors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
        });
        socket.addEventListener('close', () => {
            for (const request of client.pending.values()) request.reject(new Error('Browser disconnected'));
            client.pending.clear();
        });
        return client;
    }
    send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++this.id; this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression, awaitPromise = true) {
        const response = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
        return response.result?.value;
    }
    close() { this.socket.close(); }
}

async function waitForBrowser(profile, child, stderr) {
    for (let i = 0; i < 200; i++) {
        if (child.exitCode !== null) throw new Error(`Browser exited: ${stderr()}`);
        const file = path.join(profile, 'DevToolsActivePort');
        if (fs.existsSync(file)) {
            const port = Number(fs.readFileSync(file, 'utf8').split(/\r?\n/)[0]);
            try {
                const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
                const page = targets.find(t => t.type === 'page');
                if (page) return page.webSocketDebuggerUrl;
            } catch { /* browser target is not ready yet */ }
        }
        await delay(100);
    }
    throw new Error(`Browser startup timeout: ${stderr()}`);
}

export async function runSession(options, sessionIndex, outputRoot) {
    const chromePath = findChrome(options.chrome);
    const sessionId = `session-${String(sessionIndex + 1).padStart(3, '0')}`;
    const outdir = path.join(outputRoot, sessionId);
    if (fs.existsSync(path.join(outdir, 'resultados_gpu.json'))) throw new Error(`Refusing to overwrite session: ${outdir}`);
    fs.mkdirSync(path.join(outdir, 'frames'), { recursive: true });
    const profile = fs.mkdtempSync(path.join(outdir, '.browser-profile-'));
    const { server, port } = await startServer();
    const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
        '--window-size=1280,720', '--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist',
        `http://127.0.0.1:${port}/demo_webgl/`];
    const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '', client;
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-12000); });
    const spawnError = new Promise((_, reject) => child.once('error', reject));
    // Attach the handler immediately; otherwise an early spawn failure is unhandled.
    spawnError.catch(() => {});
    const close = once(child, 'close').catch(() => {});
    const stop = () => child.kill();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
        const url = await Promise.race([waitForBrowser(profile, child, () => stderr), spawnError]);
        client = await CDP.connect(url);
        await client.send('Runtime.enable');
        const savedFrames = new Set();
        client.onBinding = (name, frame) => {
            if (name === '__BENCHMARK_PROGRESS__') { console.log(`[${sessionId}] ${frame.label}`); return; }
            if (name !== '__BENCHMARK_FRAME__') return;
            if (!frame.dataUrl?.startsWith('data:image/png;base64,')) throw new Error('Invalid frame payload');
            const dest = path.resolve(outdir, frame.path);
            if (!dest.startsWith(path.resolve(outdir, 'frames') + path.sep)) throw new Error('Frame path escaped session');
            fs.writeFileSync(dest, Buffer.from(frame.dataUrl.split(',')[1], 'base64'));
            savedFrames.add(frame.path);
        };
        await client.send('Runtime.addBinding', { name: '__BENCHMARK_FRAME__' });
        await client.send('Runtime.addBinding', { name: '__BENCHMARK_PROGRESS__' });
        let ready = false;
        for (let i = 0; i < 300; i++) {
            ready = await client.evaluate('Boolean(window.__BENCHMARK_API__?.getTelemetry()?.fetchesPx > 0)', false);
            if (ready) break;
            if (client.errors.length) throw new Error(JSON.stringify(client.errors));
            await delay(100);
        }
        if (!ready) throw new Error(`Scene initialization timeout: ${stderr}`);
        if (options.fullRegimeControl)
            await client.evaluate('window.__BENCHMARK_API__.setState({nearLimit: 2, farLimit: 3})', false);
        const config = { full: !options.quick && !options.smoke, smoke: options.smoke,
            resolutionCheck: options.resolutionCheck, sessionId, includeFrames: true };
        if (options.samples !== undefined) config.sampleFrames = options.samples;
        if (options.warmup !== undefined) config.warmupFrames = options.warmup;
        console.log(`[${sessionId}] browser PID=${child.pid}; rendering/timing at matched resolutions`);
        const encoded = await client.evaluate(`(async () => JSON.stringify(await window.__BENCHMARK_API__.runConfigured({
            ...${JSON.stringify(config)}, onFrame: frame => window.__BENCHMARK_FRAME__(JSON.stringify(frame)),
            onProgress: progress => { if (progress.label.endsWith('quality captures')) window.__BENCHMARK_PROGRESS__(JSON.stringify(progress)); }
        }), (_k,v) => v === Infinity ? 'Infinity' : v))()`);
        const report = JSON.parse(encoded);
        report.browserProcessId = child.pid;
        report.browserExecutable = chromePath;
        const renderer = report.hardware.unmaskedRenderer || report.hardware.renderer;
        report.softwareRenderer = /swiftshader|llvmpipe|software|microsoft basic render/i.test(renderer);
        report.functionalTestOnly = Boolean(options.smoke || report.config.sampleFrames < 100 || report.config.warmupFrames < 5);
        report.scientificTimingEligible = !report.softwareRenderer && report.hardware.hasGpuTimerQuery && !report.functionalTestOnly;
        if (report.softwareRenderer && !options.allowSoftware) throw new Error(`Software renderer (${renderer}); use --allow-software only for functional validation.`);
        for (const row of report.results) {
            if (!savedFrames.has(row.quality_frame)) throw new Error(`Missing capture ${row.caseId}/${row.methodId}`);
            delete row.imageDataUrl;
        }
        validateReport(report);
        if (client.errors.length) throw new Error(`Browser errors: ${JSON.stringify(client.errors)}`);
        fs.writeFileSync(path.join(outdir, 'resultados_gpu.json'), JSON.stringify(report, null, 2));
        fs.writeFileSync(path.join(outdir, 'resultados_gpu.csv'), csv(report.results));
        fs.writeFileSync(path.join(outdir, 'raw_queries.csv'), csv(report.rawQueries));
        console.log(`[${sessionId}] ${report.results.length} cases/methods; ${report.rawQueries.length} query records; ${renderer}`);
        return report;
    } finally {
        client?.close(); child.kill(); await close;
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        // Only delete the exact temporary profile that this session created.
        if (path.dirname(path.resolve(profile)) !== path.resolve(outdir) || !path.basename(profile).startsWith('.browser-profile-'))
            throw new Error('Unexpected browser profile path');
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const outputRoot = path.resolve(ROOT, options.outdir, `run-${stamp}`);
    fs.mkdirSync(outputRoot, { recursive: true });
    const reports = [];
    for (let i = 0; i < options.sessions; i++) reports.push(await runSession(options, i, outputRoot));
    const summary = aggregateSessions(reports);
    fs.writeFileSync(path.join(outputRoot, 'sessions_summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(outputRoot, 'sessions_summary.csv'), csv(summary.results));
    console.log(`Validation output: ${outputRoot}`);
    return { outputRoot, summary, reports };
}
