import {
	AI_VENDOR_PRESETS,
	AiProfile,
	AiProtocol,
	findAiVendorPreset,
	isProfileComplete,
	normalizeBaseUrl
} from '@ocsjs/core';
import { CommonProject } from '../../projects/common';

/**
 * AI 题库配置的读取、归一化与校验
 *
 * 与 UI 解耦：本文件不创建 DOM，只负责「存储里的脏数据 → 干净的 AiSettings」。
 * 存储结构见 projects/common.ts 的 common.settings 配置项：
 *   aiEnabled / aiMode / aiActiveProfileId / aiProfiles / aiMaxConcurrency / aiMinConfidence / aiAnswerCache
 */

/** 答题来源合并策略 */
export type AiAnswerMode =
	/** 只用 AI，不请求固定题库 */
	| 'ai'
	/** 先问 AI，AI 没给出可用答案时回退固定题库（默认） */
	| 'ai-first'
	/** 先问固定题库，题库没答案时回退 AI */
	| 'wrappers-first';

export const AI_ANSWER_MODES: [AiAnswerMode, string, string][] = [
	['ai', '仅 AI', '完全不再请求固定题库，只由 AI 作答'],
	['ai-first', 'AI 优先（推荐）', '先问 AI；AI 请求失败或没给出答案时，再回退到已配置的固定题库'],
	['wrappers-first', '固定题库优先', '先查固定题库；题库没搜到答案时，再由 AI 兜底作答']
];

/** 归一化后的 AI 设置 */
export interface AiSettings {
	enabled: boolean;
	mode: AiAnswerMode;
	activeProfileId: string;
	profiles: AiProfile[];
	/** 当前生效的配置（未启用/未选择时为 undefined） */
	activeProfile?: AiProfile;
	maxConcurrency: number;
	/** 低于该置信度视为没有答案（0 表示全部接受） */
	minConfidence: number;
	/** AI 答案是否写入本地题库缓存 */
	answerCache: boolean;
}

const VALID_PROTOCOLS: AiProtocol[] = ['openai', 'openai-responses', 'anthropic', 'gemini'];

/** 生成稳定 id */
export function createProfileId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 归一化单条配置；非法条目返回 undefined（由调用方丢弃） */
export function normalizeProfile(raw: any): AiProfile | undefined {
	if (!raw || typeof raw !== 'object') return undefined;

	const protocol: AiProtocol = VALID_PROTOCOLS.includes(raw.protocol) ? raw.protocol : 'openai';
	const baseUrl = normalizeBaseUrl(String(raw.baseUrl ?? ''));
	const model = String(raw.model ?? '').trim();
	// 名称缺省时用域名/模型兜底，保证列表里可辨认
	const fallbackName = (() => {
		try {
			return new URL(baseUrl).hostname;
		} catch {
			return model || '未命名配置';
		}
	})();

	const profile: AiProfile = {
		id: String(raw.id || createProfileId()),
		name: String(raw.name ?? '').trim() || fallbackName,
		protocol,
		baseUrl,
		apiKey: String(raw.apiKey ?? ''),
		model,
		enabled: raw.enabled !== false
	};

	if (typeof raw.temperature === 'number' && isFinite(raw.temperature)) profile.temperature = raw.temperature;
	if (typeof raw.maxTokens === 'number' && isFinite(raw.maxTokens)) profile.maxTokens = raw.maxTokens;
	if (typeof raw.timeoutMs === 'number' && isFinite(raw.timeoutMs)) profile.timeoutMs = raw.timeoutMs;
	if (typeof raw.retries === 'number' && isFinite(raw.retries)) profile.retries = raw.retries;
	if (typeof raw.vision === 'boolean') profile.vision = raw.vision;
	if (typeof raw.jsonMode === 'boolean') profile.jsonMode = raw.jsonMode;
	if (typeof raw.apiVersion === 'string') profile.apiVersion = raw.apiVersion;
	if (typeof raw.systemPrompt === 'string') profile.systemPrompt = raw.systemPrompt;
	if (typeof raw.homepage === 'string') profile.homepage = raw.homepage;

	// 附加头/附加 body：只接受对象，且值必须可序列化
	if (raw.extraHeaders && typeof raw.extraHeaders === 'object' && !Array.isArray(raw.extraHeaders)) {
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw.extraHeaders)) {
			if (typeof v === 'string' && k.trim()) headers[k.trim()] = v;
		}
		if (Object.keys(headers).length) profile.extraHeaders = headers;
	}
	if (raw.extraBody && typeof raw.extraBody === 'object' && !Array.isArray(raw.extraBody)) {
		profile.extraBody = raw.extraBody as Record<string, any>;
	}

	return profile;
}

/** 归一化配置列表：丢弃非法条目并按 id 去重 */
export function normalizeProfiles(list: any): AiProfile[] {
	if (!Array.isArray(list)) return [];
	const result: AiProfile[] = [];
	const seen = new Set<string>();
	for (const item of list) {
		const profile = normalizeProfile(item);
		if (!profile) continue;
		if (seen.has(profile.id)) profile.id = createProfileId();
		seen.add(profile.id);
		result.push(profile);
	}
	return result;
}

/**
 * 配置是否可用（字段齐全 + 未被停用）
 *
 * 注意：故意不使用 `is` 类型谓词——「不可用」既可能是 undefined 也可能是被停用的配置，
 * 用谓词会让否定分支被收窄成 never，调用方反而拿不到 profile 的字段。
 */
export function isProfileUsable(profile?: AiProfile | null): boolean {
	return !!profile && profile.enabled !== false && isProfileComplete(profile);
}

/** 归一化答题模式 */
export function normalizeMode(mode: any): AiAnswerMode {
	return mode === 'ai' || mode === 'wrappers-first' ? mode : 'ai-first';
}

/** 从全局设置里读取 AI 设置（每次答题实时读取，改配置无需重开 worker） */
export function getAiSettings(): AiSettings {
	// 循环依赖保护：common.ts 与本文件互相 import，这里只在调用期访问 CommonProject
	const cfg: any = CommonProject?.scripts?.settings?.cfg ?? {};
	const profiles = normalizeProfiles(cfg.aiProfiles);
	const activeProfileId = String(cfg.aiActiveProfileId ?? '');
	const activeProfile =
		profiles.find((p) => p.id === activeProfileId) ?? (profiles.length === 1 ? profiles[0] : undefined);

	const maxConcurrency = Math.max(1, Math.min(5, Number(cfg.aiMaxConcurrency) || 2));
	const minConfidence = Math.max(0, Math.min(1, Number(cfg.aiMinConfidence) || 0));

	return {
		enabled: cfg.aiEnabled === true,
		mode: normalizeMode(cfg.aiMode),
		activeProfileId,
		profiles,
		activeProfile,
		maxConcurrency,
		minConfidence,
		answerCache: cfg.aiAnswerCache !== false
	};
}

/** 写入配置列表（UI 保存用） */
export function saveAiProfiles(profiles: AiProfile[], activeProfileId?: string): void {
	CommonProject.scripts.settings.cfg.aiProfiles = profiles as any;
	if (activeProfileId !== undefined) {
		CommonProject.scripts.settings.cfg.aiActiveProfileId = activeProfileId;
	}
}

/** 按预设生成一条新配置（id 自动生成） */
export function createProfileByPresetId(presetId: string): AiProfile | undefined {
	const preset = findAiVendorPreset(presetId);
	if (!preset) return undefined;
	return normalizeProfile({
		id: createProfileId(),
		name: preset.name,
		protocol: preset.protocol,
		baseUrl: preset.baseUrl,
		model: preset.model,
		vision: preset.vision,
		homepage: preset.homepage,
		apiKey: '',
		enabled: true
	});
}

/** 预设列表（UI 下拉用） */
export function getVendorPresets() {
	return AI_VENDOR_PRESETS;
}

/**
 * API Key 脱敏展示：sk-abcd…wxyz
 * 长度不足 12 时全部打码，避免通过展示反推
 */
export function maskApiKey(key?: string): string {
	const value = String(key ?? '');
	if (!value) return '未填写';
	if (value.length < 12) return '***';
	return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

/** 展示用的接口域名 */
export function getProfileHost(profile: AiProfile): string {
	try {
		return new URL(profile.baseUrl).hostname;
	} catch {
		return profile.baseUrl || '未填写地址';
	}
}
