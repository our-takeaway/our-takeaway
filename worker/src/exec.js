import { spawn } from 'node:child_process';

// Run a command, optionally feeding stdin; resolves with stdout or rejects with stderr tail.
export function run(cmd, args, { cwd, env, input, timeoutMs = 10 * 60 * 1000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (err += d));
		child.on('error', (e) => {
			clearTimeout(timer);
			reject(e.code === 'ENOENT' ? new Error(`command not found: ${cmd}`) : e);
		});
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			if (code === 0) return resolve(out);
			const why = signal ? `killed (${signal}, timeout?)` : `exit ${code}`;
			const e = new Error(`${cmd} ${why}: ${(err || out).trim().slice(-2000)}`);
			e.stdout = out;
			reject(e);
		});
		child.stdin.on('error', () => {});
		child.stdin.end(input ?? '');
	});
}
