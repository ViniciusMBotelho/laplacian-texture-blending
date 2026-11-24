import fs from 'node:fs';
import path from 'node:path';
import { summarize, validateReport } from '../demo_webgl/benchmark_protocol.js';

export function parseArgs(argv) {
    const options = { outdir: 'output/validation', sessions: 5, smoke: false, quick: false,
        allowSoftware: false, fullRegimeControl: false, resolutionCheck: false, chrome: process.env.CHROME_PATH, samples: undefined, warmup: undefined };
    const values = { '--outdir': 'outdir', '--sessions': 'sessions', '--chrome': 'chrome', '--samples': 'samples', '--warmup': 'warmup' };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--smoke') options.smoke = true;
        else if (arg === '--quick') options.quick = true;
        else if (arg === '--allow-software') options.allowSoftware = true;
        else if (arg === '--full-regime-control') options.fullRegimeControl = true;
        else if (arg === '--resolution-check') options.resolutionCheck = true;
        else if (values[arg]) {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value: ${arg}`);
            options[values[arg]] = argv[++i];
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    for (const key of ['sessions', 'samples', 'warmup']) {
        if (options[key] === undefined) continue;
        options[key] = Number(options[key]);
        if (!Number.isInteger(options[key]) || options[key] < (key === 'warmup' ? 0 : 1)) throw new Error(`Invalid ${key}`);
    }
    return options;
}

export function findChrome(explicit, platform = process.platform) {
    const choices = [explicit,
        platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium',
        platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : '/usr/bin/chromium-browser',
        platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'];
    if (explicit && !fs.existsSync(explicit)) throw new Error(`Browser not found: ${explicit}`);
    const found = choices.find(p => p && fs.existsSync(p));
    if (!found) throw new Error('Chromium/Chrome not found. Set CHROME_PATH or --chrome.');
    return found;
}

export function resolveStaticPath(root, url) {
    const pathname = decodeURIComponent(url.split('?')[0]);
    const target = path.resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path outside server root');
    return target;
}

export function csv(rows) {
    if (!rows.length) return '';
    const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
    const encode = value => {
        if (value === null || value === undefined) return '';
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    return [keys.join(','), ...rows.map(r => keys.map(k => encode(r[k])).join(','))].join('\n') + '\n';
}

export function aggregateSessions(reports) {
    if (!reports.length) throw new Error('No sessions');
    const ids = new Set();
    const keys = report => report.results.map(r => `${r.caseId}/${r.methodId}`).sort();
    for (const report of reports) {
        validateReport(report);
        if (ids.has(report.sessionId)) throw new Error('Duplicate session identity');
        ids.add(report.sessionId);
        if (JSON.stringify(keys(report)) !== JSON.stringify(keys(reports[0]))) throw new Error('Sessions use different cases');
        if (report.hardware.unmaskedRenderer !== reports[0].hardware.unmaskedRenderer) throw new Error('Mixed hardware sessions');
        if (JSON.stringify(report.config) !== JSON.stringify(reports[0].config)) throw new Error('Mixed protocol sessions');
    }
    return { schemaVersion: 2, independentProcesses: true, n_sessions: reports.length,
        hardware: reports[0].hardware, config: reports[0].config,
        results: reports[0].results.map(first => {
            const rows = reports.map(report => report.results.find(r => r.caseId === first.caseId && r.methodId === first.methodId));
            const values = rows.map(r => r.median_ms);
            return { caseId: first.caseId, methodId: first.methodId,
                sessionIds: reports.map(r => r.sessionId), session_medians_ms: values,
                session_means_ms: rows.map(r => r.mean_ms), n_valid_by_session: rows.map(r => r.n_valid),
                n_discarded_by_session: rows.map(r => r.n_discarded),
                median_of_session_medians_ms: summarize(values).median,
                iqr_of_session_medians_ms: summarize(values).iqr };
        }) };
}
