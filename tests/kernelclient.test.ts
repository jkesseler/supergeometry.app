// Run: npx tsx tests/kernelclient.test.ts - the page's side of the geometry engine, with a stand-in worker:
// an engine swapped in that then dies, and an engine that never starts. Neither may leave a call waiting for ever.

let failed = 0;
const check = (name: string, ok: boolean, info: unknown = '') => {
  if (!ok) {
    failed++;
  }
  console.log(ok ? 'ok  ' : 'FAIL', name, typeof info === 'string' ? info : JSON.stringify(info));
};

interface Envelope {
  id: number;
  msg: { type: string };
}

class FakeWorker {
  static created: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  sent: Envelope[] = [];

  constructor() {
    FakeWorker.created.push(this);
  }

  postMessage(envelope: Envelope) {
    this.sent.push(envelope);
  }

  terminate() {}

  answer(type: string, response: object) {
    const asked = this.sent.find(envelope => envelope.msg.type === type)!;
    this.onmessage?.({ data: { id: asked.id, msg: response } });
  }
}
(globalThis as any).Worker = FakeWorker;

const { KernelClient } = await import('../src/kernel/client');
const outcomeOrTimeout = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<string>(resolve => setTimeout(() => resolve('still waiting'), 500))]);

// ---------------------------------------- a spare engine swapped in, then dies
{
  const client = new KernelClient();
  FakeWorker.created.at(-1)!.answer('init', { type: 'ready' });
  await client.ready;
  const spare = new FakeWorker();
  (client as any).spare = { worker: spare, bodies: [] };
  (client as any).swapIfIdle();
  check('swap: the spare engine is the one in use', (client as any).worker === spare);
  let lost = false;
  client.onLost = () => (lost = true);
  const waiting = client.health([]).then(() => 'answered', (error: Error) => error.message);
  await new Promise(resolve => setTimeout(resolve, 0));
  check('swap: the call goes to the spare engine', spare.sent.some(envelope => envelope.msg.type === 'health'));
  spare.onerror?.({ message: 'out of memory' });
  const outcome = await outcomeOrTimeout(waiting);
  check('swapped engine dies: the waiting call ends', outcome === 'Stopped', outcome);
  check('swapped engine dies: a fresh one is started', lost);
}

// ------------------------------------------------- an engine that never starts
{
  const client = new KernelClient();
  client.ready.catch(() => undefined);
  FakeWorker.created.at(-1)!.answer('init', { type: 'error', message: 'out of memory' });
  const outcome = await outcomeOrTimeout(client.regenerate([]));
  check('engine never starts: a rebuild ends with nothing', outcome === null, outcome);
  check('engine never starts: the next rebuild is not stuck behind it', (await outcomeOrTimeout(client.regenerate([]))) === null);
}

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
