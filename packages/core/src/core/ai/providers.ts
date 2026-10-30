import { AiError, AiHttpRequest, AiProfile, AiPromptResult } from './interface';

/**
 * 供应商协议适配器
 *
 * 把「同一个提问」翻译成各协议（OpenAI 兼容 / OpenAI Responses / Anthropic / Gemini）的请求，
 * 并把各协议的响应翻译回纯文本。
 * 全部为纯函数：不读全局状态、不发请求，便于单测。
 *
 * 安全约定：apiKey 只出现在请求头中，绝不拼进 URL
 * （脚本的「请求记录」面板会展示 URL，拼进 URL 等于把密钥写进日志）。
 */

/** 去掉末尾斜杠，空值归一为空串 */
export function normalizeBaseUrl(baseUrl: string): string {
	return String(baseUrl || '')
		.trim()
		.replace(/\/+$/, '');
}

/** 是否为 Azure OpenAI 端点（鉴权头与 api-version 处理不同） */
export function isAzureProfile(profile: Pick<AiProfile, 'baseUrl'>): boolean {
	try {
		return new URL(normalizeBaseUrl(profile.baseUrl)).hostname.endsWith('.openai.azure.com');
	} catch {
		return false;
	}
}

/** 解析 data URL：data:image/png;base64,xxxx */
export function parseDataUrl(dataUrl: string): { mime: string; base64: string } | undefined {
	const match = String(dataUrl || '').match(/^data:([^;,]+).*?;base64,(.*)$/s);
	if (!match) return undefined;
	return { mime: match[1], base64: match[2] };
}

/** 组装请求公共字段（Content-Type + 附件请求头） */
function baseHeaders(profile: AiProfile): Record<string, string> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	for (const [k, v] of Object.entries(profile.extraHeaders || {})) {
		if (typeof v === 'string' && v) headers[k] = v;
	}
	return headers;
}

/** 取温度默认值：答题场景默认 0，保证同样输入得到同样输出 */
function temperatureOf(profile: AiProfile): number {
	return typeof profile.temperature === 'number' ? profile.temperature : 0;
}

/** 默认回复上限：思考模型（DeepSeek V4 默认开启思考）1024 经常不够用 */
export const DEFAULT_AI_MAX_TOKENS = 4096;
/** 自动调大时的上限 */
export const MAX_AI_MAX_TOKENS = 32768;

/** 取回复上限默认值 */
function maxTokensOf(profile: AiProfile): number {
	const value = typeof profile.maxTokens === 'number' ? profile.maxTokens : DEFAULT_AI_MAX_TOKENS;
	return Math.max(16, Math.min(MAX_AI_MAX_TOKENS, Math.floor(value)));
}

/**
 * 合并「附加请求体」
 * 值为 null 的字段会从请求体中删除，用于去掉默认字段
 * （如推理模型不支持 temperature 时填 {"temperature": null}）。
 */
function mergeExtraBody(body: Record<string, any>, extraBody?: Record<string, any>): void {
	for (const [key, value] of Object.entries(extraBody || {})) {
		if (value === null) {
			delete body[key];
		} else {
			body[key] = value;
		}
	}
}

/**
 * OpenAI 兼容协议（含 Azure OpenAI、各类 /v1/chat/completions 网关）
 */
function buildOpenAiRequest(profile: AiProfile, prompt: AiPromptResult): AiHttpRequest {
	const base = normalizeBaseUrl(profile.baseUrl);
	const azure = isAzureProfile(profile);
	const headers = baseHeaders(profile);

	let url = base + '/chat/completions';
	if (azure) {
		headers['api-key'] = profile.apiKey;
		const apiVersion = String(profile.apiVersion || '2024-06-01').trim();
		url += `?api-version=${encodeURIComponent(apiVersion)}`;
	} else {
		headers.Authorization = `Bearer ${profile.apiKey}`;
	}

	const userContent = prompt.hasImages
		? [
				{ type: 'text', text: prompt.user },
				...prompt.images.map((dataUrl) => ({ type: 'image_url', image_url: { url: dataUrl } }))
		  ]
		: prompt.user;

	const body: Record<string, any> = {
		model: profile.model,
		messages: [
			{ role: 'system', content: prompt.system },
			{ role: 'user', content: userContent }
		],
		temperature: temperatureOf(profile),
		max_tokens: maxTokensOf(profile),
		stream: false
	};
	// 部分推理模型（如 deepseek-reasoner）不接受 response_format，可由 profile.jsonMode 关闭
	if (profile.jsonMode !== false) {
		body.response_format = { type: 'json_object' };
	}
	// 部分新版模型用 max_completion_tokens 取代 max_tokens，可通过 extraBody 覆盖
	// （如 {"max_completion_tokens": 1024, "max_tokens": null}）
	mergeExtraBody(body, profile.extraBody);

	return { url, method: 'post', headers, body };
}

/**
 * OpenAI Responses 协议（POST {baseUrl}/responses）
 * 文档要点：系统提示词放 instructions，题目放 input；回复上限是 max_output_tokens（推理模型的思考 token 也计入）；
 * JSON 模式写在 text.format；store:false 让服务端不保存本次请求。
 * Azure：新版 /openai/v1 端点不需要 api-version，旧版 /openai 端点需要，填了才拼进 URL。
 */
function buildOpenAiResponsesRequest(profile: AiProfile, prompt: AiPromptResult): AiHttpRequest {
	const base = normalizeBaseUrl(profile.baseUrl);
	const headers = baseHeaders(profile);

	let url = base + '/responses';
	if (isAzureProfile(profile)) {
		headers['api-key'] = profile.apiKey;
		const apiVersion = String(profile.apiVersion || '').trim();
		if (apiVersion) {
			url += `?api-version=${encodeURIComponent(apiVersion)}`;
		}
	} else {
		headers.Authorization = `Bearer ${profile.apiKey}`;
	}

	const content: any[] = [{ type: 'input_text', text: prompt.user }];
	for (const dataUrl of prompt.images) {
		content.push({ type: 'input_image', image_url: dataUrl });
	}

	const body: Record<string, any> = {
		model: profile.model,
		instructions: prompt.system,
		input: [{ role: 'user', content }],
		temperature: temperatureOf(profile),
		max_output_tokens: maxTokensOf(profile),
		store: false,
		stream: false
	};
	if (profile.jsonMode !== false) {
		body.text = { format: { type: 'json_object' } };
	}
	// 推理模型（o 系列 / GPT-5 等）不支持 temperature 时，可在附加请求体里填 {"temperature": null} 去掉
	mergeExtraBody(body, profile.extraBody);

	return { url, method: 'post', headers, body };
}

/**
 * Anthropic Messages 协议
 * 文档要点：system 是顶层字段，max_tokens 必填，x-api-key 鉴权，anthropic-version 必填。
 */
function buildAnthropicRequest(profile: AiProfile, prompt: AiPromptResult): AiHttpRequest {
	const base = normalizeBaseUrl(profile.baseUrl);
	const headers = baseHeaders(profile);
	headers['x-api-key'] = profile.apiKey;
	headers['anthropic-version'] = '2023-06-01';
	// 浏览器环境下直连需要该头；经 GM_xmlhttpRequest 发送时无害
	headers['anthropic-dangerous-direct-browser-access'] = 'true';

	const content: any[] = [{ type: 'text', text: prompt.user }];
	for (const dataUrl of prompt.images) {
		const parsed = parseDataUrl(dataUrl);
		if (!parsed) continue;
		content.push({
			type: 'image',
			source: { type: 'base64', media_type: parsed.mime, data: parsed.base64 }
		});
	}

	const body: Record<string, any> = {
		model: profile.model,
		max_tokens: maxTokensOf(profile),
		temperature: temperatureOf(profile),
		system: prompt.system,
		messages: [{ role: 'user', content }],
		stream: false
	};
	mergeExtraBody(body, profile.extraBody);

	return { url: base + '/messages', method: 'post', headers, body };
}

/**
 * Google Gemini generateContent 协议
 * 文档要点：Key 走 x-goog-api-key 头（不拼进 URL），system 用 systemInstruction，图片用 inline_data。
 */
function buildGeminiRequest(profile: AiProfile, prompt: AiPromptResult): AiHttpRequest {
	const base = normalizeBaseUrl(profile.baseUrl);
	const headers = baseHeaders(profile);
	headers['x-goog-api-key'] = profile.apiKey;

	const parts: any[] = [{ text: prompt.user }];
	for (const dataUrl of prompt.images) {
		const parsed = parseDataUrl(dataUrl);
		if (!parsed) continue;
		parts.push({ inline_data: { mime_type: parsed.mime, data: parsed.base64 } });
	}

	const generationConfig: Record<string, any> = {
		temperature: temperatureOf(profile),
		maxOutputTokens: maxTokensOf(profile),
		responseMimeType: profile.jsonMode === false ? 'text/plain' : 'application/json'
	};

	const body: Record<string, any> = {
		systemInstruction: { parts: [{ text: prompt.system }] },
		contents: [{ role: 'user', parts }],
		generationConfig
	};
	mergeExtraBody(body, profile.extraBody);

	const model = String(profile.model || '').replace(/^models\//, '');
	return {
		url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
		method: 'post',
		headers,
		body
	};
}

/** 组装请求：按协议分发 */
export function buildAiRequest(profile: AiProfile, prompt: AiPromptResult): AiHttpRequest {
	switch (profile.protocol) {
		case 'anthropic':
			return buildAnthropicRequest(profile, prompt);
		case 'gemini':
			return buildGeminiRequest(profile, prompt);
		case 'openai-responses':
			return buildOpenAiResponsesRequest(profile, prompt);
		case 'openai':
		default:
			return buildOpenAiRequest(profile, prompt);
	}
}

/** 从任意协议的响应里抽取供应商报错信息 */
export function extractApiError(json: any): string | undefined {
	if (!json || typeof json !== 'object') return undefined;
	const err = json.error;
	if (!err) return undefined;
	if (typeof err === 'string') return err;
	if (typeof err.message === 'string') return err.message;
	try {
		return JSON.stringify(err).slice(0, 300);
	} catch {
		return '未知错误';
	}
}

const EMPTY_MESSAGE = '模型返回了空内容';
const TRUNCATED_MESSAGE = '模型还没给出答案就用完了「最大回复 token」（思考过程也计入上限）';

/**
 * 正文为空时，从思考内容末尾找答案 JSON。
 * 部分网关（如 vLLM 的 deepseek_v4 解析器）在模型漏掉结束标记时会把整段回答放进 reasoning_content。
 */
function answerFromReasoning(reasoning: unknown): string {
	const text = typeof reasoning === 'string' ? reasoning : '';
	if (!text) return '';
	const matches = text.match(/\{[^{}]*"answer"[^{}]*\}/g);
	return matches ? matches[matches.length - 1] : '';
}

/** 统一的响应解析结果 */
export interface AiResponseText {
	text: string;
	usage?: { prompt?: number; completion?: number };
	/** 回复因达到 token 上限被截断（正文可能只有半截） */
	truncated?: boolean;
}

/**
 * 解析响应体，取出模型正文
 * 结构不符时抛 AiError('bad-response')，由上层归为「该题失败」。
 */
export function parseAiResponse(profile: AiProfile, json: any): AiResponseText {
	const apiError = extractApiError(json);
	if (apiError) {
		throw new AiError('bad-response', apiError);
	}

	switch (profile.protocol) {
		case 'anthropic': {
			const parts: any[] = Array.isArray(json?.content) ? json.content : [];
			const text = parts
				.filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
				.map((p) => String(p.text ?? ''))
				.join('')
				.trim();
			if (!text) {
				if (json?.stop_reason === 'max_tokens') throw new AiError('truncated', TRUNCATED_MESSAGE);
				if (json?.stop_reason === 'refusal') throw new AiError('bad-response', '模型拒绝作答');
				throw new AiError('empty', EMPTY_MESSAGE);
			}
			return {
				text,
				usage: { prompt: json?.usage?.input_tokens, completion: json?.usage?.output_tokens },
				truncated: json?.stop_reason === 'max_tokens'
			};
		}
		case 'gemini': {
			const blocked = json?.promptFeedback?.blockReason;
			if (blocked) throw new AiError('bad-response', `内容被安全策略拦截：${blocked}`);
			const parts: any[] = json?.candidates?.[0]?.content?.parts || [];
			const text = parts
				.map((p) => String(p?.text ?? ''))
				.join('')
				.trim();
			if (!text) {
				const reason = json?.candidates?.[0]?.finishReason;
				if (reason === 'MAX_TOKENS') throw new AiError('truncated', TRUNCATED_MESSAGE);
				if (reason === 'SAFETY') throw new AiError('bad-response', '内容被安全策略拦截');
				throw new AiError('empty', EMPTY_MESSAGE);
			}
			return {
				text,
				usage: {
					prompt: json?.usageMetadata?.promptTokenCount,
					completion: json?.usageMetadata?.candidatesTokenCount
				},
				truncated: json?.candidates?.[0]?.finishReason === 'MAX_TOKENS'
			};
		}
		case 'openai-responses': {
			// 优先用 output_text（官方接口与多数网关会带上），否则从 output[].content[] 中拼出 output_text 片段
			let text = typeof json?.output_text === 'string' ? json.output_text : '';
			const refusals: string[] = [];
			if (!text.trim()) {
				text = '';
				const items: any[] = Array.isArray(json?.output) ? json.output : [];
				for (const item of items) {
					// 推理模型会先输出 type=reasoning 的条目，只取 message 里的正文
					if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
					for (const part of item.content) {
						if (part?.type === 'output_text' && typeof part.text === 'string') {
							text += part.text;
						} else if (part?.type === 'refusal' && typeof part.refusal === 'string') {
							refusals.push(part.refusal);
						}
					}
				}
			}
			text = text.trim();
			if (!text) {
				if (refusals.length) {
					throw new AiError('bad-response', `模型拒绝作答：${refusals.join(' ').slice(0, 200)}`);
				}
				if (json?.status === 'incomplete') {
					const reason = json?.incomplete_details?.reason;
					if (reason === 'max_output_tokens') {
						throw new AiError('truncated', TRUNCATED_MESSAGE);
					}
					throw new AiError('bad-response', `回复不完整（${reason || '未知原因'}）`);
				}
				throw new AiError('empty', EMPTY_MESSAGE);
			}
			return {
				text,
				usage: { prompt: json?.usage?.input_tokens, completion: json?.usage?.output_tokens },
				truncated: json?.status === 'incomplete' && json?.incomplete_details?.reason === 'max_output_tokens'
			};
		}
		case 'openai':
		default: {
			const choice = json?.choices?.[0];
			const content = choice?.message?.content;
			let text = '';
			if (typeof content === 'string') {
				text = content;
			} else if (Array.isArray(content)) {
				text = content.map((p: any) => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('');
			} else if (typeof choice?.text === 'string') {
				// 部分旧网关返回 choices[0].text
				text = choice.text;
			}
			text = text.trim();
			if (!text) {
				if (choice?.finish_reason === 'length') throw new AiError('truncated', TRUNCATED_MESSAGE);
				if (typeof choice?.message?.refusal === 'string' && choice.message.refusal) {
					throw new AiError('bad-response', `模型拒绝作答：${String(choice.message.refusal).slice(0, 200)}`);
				}
				text = answerFromReasoning(choice?.message?.reasoning_content ?? choice?.message?.reasoning);
				if (!text) throw new AiError('empty', EMPTY_MESSAGE);
			}
			return {
				text,
				usage: { prompt: json?.usage?.prompt_tokens, completion: json?.usage?.completion_tokens },
				truncated: choice?.finish_reason === 'length'
			};
		}
	}
}
