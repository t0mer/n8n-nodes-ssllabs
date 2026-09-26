#!/usr/bin/env node
// Pre-publish check: runs the n8n Creator Portal scanner against the repository source and the
// packed tarball. The scanner CLI only accepts registry package names, so this calls its
// analyzePackage() directly. Install it first (not a devDependency; its deps trip npm audit):
//   npm install --no-save @n8n/scan-community-package@0.37.0
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	analyzePackage,
	SOURCE_FILE_PATTERNS,
} from '@n8n/scan-community-package/scanner/scanner.mjs';

const root = resolve(import.meta.dirname, '..');

async function check(label, dir, patterns) {
	const result = await analyzePackage(dir, patterns);
	if (result.passed) {
		console.log(`✅ ${label}: passed`);
		return true;
	}
	console.error(`❌ ${label}: ${result.message}`);
	if (result.details) console.error(result.details);
	return false;
}

const work = mkdtempSync(join(tmpdir(), 'n8n-scan-'));
try {
	const sourceOk = await check('source', root, SOURCE_FILE_PATTERNS);

	const [{ filename }] = JSON.parse(
		execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: root, encoding: 'utf8' }),
	);
	execFileSync('tar', ['-xzf', join(work, filename), '-C', work]);
	const tarballOk = await check('tarball', join(work, 'package'), ['**/*.js', 'package.json']);

	process.exitCode = sourceOk && tarballOk ? 0 : 1;
} finally {
	rmSync(work, { recursive: true, force: true });
}
