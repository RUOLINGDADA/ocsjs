/**
 * 引擎用到的异步原语。
 *
 * 全部基于「条件等待」而不是猜测时长：暂停、关闭、超时都能在一个轮询周期内生效，
 * 避免旧实现里 setInterval 等待 + 固定超时互相赛跑导致的错判。
 */

/** 关闭答题时抛出，用于快速跳出所有等待 */
export class WorkClosedError extends Error {
	constructor() {
		super('答题已关闭');
		this.name = 'WorkClosedError';
	}
}

/** 运行控制：暂停 / 继续 / 关闭 */
export class RunControl {
	closed = false;
	paused = false;
	private waiters = new Set<() => void>();
	private closedSignal?: Promise<never>;

	close() {
		this.closed = true;
		this.flush();
	}

	/** 关闭时 reject 的 Promise，用来打断正在进行的搜题 / 作答 */
	whenClosed(): Promise<never> {
		if (!this.closedSignal) {
			this.closedSignal = new Promise<never>((_resolve, reject) => {
				const check = () => (this.closed ? reject(new WorkClosedError()) : this.waiters.add(check));
				check();
			});
			// 没有人等待时不产生未处理的 rejection
			this.closedSignal.catch(() => undefined);
		}
		return this.closedSignal;
	}

	/** 与关闭信号赛跑：关闭时立即抛出 WorkClosedError */
	race<T>(promise: Promise<T>): Promise<T> {
		this.assertOpen();
		return Promise.race([promise, this.whenClosed()]);
	}

	pause() {
		this.paused = true;
	}

	resume() {
		this.paused = false;
		this.flush();
	}

	/** 重新开始一轮（关闭后再次 doWork） */
	reset() {
		this.closed = false;
		this.flush();
	}

	private flush() {
		const list = Array.from(this.waiters);
		this.waiters.clear();
		list.forEach((fn) => fn());
	}

	/** 关闭时抛出 WorkClosedError */
	assertOpen() {
		if (this.closed) throw new WorkClosedError();
	}

	/** 暂停中则挂起，直到继续或关闭 */
	async checkpoint(): Promise<void> {
		this.assertOpen();
		while (this.paused) {
			await new Promise<void>((resolve) => this.waiters.add(resolve));
			this.assertOpen();
		}
	}

	/** 可被关闭打断的 sleep */
	sleep(ms: number): Promise<void> {
		this.assertOpen();
		if (ms <= 0) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const done = () => {
				clearTimeout(timer);
				this.waiters.delete(wake);
				this.closed ? reject(new WorkClosedError()) : resolve();
			};
			const wake = () => {
				// 继续（resume）也会唤醒等待者，只有关闭才提前结束 sleep
				if (this.closed) done();
				else this.waiters.add(wake);
			};
			const timer = setTimeout(done, ms);
			this.waiters.add(wake);
		});
	}
}

/** 带超时的 Promise：超时 reject，原 Promise 的迟到结果被丢弃 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	if (!isFinite(ms) || ms <= 0) return promise;
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			}
		);
	});
}

/** 串行锁：保证同一时刻只有一个任务在操作页面 */
export class Mutex {
	private tail: Promise<void> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const result = this.tail.then(task, task);
		this.tail = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}
}

/** 以固定并发数消费任务列表 */
export async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
	const queue = items.slice();
	const lanes = Math.max(1, Math.min(concurrency, queue.length));
	await Promise.all(
		Array.from({ length: lanes }, async () => {
			while (queue.length) {
				const item = queue.shift() as T;
				await worker(item);
			}
		})
	);
}

/** 重试策略 */
export interface RetryPolicy {
	/** 单题在主轮次中的最多尝试次数（含第一次），默认 3 */
	maxAttempts: number;
	/** 首次重试前的等待（毫秒），之后指数递增，默认 2000 */
	baseDelayMs: number;
	/** 单次重试等待上限（毫秒），默认 15000 */
	maxDelayMs: number;
	/** 全部题目跑完后，对仍未完成的题目再补答几轮，默认 1 */
	sweepRounds: number;
	/** 补答前的冷却时间（毫秒），给限流的接口留出恢复时间，默认 5000 */
	sweepDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 3,
	baseDelayMs: 2000,
	maxDelayMs: 15000,
	sweepRounds: 1,
	sweepDelayMs: 5000
};

/** 第 attempt 次失败后的等待时长（attempt 从 1 开始） */
export function backoffDelay(attempt: number, policy: RetryPolicy): number {
	return Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)));
}
