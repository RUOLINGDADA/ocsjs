/**
 * 轻量哈希工具
 *
 * 用于生成「题库配置签名」与「题目缓存签名」，只做相等比较，不需要密码学强度。
 * FNV-1a 32bit：实现短、无依赖、分布够用。
 */

/** FNV-1a 32bit 哈希（返回 16 进制字符串） */
export function fnv1a32(input: string): string {
	const content = String(input ?? '');
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i++) {
		hash ^= content.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

/** 文本归一化：合并空白，去掉首尾空格（避免渲染差异导致哈希不一致） */
function normalizeText(value?: string): string {
	return String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * 题目缓存签名
 *
 * 同一道题在不同作业里选项可能不同（如"以下哪个正确"配不同选项组），
 * 只按题干匹配会命中错误答案，因此签名必须包含选项与题型。
 */
export function createQuestionHash(title: string, options?: string, type?: string): string {
	return fnv1a32([normalizeText(title), normalizeText(options), String(type ?? '')].join('\u0000'));
}
