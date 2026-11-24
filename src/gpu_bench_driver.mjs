#!/usr/bin/env node
import { main } from './validation_driver.mjs';
main().catch(error => { console.error('[GPU benchmark]', error.stack || error); process.exitCode = 1; });
