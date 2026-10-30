/**
 * 答题引擎单测（不联网）
 *
 * 运行：npx tsx --import ./tests/setup-browser-env.ts tests/engine.test.ts
 *
 * 覆盖用户反馈的两个问题的根因：
 * 1. 跳转后第一题答不上：第一题在字体解密完成前就被读取 → 引擎必须等页面就绪再读题；
 *    DeepSeek V4.x 默认开启思考，思考 token 计入 max_tokens，1024 不够时 content 为空 → 需识别并重试。
 * 2. 没答完就提交：答题线程等待搜题有固定超时，超时的题被直接判失败且之后不再处理，
 *    完成率仍达到阈值就提交 → 引擎必须对失败题重试（含收尾补答），完成率在重试后计算。
 */

import { OCSWorker, WorkerEngineConfig, blockAllWorkers } from '../packages/core/src/core/worker/worker';
import { markDocumentBusy, waitForDocumentReady } from '../packages/core/src/core/worker/engine/readiness';
import { parseAiResponse } from '../packages/core/src/core/ai/providers';
import { askAi } from '../packages/core/src/core/ai/transport';
import { AiError, AiProfile } from '../packages/core/src/core/ai/interface';
import { SearchInformation } from '../packages/core/src/core/answer-wrapper/interface';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: any) {
	if (cond) {
		passed++;
		return;
	}
	failures.push(`${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`);
	console.error(`FAIL ${name}`, detail === undefined ? '' : detail);
}
function eq(name: string, actual: any, expected: any) {
	check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 构造一套单选题 DOM：每题 .q > .t 题干 + .o 选项 */
function mountQuestions(count: number): HTMLElement {
	const box = document.createElement('div');
	for (let i = 0; i < count; i++) {
		const q = document.createElement('div');
		q.className = 'q';
		q.innerHTML = `<div class="t">题目${i + 1}</div><div class="o">A. 甲</div><div class="o">B. 乙</div>`;
		box.appendChild(q);
	}
	document.body.appendChild(box);
	return box;
}

function answerInfo(answer: string, error?: string): SearchInformation[] {
	return [{ name: 'test', results: answer ? [{ question: 'q', answer }] : [], error }];
}

/** 选择题处理器：点击（这里只记录）匹配到的选项 */
function createWorker(
	box: HTMLElement,
	answerer: (title: string, attempt: number) => Promise<SearchInformation[]>,
	extra: Partial<ConstructorParameters<typeof OCSWorker>[0]> = {}
) {
	const clicked: string[] = [];
	const worker = new OCSWorker({
		root: Array.from(box.querySelectorAll<HTMLElement>('.q')),
		elements: { title: '.t', options: '.o' },
		thread: 2,
		retry: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 10, sweepRounds: 1, sweepDelayMs: 5 },
		attemptTimeoutMs: 2000,
		readiness: { timeoutMs: 2000, pollMs: 10 },
		answerer: (elements, ctx) => answerer(elements.title?.[0]?.textContent || '', ctx.attempt ?? 1),
		work: {
			type: 'single',
			// jsdom 没有 innerText
			optionText: (el) => el.textContent || '',
			handler: (_type, _answer, option) => {
				clicked.push(option.textContent || '');
			}
		},
		...extra
	});
	return { worker, clicked };
}

async function testRetryUntilSuccess() {
	const box = mountQuestions(1);
	let calls = 0;
	const { worker } = createWorker(box, async () => {
		calls++;
		if (calls < 3) throw new Error('网络错误');
		return answerInfo('A');
	});
	const results = await worker.doWork();
	eq('失败两次后第三次成功：finish', results[0].result?.finish, true);
	eq('失败两次后第三次成功：调用次数', calls, 3);
	eq('失败两次后第三次成功：attempts 记录', results[0].attempts, 3);
	eq('成功后清除错误信息', results[0].error, undefined);
	box.remove();
}

async function testEmptyAnswerIsRetried() {
	const box = mountQuestions(1);
	let calls = 0;
	const { worker } = createWorker(box, async () => {
		calls++;
		return calls === 1 ? answerInfo('', '响应中没有文本内容') : answerInfo('B');
	});
	const results = await worker.doWork();
	eq('AI 首次返回空答案会重试', results[0].result?.finish, true);
	eq('AI 首次返回空答案：调用 2 次', calls, 2);
	box.remove();
}

async function testCleanNotFoundSkipsInlineRetry() {
	const box = mountQuestions(1);
	let calls = 0;
	const { worker } = createWorker(box, async () => {
		calls++;
		// 题库正常响应但没有收录：立即重试结果不会变，只在收尾补答时再试一次
		return answerInfo('');
	});
	const results = await worker.doWork();
	eq('题库未收录：主轮 1 次 + 补答 1 次', calls, 2);
	eq('题库未收录：最终未完成', results[0].result?.finish, false);
	eq('题库未收录：错误信息', results[0].error, '搜索不到答案');
	box.remove();
}

async function testSweepRecoversExhaustedQuestion() {
	const box = mountQuestions(3);
	const callsByTitle: Record<string, number> = {};
	const { worker } = createWorker(box, async (title) => {
		callsByTitle[title] = (callsByTitle[title] || 0) + 1;
		// 题目2 前 3 次（主轮次全部重试）都失败，收尾补答时成功
		if (title === '题目2' && callsByTitle[title] <= 3) return answerInfo('', '服务端错误（503）');
		return answerInfo('A');
	});
	const results = await worker.doWork();
	eq(
		'收尾补答后全部完成',
		results.map((r) => r.result?.finish),
		[true, true, true]
	);
	eq('题目2 共调用 4 次（3 次主轮 + 1 次补答）', callsByTitle['题目2'], 4);
	box.remove();
}

async function testUploadRateAfterRetries() {
	const box = mountQuestions(5);
	let failOnce = true;
	const { worker } = createWorker(box, async (title) => {
		if (title === '题目1' && failOnce) {
			failOnce = false;
			throw new Error('超时');
		}
		return answerInfo('A');
	});
	const results = await worker.doWork();
	let rate = -1;
	let uploadable = false;
	await worker.uploadHandler({
		results,
		type: 100,
		callback: (r, u) => {
			rate = r;
			uploadable = u;
		}
	});
	eq('重试后完成率为 100%', rate, 100);
	eq('完成率达到 100% 阈值才允许提交', uploadable, true);
	box.remove();
}

async function testUploadBlockedWhenStillFailing() {
	const box = mountQuestions(4);
	const { worker } = createWorker(box, async (title) =>
		title === '题目4' ? answerInfo('', '服务端错误（503）') : answerInfo('A')
	);
	const results = await worker.doWork();
	let uploadable = true;
	await worker.uploadHandler({ results, type: 80, callback: (_r, u) => void (uploadable = u) });
	eq('3/4=75% 低于 80% 阈值时不提交', uploadable, false);
	box.remove();
}

async function testTimedOutAttemptIsRetried() {
	const box = mountQuestions(1);
	let calls = 0;
	const { worker } = createWorker(
		box,
		async () => {
			calls++;
			if (calls === 1) {
				await sleep(400);
				return answerInfo('B');
			}
			return answerInfo('A');
		},
		{ attemptTimeoutMs: 100 }
	);
	const results = await worker.doWork();
	eq('单次尝试超时后重试成功', results[0].result?.finish, true);
	await sleep(450);
	// 超时那次的迟到结果（B）不能覆盖后来成功的结果
	const answers = results[0].ctx?.searchInfos.flatMap((i) => i.results.map((r) => r.answer));
	eq('迟到的超时结果被丢弃', answers, ['A']);
	box.remove();
}

async function testWaitsForFontDecryptBeforeReading() {
	const box = mountQuestions(2);
	const first = box.querySelector<HTMLElement>('.t')!;
	first.textContent = '密文';
	const release = markDocumentBusy(document, 'font-decrypt');
	setTimeout(() => {
		first.textContent = '题目1';
		release();
	}, 150);
	const seen: string[] = [];
	const { worker } = createWorker(box, async (title) => {
		seen.push(title);
		return answerInfo('A');
	});
	await worker.doWork();
	check('等待解密完成后才读取第一题', seen.includes('题目1') && !seen.includes('密文'), seen);
	box.remove();
}

async function testReadinessTimesOut() {
	const release = markDocumentBusy(document, 'stuck');
	const started = Date.now();
	const ready = await waitForDocumentReady(document, { timeoutMs: 120, pollMs: 10 });
	eq('就绪等待超时后返回 false', ready, false);
	check('就绪等待在超时附近返回', Date.now() - started < 1000, Date.now() - started);
	release();
	eq('释放后立即就绪', await waitForDocumentReady(document, { timeoutMs: 120, pollMs: 10 }), true);
}

async function testCloseStopsRetries() {
	const box = mountQuestions(1);
	let calls = 0;
	const { worker } = createWorker(
		box,
		async () => {
			calls++;
			throw new Error('一直失败');
		},
		{ retry: { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 100, sweepRounds: 0, sweepDelayMs: 0 } }
	);
	const running = worker.doWork();
	await sleep(150);
	worker.emit('close');
	const started = Date.now();
	await running;
	check('关闭后在 300ms 内退出', Date.now() - started < 300, Date.now() - started);
	check('关闭后不再继续重试', calls <= 3, calls);
	box.remove();
}

async function testPauseHoldsQueue() {
	const box = mountQuestions(2);
	let calls = 0;
	const { worker } = createWorker(box, async () => {
		calls++;
		return answerInfo('A');
	});
	worker.emit('stop');
	const running = worker.doWork();
	await sleep(120);
	eq('暂停期间不搜题', calls, 0);
	worker.emit('continuate');
	await running;
	eq('继续后完成全部题目', calls, 2);
	box.remove();
}

async function testListenersNotDuplicatedAcrossRuns() {
	const box = mountQuestions(1);
	const { worker } = createWorker(box, async () => answerInfo('A'));
	await worker.doWork();
	await worker.doWork();
	await worker.doWork();
	// 原实现每次 doWork 都会重复注册 stop/continuate/close 监听
	const count = (worker as any).listenerCount?.('stop') ?? (worker as any).events?.stop?.length ?? 0;
	check('多次 doWork 不累积监听器', count <= 1, count);
	box.remove();
}

async function testBlockedClosesRunningAndRefusesUpload() {
	const box = mountQuestions(3);
	let calls = 0;
	const { worker } = createWorker(box, async () => {
		calls++;
		await sleep(80);
		return answerInfo('A');
	});
	const running = worker.doWork();
	await sleep(30);
	blockAllWorkers('页面上还有另一个 OCS 在运行');
	const results = await running;
	check('停用后正在运行的答题器被关闭', worker.isClose === true);
	check('停用后不再继续搜题', calls <= 2, calls);
	let called = false;
	await worker.uploadHandler({ results, type: 'force', callback: () => void (called = true) });
	eq('停用后强制提交也不会触发', called, false);

	const { worker: next } = createWorker(box, async () => answerInfo('A'));
	let error = '';
	try {
		await next.doWork();
	} catch (err) {
		error = String((err as Error).message);
	}
	eq('停用后新的答题直接报错', error, '页面上还有另一个 OCS 在运行');
	WorkerEngineConfig.blockedReason = undefined;
	box.remove();
}

async function testCloseInterruptsInFlightSearch() {
	const box = mountQuestions(1);
	const { worker } = createWorker(box, async () => {
		await sleep(2000);
		return answerInfo('A');
	});
	const running = worker.doWork();
	await sleep(50);
	const started = Date.now();
	worker.emit('close');
	await running;
	check('关闭会打断进行中的搜题', Date.now() - started < 300, Date.now() - started);
	box.remove();
}

async function testNoClickAfterClose() {
	const box = mountQuestions(2);
	const clicksAfterClose: string[] = [];
	let closed = false;
	const worker = new OCSWorker({
		root: Array.from(box.querySelectorAll<HTMLElement>('.q')),
		elements: { title: '.t', options: '.o' },
		thread: 2,
		readiness: { timeoutMs: 100, pollMs: 10 },
		attemptTimeoutMs: 2000,
		answerer: async () => answerInfo('A'),
		work: {
			type: 'single',
			optionText: (el) => el.textContent || '',
			handler: async (_t, _a, option) => {
				if (closed) clicksAfterClose.push(option.textContent || '');
				// 第一题作答较慢，第二题在锁上排队
				await sleep(150);
			}
		}
	});
	const running = worker.doWork();
	await sleep(60);
	closed = true;
	worker.emit('close');
	await running;
	await sleep(250);
	eq('关闭后排队中的题不会再点击', clicksAfterClose, []);
	box.remove();
}

async function testNoClickWhilePaused() {
	const box = mountQuestions(1);
	let paused = false;
	let clickedWhilePaused = false;
	const worker = new OCSWorker({
		root: Array.from(box.querySelectorAll<HTMLElement>('.q')),
		elements: { title: '.t', options: '.o' },
		readiness: { timeoutMs: 100, pollMs: 10 },
		attemptTimeoutMs: 2000,
		answerer: async () => {
			await sleep(100);
			return answerInfo('A');
		},
		work: {
			type: 'single',
			optionText: (el) => el.textContent || '',
			handler: () => {
				if (paused) clickedWhilePaused = true;
			}
		}
	});
	const running = worker.doWork();
	await sleep(40);
	paused = true;
	worker.emit('stop');
	await sleep(200);
	eq('暂停期间搜题返回也不作答', clickedWhilePaused, false);
	paused = false;
	worker.emit('continuate');
	const results = await running;
	eq('继续后完成作答', results[0].result?.finish, true);
	box.remove();
}

async function testResolveTimeoutKeepsPageSerialized() {
	const box = mountQuestions(2);
	let active = 0;
	let maxActive = 0;
	const worker = new OCSWorker({
		root: Array.from(box.querySelectorAll<HTMLElement>('.q')),
		elements: { title: '.t', options: '.o' },
		thread: 2,
		retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, sweepRounds: 0, sweepDelayMs: 0 },
		readiness: { timeoutMs: 100, pollMs: 10 },
		attemptTimeoutMs: 100,
		answerer: async () => answerInfo('A'),
		work: {
			type: 'single',
			optionText: (el) => el.textContent || '',
			handler: async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				await sleep(250);
				active--;
			}
		}
	});
	await worker.doWork();
	await sleep(400);
	eq('作答超时后页面操作仍然串行', maxActive, 1);
	box.remove();
}

// ========== AI 空响应 ==========

const deepseek: AiProfile = {
	id: 'p',
	name: 'DeepSeek',
	protocol: 'openai',
	baseUrl: 'https://api.deepseek.com/v1',
	apiKey: 'sk-test-123456',
	model: 'deepseek-v4.1-flash',
	maxTokens: 1024,
	retries: 2
};

function openAiBody(message: Record<string, any>, finish = 'stop') {
	return { choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }] };
}

function testParseTruncatedByThinking() {
	try {
		parseAiResponse(deepseek, openAiBody({ content: '', reasoning_content: '让我想想……' }, 'length'));
		check('思考耗尽 token 应当抛错', false);
	} catch (err) {
		eq('思考耗尽 token：错误码 truncated', (err as AiError).code, 'truncated');
	}
}

function testParseAnswerInsideReasoning() {
	const res = parseAiResponse(
		deepseek,
		openAiBody({ content: '', reasoning_content: '分析……最终答案 {"answer":"B","confidence":0.9}' })
	);
	check('content 为空时从 reasoning_content 末尾取出 JSON 答案', res.text.includes('"answer":"B"'), res.text);
}

function testParseEmptyIsRetryableCode() {
	try {
		parseAiResponse(deepseek, openAiBody({ content: '' }));
		check('完全空响应应当抛错', false);
	} catch (err) {
		eq('完全空响应：错误码 empty', (err as AiError).code, 'empty');
	}
}

async function testAskAiEscalatesTokensAfterTruncation() {
	const sentMaxTokens: number[] = [];
	const answer = await askAi(deepseek, { title: '1+1=?', type: 'single', options: 'A. 1\nB. 2' } as any, {
		deps: {
			send: async (http) => {
				sentMaxTokens.push((http.body as any).max_tokens);
				if (sentMaxTokens.length === 1) {
					return {
						status: 200,
						responseText: JSON.stringify(openAiBody({ content: '', reasoning_content: '……' }, 'length'))
					};
				}
				return { status: 200, responseText: JSON.stringify(openAiBody({ content: '{"answer":"B"}' })) };
			}
		}
	});
	eq('截断后重试拿到答案', answer.answer.length > 0, true);
	check('截断后重试调大 max_tokens', sentMaxTokens.length === 2 && sentMaxTokens[1] > sentMaxTokens[0], sentMaxTokens);
}

async function testAskAiRetriesEmpty() {
	let calls = 0;
	const answer = await askAi(
		{ ...deepseek, model: 'gpt-x' },
		{ title: '1+1=?', type: 'single', options: 'A. 1\nB. 2' } as any,
		{
			deps: {
				send: async () => {
					calls++;
					return {
						status: 200,
						responseText: JSON.stringify(openAiBody({ content: calls === 1 ? '' : '{"answer":"B"}' }))
					};
				}
			},
			retryDelayMs: 1
		}
	);
	eq('空响应会重试', calls, 2);
	check('空响应重试后拿到答案', !!answer.answer, answer);
}

async function testPartialTruncatedReplyIsRetried() {
	const sent: number[] = [];
	const answer = await askAi(
		{ ...deepseek, model: 'gpt-x', baseUrl: 'https://api.example.com/v1' },
		{ title: '1+1=?', type: 'single', options: 'A. 1\nB. 2' } as any,
		{
			deps: {
				send: async (http) => {
					sent.push((http.body as any).max_tokens);
					const body =
						sent.length === 1
							? openAiBody({ content: '{"answer":"' }, 'length')
							: openAiBody({ content: '{"answer":"B"}' });
					return { status: 200, responseText: JSON.stringify(body) };
				}
			},
			retryDelayMs: 1
		}
	);
	check('只输出半截 JSON 被截断时也会调大重试', sent.length === 2 && sent[1] > sent[0], sent);
	check('半截截断重试后拿到答案', !!answer.answer, answer);
}

async function testEscalation400StepsBack() {
	const sent: { max: number; thinking?: any }[] = [];
	const answer = await askAi(
		{ ...deepseek, maxTokens: 4096 },
		{ title: '1+1=?', type: 'single', options: 'A. 1\nB. 2' } as any,
		{
			deps: {
				send: async (http) => {
					const body = http.body as any;
					sent.push({ max: body.max_tokens, thinking: body.thinking });
					if (sent.length === 1) {
						return {
							status: 200,
							responseText: JSON.stringify(openAiBody({ content: '', reasoning_content: '…' }, 'length'))
						};
					}
					// 调大后的上限超过模型支持范围
					if (body.max_tokens > 8192) {
						return { status: 400, responseText: '{"error":{"message":"max_tokens exceeds limit"}}' };
					}
					return { status: 200, responseText: JSON.stringify(openAiBody({ content: '{"answer":"B"}' })) };
				}
			},
			retryDelayMs: 1
		}
	);
	check('调大上限遇到 400 时退回原上限并关闭思考', !!answer.answer, sent);
	const last = sent[sent.length - 1];
	check('退回后的请求关闭了思考', last.max <= 8192 && last.thinking?.type === 'disabled', sent);
}

(async () => {
	console.log('答题引擎单测\n');
	const tests: [string, () => any][] = [
		['retry', testRetryUntilSuccess],
		['empty-retry', testEmptyAnswerIsRetried],
		['clean-not-found', testCleanNotFoundSkipsInlineRetry],
		['sweep', testSweepRecoversExhaustedQuestion],
		['upload-after-retry', testUploadRateAfterRetries],
		['upload-blocked', testUploadBlockedWhenStillFailing],
		['attempt-timeout', testTimedOutAttemptIsRetried],
		['font-decrypt-wait', testWaitsForFontDecryptBeforeReading],
		['readiness-timeout', testReadinessTimesOut],
		['close', testCloseStopsRetries],
		['pause', testPauseHoldsQueue],
		['listeners', testListenersNotDuplicatedAcrossRuns],
		['blocked', testBlockedClosesRunningAndRefusesUpload],
		['close-in-flight', testCloseInterruptsInFlightSearch],
		['no-click-after-close', testNoClickAfterClose],
		['no-click-paused', testNoClickWhilePaused],
		['resolve-timeout-serial', testResolveTimeoutKeepsPageSerialized],
		['ai-truncated', testParseTruncatedByThinking],
		['ai-reasoning', testParseAnswerInsideReasoning],
		['ai-empty', testParseEmptyIsRetryableCode],
		['ai-escalate', testAskAiEscalatesTokensAfterTruncation],
		['ai-empty-retry', testAskAiRetriesEmpty],
		['ai-partial-truncated', testPartialTruncatedReplyIsRetried],
		['ai-escalation-400', testEscalation400StepsBack]
	];
	for (const [name, fn] of tests) {
		try {
			await fn();
		} catch (err) {
			check(`${name} 抛出异常`, false, String((err as any)?.stack || err));
		}
	}
	console.log(`\n通过 ${passed}，失败 ${failures.length}`);
	if (failures.length) {
		console.log(failures.map((f) => ' - ' + f).join('\n'));
		process.exit(1);
	}
	process.exit(0);
})();
