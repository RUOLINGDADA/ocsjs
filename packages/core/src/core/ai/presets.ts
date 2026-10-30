import { AiVendorPreset } from './interface';

/**
 * 供应商预设表（不含密钥，仅供 UI 预填）
 *
 * 只收录「按公开文档可确定」的协议与地址；不确定的一律归入「自定义（OpenAI 兼容）」，
 * 避免给出错误默认值导致用户以为配置无效。
 *
 * 说明：
 * - 绝大多数国内/第三方网关都提供 OpenAI 兼容的 /chat/completions，故协议统一为 openai；
 * - Anthropic / Gemini 的请求与响应结构差异较大，单独走各自适配器；
 * - 本地推理（Ollama / LM Studio / OneAPI 等）地址在 @connect 白名单内（localhost / 127.0.0.1）。
 */
export const AI_VENDOR_PRESETS: AiVendorPreset[] = [
	{
		id: 'deepseek',
		name: 'DeepSeek 官方',
		protocol: 'openai',
		baseUrl: 'https://api.deepseek.com/v1',
		model: 'deepseek-chat',
		models: ['deepseek-chat', 'deepseek-reasoner'],
		vision: false,
		homepage: 'https://platform.deepseek.com'
	},
	{
		id: 'openai',
		name: 'OpenAI',
		protocol: 'openai',
		baseUrl: 'https://api.openai.com/v1',
		model: 'gpt-4o-mini',
		models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
		vision: true,
		homepage: 'https://platform.openai.com'
	},
	{
		id: 'moonshot',
		name: 'Moonshot Kimi',
		protocol: 'openai',
		baseUrl: 'https://api.moonshot.cn/v1',
		model: 'moonshot-v1-8k',
		models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-latest'],
		vision: false,
		homepage: 'https://platform.moonshot.cn'
	},
	{
		id: 'zhipu',
		name: '智谱 GLM',
		protocol: 'openai',
		baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
		model: 'glm-4-flash',
		models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus', 'glm-4v-flash'],
		vision: true,
		homepage: 'https://open.bigmodel.cn'
	},
	{
		id: 'dashscope',
		name: '通义千问（DashScope 兼容模式）',
		protocol: 'openai',
		baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		model: 'qwen-plus',
		models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-vl-plus'],
		vision: true,
		homepage: 'https://dashscope.console.aliyun.com'
	},
	{
		id: 'siliconflow',
		name: '硅基流动 SiliconFlow',
		protocol: 'openai',
		baseUrl: 'https://api.siliconflow.cn/v1',
		model: 'Qwen/Qwen2.5-7B-Instruct',
		models: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'],
		vision: false,
		homepage: 'https://cloud.siliconflow.cn'
	},
	{
		id: 'openrouter',
		name: 'OpenRouter',
		protocol: 'openai',
		baseUrl: 'https://openrouter.ai/api/v1',
		model: 'openai/gpt-4o-mini',
		models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-flash-1.5'],
		vision: true,
		homepage: 'https://openrouter.ai'
	},
	{
		id: 'groq',
		name: 'Groq',
		protocol: 'openai',
		baseUrl: 'https://api.groq.com/openai/v1',
		model: 'llama-3.3-70b-versatile',
		models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
		vision: false,
		homepage: 'https://console.groq.com'
	},
	{
		id: 'anthropic',
		name: 'Anthropic Claude',
		protocol: 'anthropic',
		baseUrl: 'https://api.anthropic.com/v1',
		model: 'claude-3-5-sonnet-latest',
		models: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'],
		vision: true,
		homepage: 'https://console.anthropic.com'
	},
	{
		id: 'gemini',
		name: 'Google Gemini',
		protocol: 'gemini',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
		model: 'gemini-1.5-flash',
		models: ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
		vision: true,
		homepage: 'https://aistudio.google.com'
	},
	{
		id: 'azure-openai',
		name: 'Azure OpenAI',
		protocol: 'openai',
		baseUrl: 'https://你的资源名.openai.azure.com/openai/deployments/你的部署名',
		model: '你的部署名',
		vision: true,
		homepage: 'https://portal.azure.com',
		note: '需把 baseUrl 中的「你的资源名」「你的部署名」替换为实际值，并在 apiVersion 填接口版本（如 2024-06-01）'
	},
	{
		id: 'ollama',
		name: 'Ollama（本地）',
		protocol: 'openai',
		baseUrl: 'http://127.0.0.1:11434/v1',
		model: 'qwen2.5:7b',
		models: ['qwen2.5:7b', 'llama3.1:8b', 'deepseek-r1:7b'],
		vision: false,
		note: '本地模型需先在 Ollama 中 pull；Key 可填任意非空字符串（如 ollama）'
	},
	{
		id: 'lmstudio',
		name: 'LM Studio（本地）',
		protocol: 'openai',
		baseUrl: 'http://127.0.0.1:1234/v1',
		model: 'local-model',
		vision: false,
		note: '需在 LM Studio 中开启本地服务；Key 可填任意非空字符串'
	},
	{
		id: 'custom',
		name: '自定义（OpenAI 兼容）',
		protocol: 'openai',
		baseUrl: '',
		model: '',
		vision: false,
		note: 'OneAPI / NewAPI / 各类中转网关请选此项，自行填写 baseUrl（一般以 /v1 结尾）与模型名'
	}
];

/** 按 id 查找预设 */
export function findAiVendorPreset(id: string): AiVendorPreset | undefined {
	return AI_VENDOR_PRESETS.find((p) => p.id === id);
}
