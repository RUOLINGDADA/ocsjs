import { SearchInformation } from '../answer-wrapper/interface';
import { AiAnswer, AiAnswerEnv, AiError, AiProfile } from './interface';
import { askAi, AiTransportDeps } from './transport';
import { normalizeBaseUrl } from './providers';

/** 从 baseUrl 推导一个可点击的主页 */
function resolveHomepage(profile: AiProfile): string | undefined {
	if (profile.homepage) return profile.homepage;
	try {
		return new URL(normalizeBaseUrl(profile.baseUrl)).origin;
	} catch {
		return undefined;
	}
}

/** AI 结果在结果面板/缓存中的展示名 */
export function createAiAnswererName(profile: AiProfile): string {
	return `AI 题库：${profile.model || profile.name || '未命名模型'}`;
}

/**
 * 把一次 AI 作答转成既有的 SearchInformation 结构
 *
 * `extra_data.ai = true` 是既有结果面板识别的标记（见 elements/search.infos.ts），
 * 会把答案渲染成带「AI」标签的一行，提示用户该答案由模型生成。
 */
export function createAiSearchInformation(profile: AiProfile, env: AiAnswerEnv, answer: AiAnswer): SearchInformation {
	return {
		name: createAiAnswererName(profile),
		homepage: resolveHomepage(profile),
		url: normalizeBaseUrl(profile.baseUrl),
		results: [
			{
				question: env.title,
				answer: answer.answer,
				extra_data: {
					ai: true,
					model: answer.model,
					confidence: answer.confidence,
					reason: answer.reason,
					usage: answer.usage
				}
			}
		],
		response: { model: answer.model, raw: answer.raw, usage: answer.usage },
		data: { type: env.type, model: answer.model }
	};
}

/**
 * AI 作答并返回 SearchInformation[]
 *
 * 与 `defaultAnswerWrapperHandler` 行为一致：**不抛异常**，
 * 失败时返回一条带 `error` 的空结果，让答题线程继续处理后面的题目
 * （整场答题不会因为某一道题的 AI 报错而中断）。
 */
export async function aiAnswererHandler(
	profile: AiProfile,
	env: AiAnswerEnv,
	opts: { separators?: string[]; deps?: AiTransportDeps } = {}
): Promise<SearchInformation[]> {
	try {
		const answer = await askAi(profile, env, opts);
		return [createAiSearchInformation(profile, env, answer)];
	} catch (err) {
		const error = err instanceof AiError ? err : new AiError('network', String((err as any)?.message || err));
		return [
			{
				name: createAiAnswererName(profile),
				homepage: resolveHomepage(profile),
				url: normalizeBaseUrl(profile.baseUrl),
				results: [],
				error: error.message,
				response: { code: error.code, status: error.status },
				data: { type: env.type, model: profile.model }
			}
		];
	}
}
