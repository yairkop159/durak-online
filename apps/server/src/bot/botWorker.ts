import { parentPort } from 'node:worker_threads';
import { decide } from './decide.js';
import type { BotJob, BotJobResult } from './job.js';

// Worker protocol: receive a BotJob, post a BotJobResult. The worker's clock is used only for a
// `thinkMs` budget; the engine itself stays clock-free.
const port = parentPort;
if (!port) throw new Error('botWorker must run in a worker thread');

port.on('message', (job: BotJob) => {
  let result: BotJobResult;
  try {
    result = { jobId: job.jobId, move: decide(job, () => performance.now()) };
  } catch {
    result = { jobId: job.jobId, move: null, failed: true };
  }
  port.postMessage(result);
});
