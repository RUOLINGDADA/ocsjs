import {
	AnswererWrapper,
	AiAnswerEnv,
	AiProfile,
	SearchInformation,
	aiAnswererHandler,
	defaultAnswerWrapperHandler,
	AiError
} from '@ocsjs/core';
import { $message } from 'easy-us';
import { createQuestionHash } from '../hash';
import { AiSettings, getAiSettings, isProfileUsable } from './config';

/**
 * AI 答题与固定题库的组合调度
 *
 * 三条原则：
 * 1. **不中断**：AI 失败只影响当前这道题，绝不 throw 打断整场答题；
 * 2. **不浪费**：同一份试卷里重复题干只请求一次 API（并发去重），并按配置限制并发；
 * 3. **不瞎猜**：AI 没给出可用答案时，交给既有匹配器判为「未搜到」，由用户配置的随机作答兜底。
 */

/** 结果里是否存在非空答案 */
export function hasAnswer(infos: SearchInformation[] | undefined): boolean {
	if (!infos || infos.length === 0) return false;
	return infos.some((info) => (info.results || []).some((res) => !!String(res.answer ?? '').trim()));
}

/** 是否还有可用的答题来源 */
export function hasUsableAnswerer(answererWrappers?: AnswererWrapper[]): {
	ok: boolean;
	bank: boolean;
	ai: boolean;
	/** 不可用原因：none=两边都没配；ai-incomplete=AI 开了但配置不全 */
	reason?: 'none' | 'ai-incomplete';
} {
	const bank = (answererWrappers?.length ?? 0) > 0;
	const settings = getAiSettings();
	const ai = settings.enabled && isProfileUsable(settings.activeProfile);

	if (bank || ai) return { ok: true, bank, ai };
	if (settings.enabled) return { ok: false, bank, ai, reason: 'ai-incomplete' };
	return { ok: false, bank, ai, reason: 'none' };
}

/** 并发闸门（模块级，跨 worker 共享，避免多线程把供应商打爆） */
let activeCount = 0;
const waiters: Array<() => void> = [];

async function withConcurrency<T>(limit: number, task: () => Promise<T>): Promise<T> {
	if (activeCount >= limit) {
		await new Promise<void>((resolve) => waiters.push(resolve));
	}
	activeCount++;
	try {
		return await task();
	} finally {
		activeCount--;
		const next = waiters.shift();
		if (next) next();
	}
}

/** 同一题目的并发去重表：key → 进行中的请求 */
const inflightAnswers = new Map<string, Promise<SearchInformation[]>>();

/** 已提示过的错误（避免逐题刷屏） */
const notifiedIssues = new Set<string>();

/** 一次性错误提示 */
function notifyIssueOnce(key: string, content: string) {
	if (notifiedIssues.has(key)) return;
	notifiedIssues.add(key);
	$message.warn({ content, duration: 15 });
}

/**
 * 向 AI 提问（带并发限制与并发去重）
 *
 * 返回结构始终为 SearchInformation[]；失败时是一条带 error 的空结果。
 */
export async function askAiSearch(
	env: AiAnswerEnv,
	settings: AiSettings = getAiSettings(),
	profile: AiProfile | undefined = settings.activeProfile,
	separators?: string[]
): Promise<SearchInformation[]> {
	if (!profile) {
		return [
			{
				name: 'AI 题库',
				results: [],
				error: settings.enabled
					? 'AI 题库配置不完整，请前往：通用-全局设置-AI 题库 补全接口地址、API Key 与模型名。'
					: '未启用 AI 题库。'
			}
		];
	}
	if (!isProfileUsable(profile)) {
		return [
			{
				name: `AI 题库：${profile.model || profile.name}`,
				results: [],
				error: '当前 AI 配置已被停用或缺少接口地址/API Key/模型名，请前往：通用-全局设置-AI 题库 检查。'
			}
		];
	}

	const optionsText = env.suggestion_options || env.options || '';
	const dedupeKey = createQuestionHash(env.title, optionsText, `${env.type ?? ''}|${profile.id}|${profile.model}`);

	const existing = inflightAnswers.get(dedupeKey);
	if (existing) return existing;

	const task = withConcurrency(settings.maxConcurrency, async () => {
		const infos = await aiAnswererHandler(profile, env, { separators });

		// 置信度过滤：低于用户设定的阈值时按「没有答案」处理
		if (settings.minConfidence > 0) {
			for (const info of infos) {
				info.results = info.results.filter((res) => {
					const confidence = Number((res.extra_data as any)?.confidence);
					return !isFinite(confidence) || confidence >= settings.minConfidence;
				});
			}
			const filtered = infos.filter((info) => info.results.length === 0 && !info.error);
			for (const info of filtered) {
				info.error = `AI 给出的答案置信度低于 ${settings.minConfidence}，已丢弃（可在：通用-全局设置-AI 题库 调整最低置信度）`;
			}
		}

		// 致命配置类错误提示一次
		const firstError = infos.find((info) => info.error);
		if (firstError?.error) {
			const code = (firstError.response as any)?.code as AiError['code'] | undefined;
			if (code === 'unauthorized' || code === 'forbidden' || code === 'not-found' || code === 'insufficient-quota') {
				notifyIssueOnce(`${code}|${profile.id}`, `AI 题库（${profile.name}）：${firstError.error}`);
			}
		}

		return infos;
	});

	inflightAnswers.set(dedupeKey, task);
	try {
		return await task;
	} finally {
		inflightAnswers.delete(dedupeKey);
	}
}

/** 分隔符交给 core 的解析器（填空多段拼接用），此处只从 env 透传 */

/**
 * 统一的「答题来源」管线：AI 与固定题库按模式组合
 *
 * @param wrappers 已过滤掉停用题库的固定题库配置（可为空数组）
 * @param env      题目上下文（与固定题库共用同一份，避免两套概念）
 * @param separators 答案分隔符（透传给 AI 的填空拼接逻辑）
 */
export async function runAnswererPipeline(opts: {
	wrappers: AnswererWrapper[];
	env: AiAnswerEnv;
	separators?: string[];
}): Promise<SearchInformation[]> {
	const settings = getAiSettings();
	const bankAvailable = (opts.wrappers?.length ?? 0) > 0;
	const aiProfile = settings.enabled && isProfileUsable(settings.activeProfile) ? settings.activeProfile! : undefined;
	const aiAvailable = !!aiProfile;

	if (!bankAvailable && !aiAvailable) {
		// 与既有行为保持一致的报错文案（上层会把它记为题目错误）
		throw new Error('题库配置不能为空，请配置后重新开始自动答题。');
	}

	const askBank = () => defaultAnswerWrapperHandler(opts.wrappers, opts.env);
	const askAi = () => askAiSearch(opts.env, settings, aiProfile, opts.separators);

	if (!aiAvailable) return askBank();
	if (!bankAvailable || settings.mode === 'ai') return askAi();

	if (settings.mode === 'wrappers-first') {
		const bankInfos = await askBank();
		if (hasAnswer(bankInfos)) return bankInfos;
		const aiInfos = await askAi();
		return bankInfos.concat(aiInfos);
	}

	// 默认：AI 优先，AI 没答案时回退固定题库
	const aiInfos = await askAi();
	if (hasAnswer(aiInfos)) return aiInfos;
	const bankInfos = await askBank();
	return aiInfos.concat(bankInfos);
}

/** 清空运行时状态（重新答题/切换平台时调用，避免跨试卷串答案） */
export function resetAiAnswererRuntime(): void {
	inflightAnswers.clear();
}
