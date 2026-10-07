import { Worker } from 'node:worker_threads';
export class ReplayPool {
  constructor(count) {
    this.queue = []; this.counter = 0; this.closed = false;
    this.slots = Array.from({ length: count }, () => {
      const slot = { worker: new Worker(new URL('./worker.mjs', import.meta.url)), task: null };
      slot.worker.on('message', message => {
        const task = slot.task; slot.task = null;
        if (!task) return;
        if (message.error) task.reject(new Error(message.error)); else task.resolve(message.result);
        this.dispatch(slot);
      });
      slot.worker.on('error', error => { this.fail(error); });
      slot.worker.on('exit', code => { if (!this.closed && code !== 0) this.fail(new Error(`回测 worker 退出 ${code}`)); });
      return slot;
    });
  }
  fail(error) {
    for (const slot of this.slots) { slot.task?.reject(error); slot.task = null; }
    for (const task of this.queue.splice(0)) task.reject(error);
    this.closed = true;
    for (const slot of this.slots) slot.worker.terminate();
  }
  dispatch(slot) {
    if (slot.task || !this.queue.length || this.closed) return;
    slot.task = this.queue.shift(); slot.worker.postMessage({ ...slot.task.job, id: ++this.counter });
  }
  submit(job) {
    if (this.closed) return Promise.reject(new Error('回测 worker pool 已关闭'));
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject }); for (const slot of this.slots) this.dispatch(slot);
    });
  }
  async close() { this.closed = true; await Promise.all(this.slots.map(s => s.worker.terminate())); }
}
