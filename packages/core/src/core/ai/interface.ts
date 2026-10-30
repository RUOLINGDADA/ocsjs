/**
 * AI 题库（AI 答题）类型契约
 *
 * 设计目标：AI 只负责「题目 → 答案」这一步，产出的答案统一为字符串，
 * 交给既有的 resolveSingle / resolveMultiple / resolveJudgement / resolveCompletion 匹配选项。
 * 这样 20+ 个平台脚本、选项匹配算法、结果面板都不需要改动。
 */

/**
 * AI 供应商请求协议
 * - openai：OpenAI 兼容的 /chat/completions
 * - openai-responses：OpenAI 新版 /responses（Responses API）
 * - anthropic：/messages
 * - gemini：/models/{model}:generateContent
 */
export type AiProtocol = 'openai' | 'openai-responses' | 'anthropic' | 'gemini';

/** AI 答题错误码（用于把 HTTP / 解析异常归类成可读提示） */
export type AiErrorCode =
	/** 配置不完整：缺 baseUrl / apiKey / model */
	| 'no-config'
	/** 401 Key 无效 */
	| 'unauthorized'
	/** 403 无权限 / 地区限制 */
	| 'forbidden'
	/** 402 / 429 但余额不足类 */
	| 'insufficient-quota'
	/** 404 接口地址或模型不存在 */
	| 'not-found'
	/** 429 限流 */
	| 'rate-limit'
	/** 5xx 服务端错误 */
	| 'server-error'
	/** 网络错误（DNS / 连接被拒 / CORS 未放行） */
	| 'network'
	/** 超时 */
	| 'timeout'
	/** 响应结构不符合预期 */
	| 'bad-response'
	/** 模型输出无法解析成答案 */
	| 'unparsable'
	/** 响应成功但没有正文（DeepSeek 等在 JSON 模式下偶发） */
	| 'empty'
	/** 没输出答案就用完了回复 token（思考模型的思考过程也计入上限） */
	| 'truncated'
	/** 未支持的能力（如视觉） */
	| 'unsupported';

/** AI 答题异常 */
export class AiError extends Error {
	code: AiErrorCode;
	/** HTTP 状态码（有响应时存在） */
	status?: number;

	constructor(code: AiErrorCode, message: string, status?: number) {
		super(message);
		this.name = 'AiError';
		this.code = code;
		this.status = status;
	}
}

/**
 * AI 供应商配置（一份「可切换的 API 配置」）
 *
 * 注意：apiKey 以明文存放于脚本管理器存储中，与既有题库配置里的 token 同等风险等级，
 * UI 与日志层负责脱敏，核心层不做加密。
 */
export interface AiProfile {
	/** 稳定 id（用于切换与去重） */
	id: string;
	/** 展示名，如「DeepSeek 官方」 */
	name: string;
	/** 请求协议适配器 */
	protocol: AiProtocol;
	/** 接口根地址，可含版本段（如 https://api.deepseek.com/v1），末尾斜杠会被忽略 */
	baseUrl: string;
	apiKey: string;
	model: string;
	/** 采样温度，默认 0（答题场景需要确定性） */
	temperature?: number;
	/** 单次回复上限 token，默认 4096（思考模型的思考过程也计入；被截断时会自动调大重试） */
	maxTokens?: number;
	/** 单次请求超时（毫秒），默认 60000 */
	timeoutMs?: number;
	/** 失败重试次数，默认 2（仅对 429 / 5xx / 网络错误生效） */
	retries?: number;
	/** 是否支持图片输入，默认按预设能力 */
	vision?: boolean;
	/** 是否要求模型输出 JSON（openai 的 response_format），默认 true */
	jsonMode?: boolean;
	/** Azure OpenAI 必填：api-version */
	apiVersion?: string;
	/** 附加请求头（如网关的额外鉴权头） */
	extraHeaders?: Record<string, string>;
	/** 附加请求体字段（如 top_p、enable_thinking 等供应商私有参数） */
	extraBody?: Record<string, any>;
	/** 覆盖默认系统提示词 */
	systemPrompt?: string;
	/** 是否启用（默认 true） */
	enabled?: boolean;
	/** 展示用主页 */
	homepage?: string;
}

/** 供应商预设（用于 UI 预填，不含密钥） */
export interface AiVendorPreset {
	/** 预设 id，同时作为默认 profile 名称来源 */
	id: string;
	name: string;
	protocol: AiProtocol;
	baseUrl: string;
	model: string;
	/** 常用模型列表（UI datalist） */
	models?: string[];
	/** 是否支持图片输入 */
	vision?: boolean;
	homepage?: string;
	/** 补充说明（如 Azure 需替换占位符） */
	note?: string;
}

/** 答题请求上下文（与题库 AnswererWrapper 的 env 同源） */
export interface AiAnswerEnv {
	type?: string;
	title: string;
	/** 选项文本，换行分隔（与 buildAnswererEnv 保持一致） */
	options?: string;
	/** 图片 base64 data URL 数组，顺序对应 [图片1]、[图片2]… */
	images?: string[];
	/** 原题标题中图片 URL 替换为 [图片N] 占位符后的文本 */
	suggestion_title?: string;
	/** 原选项替换后的文本 */
	suggestion_options?: string;
	/** 填空题空数（用于校验 AI 返回的填空数量） */
	blankCount?: number;
	[x: string]: any;
}

/** 一次 AI 作答的结果 */
export interface AiAnswer {
	/** 已规范化的答案串（可直接交给匹配器） */
	answer: string;
	confidence?: number;
	reason?: string;
	/** 实际使用的模型 */
	model: string;
	/** 模型原始文本（截断后保留，便于排查） */
	raw: string;
	usage?: { prompt?: number; completion?: number };
}

/** 提示词组装参数 */
export interface AiPromptOptions {
	/** 覆盖默认系统提示词 */
	systemPrompt?: string;
	/** 是否随请求发送图片（多模态） */
	vision?: boolean;
	/** 题干最大字符数，默认 2000，超出截断 */
	maxTitleChars?: number;
	/** 单个选项最大字符数，默认 500，超出截断 */
	maxOptionChars?: number;
}

/** 提示词组装结果 */
export interface AiPromptResult {
	system: string;
	user: string;
	/** 是否附带图片 */
	hasImages: boolean;
	/** 实际附带的图片 data URL（顺序即 [图片N] 的顺序） */
	images: string[];
}

/** 多模态内容片段 */
export interface AiContentPart {
	type: 'text' | 'image';
	text?: string;
	/** data:image/png;base64,xxx */
	dataUrl?: string;
}

/** 请求组装结果 */
export interface AiHttpRequest {
	url: string;
	method: 'post' | 'get';
	headers: Record<string, string>;
	body: any;
}

/** 连接测试结果 */
export interface AiProbeResult {
	ok: boolean;
	/** 耗时毫秒 */
	latency?: number;
	/** HTTP 状态码 */
	status?: number;
	/** 模型回显（模型自报家门或配置中的模型名） */
	model?: string;
	/** 失败原因（已脱敏） */
	message?: string;
	/** 错误码 */
	code?: AiErrorCode;
}
