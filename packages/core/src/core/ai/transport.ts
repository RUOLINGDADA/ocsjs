import { request } from '../utils/request';
import { $ } from '../../utils/common';
import { AiAnswer, AiAnswerEnv, AiError, AiProbeResult, AiProfile } from './interface';
import {
	MAX_AI_MAX_TOKENS,
	DEFAULT_AI_MAX_TOKENS,
	buildAiRequest,
	extractApiError,
	parseAiResponse
} from './providers';
import { buildAiPrompt } from './prompt';
import { toMatcherAnswer } from './parser';

/**
 * AI 请求传输层
 *
 * 负责：校验配置 → 组装请求 → 发送（超时 / 重试）→ 解析响应 → 规范化答案。
 * 所有异常一律转成 AiError（带错误码），由上层决定是降级到固定题库还是直接记该题失败。
 */

/** 默认单次请求超时（毫秒） */
export const DEFAULT_AI_TIMEOUT_MS = 60_000;
/** 默认重试次数（429 / 5xx / 网络 / 超时 / 空响应 / 被截断 会重试） */
export const DEFAULT_AI_RETRIES = 2;

/** 需要脱敏的密钥形态（常见的 sk- 前缀 / Bearer 头） */
const SECRET_PATTERN = /(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{8,})/g;

/**
 * 密钥脱敏：日志、错误信息、UI 展示都必须过这一层
 * @param secrets 额外需要抹掉的明文密钥（通常是当前 profile 的 apiKey）
 */
export function redactSecrets(text: string, secrets: string[] = []): string {
	let value = String(text ?? '');
	for (const secret of secrets) {
		if (secret && secret.length >= 4) {
			value = value.split(secret).join('***');
		}
	}
	return value.replace(SECRET_PATTERN, '***');
}

/** 配置是否完整（不含「可用性」判断，仅字段校验） */
export function isProfileComplete(profile?: Partial<AiProfile> | null): boolean {
	if (!profile) return false;
	return !!(
		String(profile.baseUrl || '').trim() &&
		String(profile.apiKey || '').trim() &&
		String(profile.model || '').trim()
	);
}

/** 校验配置，返回错误对象（无错误返回 undefined） */
export function validateAiProfile(profile?: Partial<AiProfile> | null): AiError | undefined {
	if (!profile) return new AiError('no-config', '未选择 AI 配置');
	if (!String(profile.baseUrl || '').trim()) return new AiError('no-config', '接口地址（baseUrl）为空');
	if (!String(profile.model || '').trim()) return new AiError('no-config', '模型名（model）为空');
	if (!String(profile.apiKey || '').trim()) return new AiError('no-config', 'API Key 为空');
	try {
		const url = new URL(String(profile.baseUrl).trim());
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return new AiError('no-config', '接口地址必须以 http:// 或 https:// 开头');
		}
	} catch {
		return new AiError('no-config', '接口地址不是合法的 URL');
	}
	return undefined;
}

/** HTTP 状态码 → 可读错误 */
function errorFromStatus(status: number, bodyText: string, secrets: string[]): AiError {
	let apiMessage = '';
	try {
		apiMessage = extractApiError(JSON.parse(bodyText)) || '';
	} catch {
		apiMessage = String(bodyText || '').slice(0, 200);
	}
	const detail = redactSecrets(apiMessage, secrets).trim();
	const suffix = detail ? `：${detail}` : '';

	switch (status) {
		case 400:
			return new AiError('bad-response', `请求被拒绝（400）${suffix}`, status);
		case 401:
			return new AiError('unauthorized', `API Key 无效或已失效（401）${suffix}`, status);
		case 402:
			return new AiError('insufficient-quota', `账户余额不足（402）${suffix}`, status);
		case 403:
			return new AiError('forbidden', `无访问权限或被地区限制（403）${suffix}`, status);
		case 404:
			return new AiError(
				'not-found',
				`接口地址或模型不存在（404）${suffix}。请检查 baseUrl 是否需要 /v1 结尾、模型名是否正确`,
				status
			);
		case 429:
			return new AiError('rate-limit', `请求过于频繁或超出配额（429）${suffix}`, status);
		default:
			if (status >= 500) {
				return new AiError('server-error', `服务端错误（${status}）${suffix}`, status);
			}
			return new AiError('bad-response', `请求失败（${status}）${suffix}`, status);
	}
}

/** 是否值得重试 */
function isRetryable(error: AiError): boolean {
	return (
		error.code === 'rate-limit' ||
		error.code === 'server-error' ||
		error.code === 'network' ||
		error.code === 'timeout' ||
		error.code === 'empty' ||
		error.code === 'truncated'
	);
}

/** 是否 DeepSeek 系模型（默认开启思考，可用 thinking.type=disabled 关闭） */
function isDeepSeekModel(profile: AiProfile): boolean {
	return /deepseek/i.test(String(profile.model || '')) || /deepseek\.com/i.test(String(profile.baseUrl || ''));
}

/**
 * 回复被截断后的下一次请求配置：
 * 1. 回复上限翻 4 倍（不超过 MAX_AI_MAX_TOKENS）；
 * 2. 已经调大过一次仍被截断，且是 DeepSeek 系模型：关闭思考（DeepSeek 文档中的 thinking.type=disabled），
 *    用户在附加请求体里显式配置过 thinking 时不覆盖。
 */
export function escalateForTruncation(profile: AiProfile, truncations: number): AiProfile {
	const grow = (value: number) => Math.min(MAX_AI_MAX_TOKENS, Math.max(value * 4, 4096));
	const current = typeof profile.maxTokens === 'number' ? profile.maxTokens : DEFAULT_AI_MAX_TOKENS;
	const next: AiProfile = { ...profile, maxTokens: grow(current) };
	// 附加请求体里用 max_completion_tokens 取代了 max_tokens 时，一起调大
	const extraLimit = profile.extraBody?.max_completion_tokens;
	if (typeof extraLimit === 'number') {
		next.extraBody = { ...(profile.extraBody || {}), max_completion_tokens: grow(extraLimit) };
	}
	if (truncations >= 2) return withThinkingDisabled(next);
	return next;
}

/** DeepSeek 系模型关闭思考（用户在附加请求体里自己配置过 thinking 时不覆盖） */
function withThinkingDisabled(profile: AiProfile): AiProfile {
	if (!isDeepSeekModel(profile) || (profile.extraBody && 'thinking' in profile.extraBody)) return profile;
	return { ...profile, extraBody: { ...(profile.extraBody || {}), thinking: { type: 'disabled' } } };
}

/** 发送一次请求（带超时竞速），返回状态码与响应文本 */
async function sendOnce(
	http: ReturnType<typeof buildAiRequest>,
	timeoutMs: number
): Promise<{
	status: number;
	responseText: string;
}> {
	const timeoutMarker = Symbol('timeout');
	const raced = await Promise.race([
		request(http.url, {
			// 优先走 GM_xmlhttpRequest 绕过跨域限制；非脚本环境（Node）会自动降级为 fetch
			type: 'GM_xmlhttpRequest',
			method: 'post',
			responseType: 'text',
			anyStatus: true,
			headers: http.headers,
			data: http.body,
			// 留 1 秒余量让底层请求自行中止，避免悬挂连接
			timeout: timeoutMs + 1000
		}) as unknown as Promise<{ status: number; responseText: string }>,
		new Promise<typeof timeoutMarker>((resolve) => {
			setTimeout(() => resolve(timeoutMarker), timeoutMs);
		})
	]);

	if (raced === timeoutMarker) {
		throw new AiError('timeout', `请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`);
	}
	const res = raced as { status: number; responseText: string };
	return { status: res?.status ?? 0, responseText: String(res?.responseText ?? '') };
}

/** 兼容旧式状态探测：request 在某些实现下可能返回字符串 */
function normalizeResponse(res: any): { status: number; responseText: string } {
	if (res && typeof res === 'object' && 'status' in res) {
		return { status: Number((res as any).status) || 0, responseText: String((res as any).responseText ?? '') };
	}
	return { status: 200, responseText: typeof res === 'string' ? res : JSON.stringify(res ?? '') };
}

/**
 * 传输层可注入依赖（仅用于测试：不联网即可覆盖 200/401/429/超时 等分支）
 */
export interface AiTransportDeps {
	/** 发送请求，默认走 core 的 request()（浏览器 GM_xmlhttpRequest / Node fetch） */
	send?: (
		http: ReturnType<typeof buildAiRequest>,
		timeoutMs: number
	) => Promise<{
		status: number;
		responseText: string;
	}>;
}

/**
 * 向 AI 提一次问并拿到可直接用于匹配的答案
 *
 * @throws AiError 所有失败路径都抛 AiError，调用方按 code 决定提示语
 */
export async function askAi(
	profile: AiProfile,
	env: AiAnswerEnv,
	opts: { separators?: string[]; deps?: AiTransportDeps; retryDelayMs?: number } = {}
): Promise<AiAnswer> {
	const invalid = validateAiProfile(profile);
	if (invalid) throw invalid;

	const send = opts.deps?.send ?? sendOnce;
	const timeoutMs = Math.max(5000, Number(profile.timeoutMs) || DEFAULT_AI_TIMEOUT_MS);
	const maxRetries = Math.max(0, Math.min(5, Number(profile.retries ?? DEFAULT_AI_RETRIES)));
	const secrets = [String(profile.apiKey || '')];

	const prompt = buildAiPrompt(env, {
		systemPrompt: profile.systemPrompt,
		// 未显式声明视觉能力时不发送图片，避免不识图的模型直接报 400
		vision: profile.vision === true
	});
	let activeProfile = profile;
	let http = buildAiRequest(activeProfile, prompt);
	let truncations = 0;
	/** 调大上限之前的配置：调大后被服务端以 400 拒绝（超出模型输出上限）时退回 */
	let beforeEscalation: AiProfile | undefined;
	let steppedBack = false;
	const retryDelayMs = Math.max(0, opts.retryDelayMs ?? 1000);

	let lastError: AiError | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const raw = await send(http, timeoutMs);
			const res = normalizeResponse(raw);

			if (res.status < 200 || res.status >= 300) {
				throw errorFromStatus(res.status, res.responseText, secrets);
			}

			let json: any;
			try {
				json = JSON.parse(res.responseText);
			} catch {
				throw new AiError(
					'bad-response',
					`响应不是合法 JSON：${redactSecrets(res.responseText.slice(0, 160), secrets)}`
				);
			}

			const { text, usage, truncated } = parseAiResponse(profile, json);
			let normalized: ReturnType<typeof toMatcherAnswer>;
			try {
				normalized = toMatcherAnswer(text, {
					type: env.type,
					options: (env.suggestion_options || env.options || '')
						.split('\n')
						.map((o) => o.trim())
						.filter(Boolean),
					blankCount: env.blankCount,
					separators: opts.separators
				});
			} catch (parseError) {
				// 只输出了半截就被截断：按截断处理（调大上限重试），而不是当成模型答非所问
				if (truncated) {
					throw new AiError('truncated', '模型的回复被「最大回复 token」截断，没有输出完整答案');
				}
				throw parseError;
			}
			// 被截断的回复只有包含完整的 {"answer": ...} 对象才可信；否则解析器会把半截文本当成答案
			if (truncated && (!String(normalized.answer ?? '').trim() || !/\{[^{}]*"answer"\s*:[^{}]*\}/.test(text))) {
				throw new AiError('truncated', '模型的回复被「最大回复 token」截断，没有输出完整答案');
			}

			return {
				answer: normalized.answer,
				confidence: normalized.confidence,
				reason: normalized.reason,
				model: profile.model,
				raw: text.slice(0, 500),
				usage
			};
		} catch (err) {
			const error =
				err instanceof AiError
					? err
					: new AiError('network', redactSecrets(String((err as any)?.message || err), secrets));
			lastError = error;

			// 调大上限后被拒绝（400，常见于输出上限较小的模型）：退回原上限，DeepSeek 系同时关闭思考，再试一次
			if (attempt < maxRetries && error.status === 400 && beforeEscalation && !steppedBack) {
				steppedBack = true;
				activeProfile = withThinkingDisabled(beforeEscalation);
				http = buildAiRequest(activeProfile, prompt);
				continue;
			}

			if (attempt < maxRetries && isRetryable(error)) {
				if (error.code === 'truncated') {
					truncations++;
					beforeEscalation = activeProfile;
					activeProfile = escalateForTruncation(activeProfile, truncations);
					http = buildAiRequest(activeProfile, prompt);
				}
				// 指数退避：1s、2s、4s…（截断不是服务端故障，调大上限后立即重试）
				if (error.code !== 'truncated') await $.sleep(retryDelayMs * Math.pow(2, attempt));
				continue;
			}
			throw error;
		}
	}

	throw lastError || new AiError('network', 'AI 请求失败');
}

/**
 * 连接测试：发一条极短的请求，验证地址 / Key / 模型三者可用
 *
 * 不校验 JSON 结构（只关心「能连上且模型有回复」），失败也不抛异常，便于 UI 直接展示。
 */
export async function probeAiProfile(profile: AiProfile, deps: AiTransportDeps = {}): Promise<AiProbeResult> {
	const invalid = validateAiProfile(profile);
	if (invalid) {
		return { ok: false, code: invalid.code, message: invalid.message };
	}

	const send = deps.send ?? sendOnce;
	const started = Date.now();
	const secrets = [String(profile.apiKey || '')];
	// 用最小 token 与最短提示词，降低成本与延迟。
	// 提示词必须出现 "JSON" 字样：OpenAI / DeepSeek 等开启 JSON 模式时要求消息里提到 json，
	// 否则直接 400，配置正确也会显示「连接失败」。保留 jsonMode 原值，顺带验证该模型是否支持 JSON 模式。
	const probeProfile: AiProfile = { ...profile, maxTokens: 32, retries: 0 };
	const prompt = {
		system: '你是连通性测试助手，只输出一行 JSON，不要输出其他内容。',
		user: '请只输出 JSON：{"answer":"OK"}',
		hasImages: false,
		images: [] as string[]
	};
	const http = buildAiRequest(probeProfile, prompt);

	try {
		const raw = await send(http, Math.max(5000, Math.min(20000, Number(profile.timeoutMs) || 20000)));
		const res = normalizeResponse(raw);
		const latency = Date.now() - started;

		if (res.status < 200 || res.status >= 300) {
			const error = errorFromStatus(res.status, res.responseText, secrets);
			return { ok: false, code: error.code, status: res.status, latency, message: error.message };
		}

		let json: any;
		try {
			json = JSON.parse(res.responseText);
		} catch {
			return {
				ok: false,
				code: 'bad-response',
				status: res.status,
				latency,
				message: `响应不是合法 JSON：${redactSecrets(res.responseText.slice(0, 120), secrets)}`
			};
		}

		// Responses 接口 + 推理模型：32 token 可能全被思考过程用掉，返回 incomplete 且没有正文。
		// 此时地址 / Key / 模型都已验证可用，按连接正常处理并提示调大 token。
		if (
			probeProfile.protocol === 'openai-responses' &&
			!extractApiError(json) &&
			json?.status === 'incomplete' &&
			json?.incomplete_details?.reason === 'max_output_tokens'
		) {
			return {
				ok: true,
				status: res.status,
				latency,
				model: String(profile.model),
				message: '已连通（测试请求的 token 上限太小，推理模型没来得及输出正文；答题时如遇截断请调大「最大回复 token」）'
			};
		}

		const { text } = parseAiResponse(probeProfile, json);
		return {
			ok: true,
			status: res.status,
			latency,
			model: String(profile.model),
			message: `模型回复：${redactSecrets(text.slice(0, 40), secrets)}`
		};
	} catch (err) {
		const error =
			err instanceof AiError
				? err
				: new AiError('network', redactSecrets(String((err as any)?.message || err), secrets));
		return {
			ok: false,
			code: error.code,
			status: error.status,
			latency: Date.now() - started,
			message: error.message
		};
	}
}
