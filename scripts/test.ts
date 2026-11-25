// Run: npm test (the quick tests) | npm run test:all (also tests/*.slow.test.ts) | npm test -- tests/a.test.ts ...
// Each test file is a script that exits non-zero on failure; several run at once.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';

const args = process.argv.slice(2);
const isAll = args.includes('--all');
const named = args.filter(arg => arg !== '--all');
const files = named.length
  ? named
  : readdirSync('tests')
    .filter(name => name.endsWith('.test.ts') && (isAll || !name.endsWith('.slow.test.ts')))
    .sort()
    .map(name => `tests/${name}`);
// Each geometry test holds its own engine (hundreds of MB): half the cores keeps memory in bounds.
const jobs = Math.max(1, Math.floor(availableParallelism() / 2));

function run(file: string): Promise<boolean> {
  const started = Date.now();
  const child = spawn(process.execPath, ['--import', 'tsx', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  return new Promise((resolve) => {
    child.on('close', (code) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
      const isOk = code === 0;
      console.log(`${isOk ? 'ok  ' : 'FAIL'} ${seconds}s ${file}`);
      if (!isOk) {
        const lines = output.trimEnd().split('\n');
        const failures = lines.filter(line => line.startsWith('FAIL'));
        console.log([...failures, ...lines.slice(-5)].map(line => `       ${line}`).join('\n'));
      }
      resolve(isOk);
    });
  });
}

const queue = [...files];
const failed: string[] = [];
const started = Date.now();
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  for (let file = queue.shift(); file; file = queue.shift()) {
    if (!(await run(file))) {
      failed.push(file);
    }
  }
}));
const minutes = ((Date.now() - started) / 60000).toFixed(1);
console.log(failed.length ? `\n${failed.length} of ${files.length} failed (${minutes} min):\n${failed.join('\n')}` : `\nall ${files.length} passed (${minutes} min)`);
process.exit(failed.length ? 1 : 0);
