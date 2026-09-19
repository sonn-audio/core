/*
 * A test process can die in ways no handler inside it will ever see: a native
 * addon segfaults, the OOM killer steps in, a stack overflow in C++ land. The
 * runner is a single process walking one list, so when that happens the suite
 * stops wherever it was. `npm test` does fail — the shell reports 139 — but the
 * last line printed is the *previous* test's `ok`, and how much of the suite
 * never ran at all is invisible unless you count the lines yourself.
 *
 * This is the runner's supervisor. It starts run-tests.ts as a child, listens
 * for the breadcrumb the child sends before each test, and if the child dies of
 * a signal it names the test that was on the table and how many never got their
 * turn. Nothing else changes: stdio is inherited, so the output is the runner's
 * own, and a normal run exits with the runner's own code.
 */
import { assertSupportedNodeVersion } from '../src/shared/utils/nodeVersion';
import { spawn } from 'node:child_process';
import path from 'node:path';

assertSupportedNodeVersion();

interface StartMessage {
  type: 'test:start';
  index: number;
  name: string;
  total: number;
}

function isStartMessage(value: unknown): value is StartMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'test:start'
  );
}

// Defaults to the suite; a path argument lets the supervisor's own crash reporting
// be exercised against a stub that dies on purpose.
const runner = process.argv[2] ?? path.join(__dirname, 'run-tests.ts');

// Reproduce this process's own invocation — whatever launched supervise.ts has to
// launch the runner too, with only the script at the end swapped for run-tests.ts.
// execArgv is that invocation minus the script: under `ts-node supervise.ts` it is
// the ts-node bin and its flags, under `node --require ts-node/register` it is the
// --require. argv[1] is *this* script, never the launcher, so passing it along would
// start another supervisor, which would start another one, until the box is out of
// memory. Only execArgv goes through.
const child = spawn(process.execPath, [...process.execArgv, runner], {
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
});

let started: StartMessage | null = null;

child.on('message', (message) => {
  if (isStartMessage(message)) started = message;
});

child.on('exit', (code, signal) => {
  if (signal) {
    const where = started
      ? `during test ${started.index + 1}/${started.total}, "${started.name}"`
      : 'before the first test started';
    const missed = started ? started.total - started.index - 1 : 0;
    console.error(`\nnot ok - the test process was killed by ${signal} ${where}`);
    console.error(
      `# ${missed} test${missed === 1 ? '' : 's'} after it never ran, so this run proves nothing about them`,
    );
    console.error(
      '# A signal is not a failing assertion. Suspect the native modules that test touches,\n' +
        '# or a runtime below engines.node, before suspecting the assertion itself.',
    );
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error('not ok - could not start the test runner');
  console.error(error);
  process.exit(1);
});
