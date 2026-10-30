import { $, $message, CommonEventEmitter } from 'easy-us';
import { domSearchAll } from '../utils/dom';
import {
	CustomWorkOptions,
	RawElements,
	ResolverResult,
	SimplifyWorkResult,
	WorkContext,
	WorkerEvents,
	WorkOptions,
	WorkResult,
	WorkUploadType
} from './interface';
import { createDefaultQuestionResolver } from './question.resolver';
import { defaultWorkTypeResolver } from './utils';
import { AnswerWrapperHandlerConfig } from '../answer-wrapper';
import {
	DEFAULT_RETRY_POLICY,
	Mutex,
	RetryPolicy,
	RunControl,
	WorkClosedError,
	backoffDelay,
	runPool,
	withTimeout
} from './engine/async';
import { waitForDocumentReady } from './engine/readiness';

/**
 * 引擎全局配置（由「通用-全局设置」同步）
 */
export const WorkerEngineConfig = {
	/** 默认重试策略 */
	retry: { ...DEFAULT_RETRY_POLICY } as RetryPolicy,
	/**
	 * 单次尝试超时（毫秒）。不设置时取
	 * resolve_timeout_seconds（未设置则 timeout_seconds + 10）。
	 */
	attemptTimeoutMs: undefined as number | undefined,
	/** 读题前等待页面就绪的最长时间（毫秒） */
	readinessTimeoutMs: 30000,
	/**
	 * 停用原因：页面上同时运行着另一个 OCS 脚本时设置。
	 * 两个脚本同时答题会互相点掉对方选中的选项、重复提交，所以检测到冲突后本实例不再答题也不提交。
	 */
	blockedReason: undefined as string | undefined
};

/** 正在运行的答题器（用于冲突时统一关闭） */
const activeWorkers = new Set<{ emit: (event: 'close') => any }>();

/** 停用本实例的全部答题器：正在运行的立即关闭，之后的 doWork 直接报错 */
export function blockAllWorkers(reason: string) {
	WorkerEngineConfig.blockedReason = reason;
	for (const worker of Array.from(activeWorkers)) {
		worker.emit('close');
	}
}

function defaultAttemptTimeoutMs(): number {
	if (WorkerEngineConfig.attemptTimeoutMs) return WorkerEngineConfig.attemptTimeoutMs;
	const seconds =
		AnswerWrapperHandlerConfig.resolve_timeout_seconds ?? (AnswerWrapperHandlerConfig.timeout_seconds ?? 60) + 10;
	return seconds * 1000;
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * 自动答题器
 *
 * 每道题是一条独立流水线：等待页面就绪 → 读题搜题 → 作答。
 * - 搜题按 thread 并发，作答串行（同一时刻只有一道题在操作页面）；
 * - 任何一步失败（报错、超时、没有答案、答案匹配不上）都会按重试策略退避重试；
 * - 全部题目跑完后，对仍未完成的题目再补答若干轮；
 * - doWork 返回时所有题目都已到达最终状态，调用方据此计算完成率再决定是否提交。
 *
 * 旧实现把「搜题」和「作答」拆成两个线程，作答线程用固定超时等待搜题结果，
 * 超时就把题判失败并且之后不再处理，这是「没答完就提交」的根因。
 */
export class OCSWorker<E extends RawElements = RawElements> extends CommonEventEmitter<WorkerEvents> {
	opts: WorkOptions<E>;
	isRunning = false;
	isClose = false;
	isStop = false;
	totalQuestionCount = 0;

	private control = new RunControl();
	/** 作答锁：页面操作串行 */
	private resolveLock = new Mutex();

	/** 元素观察器定时器（root 消失检测） */
	private rootObserverTimer?: ReturnType<typeof setInterval>;
	/** root 开始持续消失的时间戳（未消失为 undefined） */
	private rootLostSince?: number;

	constructor(opts: WorkOptions<E>) {
		super();
		this.opts = opts;
		// 监听只注册一次（旧实现每次 doWork 都重复注册）
		this.on('close', () => {
			this.isClose = true;
			this.control.close();
			this.stopRootObserver();
		});
		this.on('stop', () => {
			this.isStop = true;
			this.control.pause();
		});
		this.on('continuate', () => {
			this.isStop = false;
			this.control.resume();
		});
	}

	private get retryPolicy(): RetryPolicy {
		return { ...WorkerEngineConfig.retry, ...(this.opts.retry || {}) };
	}

	private get attemptTimeoutMs(): number {
		return this.opts.attemptTimeoutMs ?? defaultAttemptTimeoutMs();
	}

	/**
	 * 启动元素观察器（幂等）：root 元素从界面消失时自动关闭答题。
	 * 持续消失超过 lostTimeoutMs 才判定丢失，防止重渲染时的瞬时脱离误判。
	 */
	private startRootObserver() {
		const cfg = this.opts.rootObserver;
		if (!cfg?.enabled || this.rootObserverTimer !== undefined) {
			return;
		}
		const interval = cfg.checkIntervalMs ?? 1000;
		const lostTimeout = cfg.lostTimeoutMs ?? 3000;
		this.rootObserverTimer = setInterval(() => {
			if (this.isClose) {
				this.stopRootObserver();
				return;
			}
			const alive =
				typeof this.opts.root === 'string'
					? !!document.querySelector(this.opts.root)
					: this.opts.root.some((el) => el.isConnected);
			if (alive) {
				this.rootLostSince = undefined;
				return;
			}
			this.rootLostSince ??= Date.now();
			if (Date.now() - this.rootLostSince >= lostTimeout) {
				this.stopRootObserver();
				cfg.onRootLost?.();
				if (!this.isClose) {
					$message.warn({
						content: '题目已从页面消失（页面可能已跳转或刷新），答题已停止。',
						duration: 0
					});
				}
				this.emit('close');
			}
		}, interval);
	}

	private stopRootObserver() {
		if (this.rootObserverTimer !== undefined) {
			clearInterval(this.rootObserverTimer);
			this.rootObserverTimer = undefined;
		}
		this.rootLostSince = undefined;
	}

	/** 调用平台钩子：钩子出错只记录，不打断答题 */
	private async hook<A extends any[]>(fn: ((...args: A) => any) | undefined, ...args: A) {
		if (!fn) return;
		try {
			await fn(...args);
		} catch (err) {
			console.error('[OCSWorker] 回调出错', err);
		}
	}

	private documentOf(): Document {
		if (typeof this.opts.root === 'string') return document;
		return this.opts.root[0]?.ownerDocument || document;
	}

	/** 本轮 doWork 中就绪等待已经超时过 */
	private readinessGaveUp = false;

	private async waitReady() {
		if (this.opts.readiness === false || this.readinessGaveUp) return;
		const ready = await waitForDocumentReady(this.documentOf(), {
			timeoutMs: WorkerEngineConfig.readinessTimeoutMs,
			...(this.opts.readiness || {}),
			cancelled: () => this.control.closed
		});
		if (!ready && !this.control.closed) {
			// 超时一次后本轮不再等待，避免每道题、每次重试都再等一遍
			this.readinessGaveUp = true;
			console.warn('[OCSWorker] 等待页面就绪超时，继续答题');
		}
	}

	/** 启动答题器 */
	async doWork(options?: { enable_debug?: boolean }): Promise<WorkResult<E>[]> {
		const results: WorkResult<E>[] = [];
		if (WorkerEngineConfig.blockedReason) {
			// 推迟一拍再关闭：调用方通常在 doWork() 返回 Promise 之后才注册 close 监听
			await new Promise((resolve) => setTimeout(resolve, 0));
			this.emit('close');
			throw new Error(WorkerEngineConfig.blockedReason);
		}
		if (this.isClose) return results;

		activeWorkers.add(this);
		this.emit('start');
		this.isRunning = true;
		this.readinessGaveUp = false;
		this.startRootObserver();
		const debug = !!options?.enable_debug;

		try {
			await this.waitReady();
			this.control.assertOpen();

			const questionRoots: HTMLElement[] =
				typeof this.opts.root === 'string'
					? Array.from(document.querySelectorAll<HTMLElement>(this.opts.root))
					: this.opts.root;

			this.totalQuestionCount += questionRoots.length;
			if (debug) console.debug('[OCSWorker] 题目数量', questionRoots.length, questionRoots);

			if (questionRoots.length === 0) {
				throw new Error('未找到任何题目，答题结束。');
			}

			for (const questionRoot of questionRoots) {
				const ctx: WorkContext<E> = {
					searchInfos: [],
					root: questionRoot,
					elements: domSearchAll<E>(this.opts.elements, questionRoot),
					type: undefined,
					answerSeparators: this.opts.answerSeparators
				};

				await this.hook(this.opts.onElementSearched, ctx.elements, questionRoot);
				ctx.elements.title = ctx.elements.title?.filter(Boolean) as HTMLElement[];
				ctx.elements.options = ctx.elements.options?.filter(Boolean) as HTMLElement[];

				if (typeof this.opts.work === 'object') {
					ctx.type =
						this.opts.work.type === undefined
							? defaultWorkTypeResolver(ctx)
							: typeof this.opts.work.type === 'string'
							? this.opts.work.type
							: this.opts.work.type(ctx);
				}

				const result: WorkResult<E> = { requested: false, resolved: false, ctx, attempts: 0 };
				results.push(result);
				await this.hook(this.opts.onQuestionDetected, result, results);
			}

			await this.hook(this.opts.onResultsInit, results[0], 0, results);

			const policy = this.retryPolicy;
			const indexes = results.map((_, i) => i);

			// 主轮次
			await runPool(indexes, this.opts.thread || 1, (i) =>
				this.runQuestion(results, i, Math.max(1, policy.maxAttempts), debug)
			);

			// 收尾补答：给限流 / 临时故障的接口一次恢复机会
			for (let round = 0; round < policy.sweepRounds; round++) {
				const failed = indexes.filter((i) => results[i].result?.finish !== true);
				if (failed.length === 0) break;
				if (debug) console.debug(`[OCSWorker] 第 ${round + 1} 轮补答`, failed);
				await this.control.sleep(policy.sweepDelayMs);
				await runPool(failed, this.opts.thread || 1, (i) => this.runQuestion(results, i, 1, debug));
			}
		} catch (err) {
			if (!(err instanceof WorkClosedError)) {
				this.finishRun();
				throw err;
			}
		}

		this.finishRun();
		return results;
	}

	/** 一轮 doWork 结束：停止元素观察（逐题流程在两轮之间会切换题目，元素会短暂消失） */
	private finishRun() {
		this.isRunning = false;
		activeWorkers.delete(this);
		this.stopRootObserver();
	}

	/** 单题流水线：最多尝试 maxAttempts 次 */
	private async runQuestion(results: WorkResult<E>[], index: number, maxAttempts: number, debug: boolean) {
		const result = results[index];
		const policy = this.retryPolicy;
		try {
			for (let n = 1; n <= maxAttempts; n++) {
				await this.control.checkpoint();
				const outcome = await this.attemptOnce(results, index, debug);
				if (outcome === 'done') return;
				// 题库正常响应但没有收录：立即重试结果不会变，留给收尾补答
				if (outcome === 'not-found') break;
				if (n < maxAttempts) {
					result.retrying = true;
					await this.hook(this.opts.onResultsUpdate, result, index, results);
					await this.control.sleep(backoffDelay(n, policy));
				}
			}
		} catch (err) {
			if (err instanceof WorkClosedError) {
				result.searching = false;
				result.retrying = false;
				return;
			}
			throw err;
		}
		result.retrying = false;
	}

	/**
	 * 一次尝试：读题搜题 + 作答。
	 * @returns done 已完成；not-found 来源正常响应但没有答案；failed 其他失败（值得重试）
	 */
	private async attemptOnce(
		results: WorkResult<E>[],
		index: number,
		debug: boolean
	): Promise<'done' | 'not-found' | 'failed'> {
		const result = results[index];
		const ctx = result.ctx as WorkContext<E>;

		// 每次读题前都确认页面就绪：字体解密可能在答题开始后才启动
		await this.waitReady();
		this.control.assertOpen();

		result.attempts = (result.attempts ?? 0) + 1;
		ctx.attempt = result.attempts;
		result.searching = true;
		result.requested = false;
		result.resolved = false;
		result.retrying = false;
		await this.hook(this.opts.onResultsUpdate, result, index, results);

		const timeoutMs = this.attemptTimeoutMs;
		const timeoutText = `搜题超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`;
		let error: string | undefined;
		let infos: WorkContext<E>['searchInfos'] = [];

		try {
			infos =
				(await this.control.race(
					withTimeout(Promise.resolve(this.opts.answerer(ctx.elements, ctx as any)), timeoutMs, timeoutText)
				)) || [];
			for (const info of infos) {
				info.results = (info.results || []).map((ans) => {
					ans.answer = ans.answer ? String(ans.answer).trim() : '';
					return ans;
				});
			}
		} catch (err) {
			if (err instanceof WorkClosedError) throw err;
			console.error('[OCSWorker] 搜题失败', err);
			error = errorMessage(err);
		}

		this.control.assertOpen();
		ctx.searchInfos = infos;
		result.searching = false;
		result.requested = true;
		if (debug) console.debug('[OCSWorker] 搜题结果', index + 1, infos);

		let res: ResolverResult | undefined;
		if (!error) {
			if (infos.length === 0) {
				error = '搜索不到答案';
			} else {
				try {
					// 锁一直持有到作答真正结束（即使已经超时），保证同一时刻只有一道题在操作页面；
					// 进入锁后先检查暂停与关闭：排队期间用户可能已经暂停或关闭
					const running = this.resolveLock.run(async () => {
						await this.control.checkpoint();
						return await this.resolve(ctx);
					});
					res = await this.control.race(
						withTimeout(running, timeoutMs, `作答超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`)
					);
				} catch (err) {
					if (err instanceof WorkClosedError) throw err;
					error = errorMessage(err);
				}
			}
		}

		const finish = res?.finish === true;
		const infoError = infos.map((i) => i.error).find(Boolean);
		const hasAnswer = infos.some((i) => i.results.some((r) => !!r.answer));
		const cleanNotFound = !finish && !error && !infoError && !hasAnswer;
		if (!finish && !error) {
			error = (res as any)?.error || infoError || (hasAnswer ? '答案与选项匹配不上' : '搜索不到答案');
		}

		result.result = res || { finish: false };
		result.error = finish ? undefined : error;
		result.resolved = true;
		await this.hook(this.opts.onResultsUpdate, result, index, results);
		return finish ? 'done' : cleanNotFound ? 'not-found' : 'failed';
	}

	/** 调用平台作答逻辑 */
	private async resolve(ctx: WorkContext<E>): Promise<ResolverResult> {
		if (typeof this.opts.work === 'object') {
			if (!ctx.elements.options) {
				throw new Error('elements.options 为空，使用默认处理器必须提供题目选项的选择器。');
			}
			if (!ctx.type) {
				throw new Error('题目类型解析失败，请提供解析器或忽略此题。');
			}
			const resolver = createDefaultQuestionResolver(
				ctx,
				// @ts-ignore work.optionText 跨 E 类型透传
				this.opts.work.optionText
			)[ctx.type];
			return await resolver(ctx.searchInfos, ctx.elements.options as HTMLElement[], this.opts.work.handler);
		}
		return await this.opts.work(ctx);
	}

	/**
	 * 提交判断：doWork 结束后（重试与补答都已完成）按完成率决定能否提交
	 */
	uploadHandler(options: {
		results: WorkResult<E>[];
		type: WorkUploadType;
		/**
		 * @param finishedRate 完成率（0-100）
		 * @param uploadable   是否可以提交
		 */
		callback: (finishedRate: number, uploadable: boolean) => void | Promise<void>;
	}) {
		const { results, type, callback } = options;
		if (type === 'nomove') return;
		// 已停用（页面上有另一个 OCS 在运行）或答题已关闭：既不保存也不提交
		if (WorkerEngineConfig.blockedReason || this.isClose) return;
		const finished = results.filter((r) => r.result?.finish === true).length;
		const rate = results.length === 0 ? 0 : (finished / results.length) * 100;
		// 仍有题目在搜题/重试中（理论上不会发生），一律不提交
		const settled = results.every((r) => !r.searching && !r.retrying);
		if (type === 'force') return callback(rate, settled);
		if (type === 'save') return callback(rate, false);
		const threshold = parseFloat(String(type));
		return callback(rate, settled && isFinite(threshold) && rate >= threshold);
	}
}

export class CustomOCSWorker extends CommonEventEmitter<WorkerEvents> {
	opts: CustomWorkOptions;
	isRunning = false;
	isClose = false;
	isStop = false;

	constructor(opts: CustomWorkOptions) {
		super();
		this.opts = opts;
	}

	/** 启动答题器  */
	async doWork(options?: { enable_debug?: boolean }) {
		this.emit('start');
		this.isRunning = true;

		this.once('close', () => {
			this.isClose = true;
		});

		this.on('stop', () => {
			this.isStop = true;
		});

		this.on('continuate', () => {
			this.isStop = false;
		});

		const questions = await this.opts.questions?.();

		if (options?.enable_debug) {
			console.debug('开始答题', this);
			console.debug('题目数量: ', this.opts.questions.length);
		}
		const results: SimplifyWorkResult[] = [];

		for (let index = 0; index < questions.length; index++) {
			/** 强行关闭 */
			if (this.isClose === true) {
				this.isRunning = false;
				return;
			}
			/** 检查是否暂停中 */
			if (this.isStop) {
				await waitForContinuate(() => this.isStop);
			}

			const question = questions[index];
			results[index] = {
				question: question.text,
				requested: false,
				resolved: false,
				searchInfos: [],
				type: question.type,
				finish: false,
				error: ''
			};

			try {
				const infos = await this.opts.answerer(question.text);
				results[index].searchInfos = infos.map((i) => ({
					name: i.name,
					homepage: i.homepage,
					results: i.results.map((r) => [r.question, r.answer, r.extra_data || {}]),
					error: i.error
				}));
				results[index].requested = true;
				this.opts.onResultsUpdate?.(results[index], index, results);

				try {
					const resolved = await this.opts.resolver(infos);
					results[index].finish = resolved.finish;
					results[index].error = resolved.error;
					results[index].resolved = true;
				} catch (err) {
					results[index].finish = false;
					results[index].error = err instanceof Error ? err.message : String(err);
					results[index].resolved = true;
				}
				this.opts.onResultsUpdate?.(results[index], index, results);
			} catch (err) {
				results[index].requested = true;
				results[index].resolved = false;
				results[index].finish = true;
				results[index].error = err instanceof Error ? err.message : String(err);
				this.opts.onResultsUpdate?.(results[index], index, results);
			}

			await $.sleep(this.opts.period);
		}
	}
}

async function waitForContinuate(isStopping: () => boolean) {
	if (isStopping()) {
		await new Promise<void>((resolve, reject) => {
			const interval = setInterval(() => {
				if (isStopping() === false) {
					clearInterval(interval);
					resolve();
				}
			}, 200);
		});
	}
}
