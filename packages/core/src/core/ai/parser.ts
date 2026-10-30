import { AiError } from './interface';
import { classifyJudgement, isJudgementOptions } from '../worker/resolvers/judgement';

/**
 * AI 答案解析
 *
 * 职责：把模型的自由文本（可能带 markdown 围栏、解释、前缀）解析成一个
 * 「既有匹配器能直接吃下」的答案字符串。
 *
 * 设计原则：**宁可不答，不可瞎答**。
 * 校验不通过（字母越界、填空数量不符、完全无法解析）时抛 unparsable，
 * 由上层把该题记为失败，而不是猜一个选项——猜错会污染整份试卷的分数。
 */

/** 解析后的原始答案 */
export interface ParsedAiAnswer {
	answer: string;
	confidence?: number;
	reason?: string;
}

/** 规范化参数 */
export interface NormalizeOptions {
	/** 题型：single / multiple / completion / judgement / 未知 */
	type?: string;
	/** 选项文本数组，顺序即 A、B、C… */
	options?: string[];
	/** 填空题空数：>1 时要求分段数量严格相等 */
	blankCount?: number;
	/** 答案分隔符（取第一个用于拼接多空答案），与全局「答案分隔符」配置一致 */
	separators?: string[];
}

const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 模型可能使用的答案字段名 */
const ANSWER_KEYS = ['answer', 'answers', 'ans', 'result', 'value', '答案'];

/** 模型可能使用的置信度字段名 */
const CONFIDENCE_KEYS = ['confidence', 'score', 'prob', '概率', '置信度'];

/** 模型可能使用的理由字段名 */
const REASON_KEYS = ['reason', 'reasoning', 'explanation', 'why', '理由', '解析'];

/** 取值：按候选键名依次查找 */
function pick(source: any, keys: string[]): any {
	if (!source || typeof source !== 'object') return undefined;
	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(source, key)) {
			const value = source[key];
			if (value !== undefined && value !== null && value !== '') return value;
		}
	}
	return undefined;
}

/** 把任意值转成答案字符串（数组拼接） */
function toAnswerString(value: any): string {
	if (value === undefined || value === null) return '';
	if (Array.isArray(value))
		return value
			.map((v) => String(v ?? '').trim())
			.filter(Boolean)
			.join('');
	return String(value).trim();
}

/** 解析置信度：兼容 0.9 / "0.9" / 90 / "90%" */
function toConfidence(value: any): number | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const num = typeof value === 'number' ? value : parseFloat(String(value).replace('%', ''));
	if (!isFinite(num)) return undefined;
	const normalized = num > 1 ? num / 100 : num;
	return Math.max(0, Math.min(1, normalized));
}

/** 尝试从若干候选片段中解析出 JSON 对象/数组 */
function tryParseJsonCandidates(text: string): any | undefined {
	const candidates: string[] = [text];

	const firstBrace = text.indexOf('{');
	const lastBrace = text.lastIndexOf('}');
	if (firstBrace !== -1 && lastBrace > firstBrace) {
		candidates.push(text.slice(firstBrace, lastBrace + 1));
	}

	const firstBracket = text.indexOf('[');
	const lastBracket = text.lastIndexOf(']');
	if (firstBracket !== -1 && lastBracket > firstBracket) {
		candidates.push(text.slice(firstBracket, lastBracket + 1));
	}

	for (const candidate of candidates) {
		const trimmed = candidate.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && (typeof parsed === 'object' || typeof parsed === 'string')) return parsed;
		} catch {
			// 继续尝试下一个候选
		}
	}
	return undefined;
}

/** 去掉 markdown 代码围栏 */
function stripCodeFence(text: string): string {
	return text
		.replace(/```[a-zA-Z0-9_-]*\s*/g, '')
		.replace(/```/g, '')
		.trim();
}

/** 去掉常见的中文答案前缀与包裹符号 */
function stripAnswerPrefix(text: string): string {
	let value = text.trim();
	// 只取第一行：模型常在第一行给答案，后面跟解释
	const lines = value
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length) value = lines[0];

	value = value
		// 前缀：答案：/ 正确答案是 / 答:
		.replace(/^(?:最终的?|正确的?|本题)?\s*(?:答案|答)\s*(?:是|为)?\s*[:：]?\s*/i, '')
		// 包裹符号（含中文弯引号、“”‘’、书名号等模型常见包裹）
		.replace(/^[「『【[（("'“”‘’《〈`]+/, '')
		.replace(/[」』】\]）)"'“”‘’》〉`]+$/, '')
		.trim();
	return value;
}

/**
 * 解析模型输出的原始文本
 *
 * 依次尝试：JSON 对象/数组 → 宽松文本。
 * 完全无法得到非空答案时抛 AiError('unparsable')。
 */
export function parseAiAnswerText(text: string): ParsedAiAnswer {
	const raw = String(text ?? '').trim();
	if (!raw) {
		throw new AiError('unparsable', '模型返回为空');
	}

	const cleaned = stripCodeFence(raw);
	const json = tryParseJsonCandidates(cleaned);

	if (json && typeof json === 'object') {
		const answerValue = pick(json, ANSWER_KEYS);
		const answer = toAnswerString(answerValue);
		if (answer) {
			return {
				answer,
				confidence: toConfidence(pick(json, CONFIDENCE_KEYS)),
				reason: (() => {
					const reason = pick(json, REASON_KEYS);
					return reason === undefined ? undefined : String(reason).slice(0, 200);
				})()
			};
		}
	}

	// 宽松兜底：去掉围栏与前缀后直接当作答案文本
	const fallback = stripAnswerPrefix(cleaned);
	if (!fallback) {
		throw new AiError('unparsable', '模型返回中找不到答案');
	}
	return { answer: fallback };
}

/** 提取答案中的选项字母序列（仅接受「纯字母 + 分隔符」形态） */
export function extractLetters(answer: string): string[] | undefined {
	const value = String(answer ?? '')
		.trim()
		.replace(/\s+/g, '');
	if (!value) return undefined;

	// 纯字母：A / AC / A,C / A、C / A-C
	if (/^[A-Za-z](?:[,，、;；/#|+-]?[A-Za-z])*$/.test(value)) {
		return value
			.replace(/[^A-Za-z]/g, '')
			.toUpperCase()
			.split('');
	}

	// 形如「选项A」「选A」「A项」：取首个字母
	const prefixed = value.match(/^(?:选项|选|第)?([A-Za-z])(?:项|选项)?$/);
	if (prefixed) return [prefixed[1].toUpperCase()];

	return undefined;
}

/** 校验字母是否落在选项范围内 */
function assertLettersInRange(letters: string[], options: string[]): void {
	for (const letter of letters) {
		const index = letter.charCodeAt(0) - 65;
		if (index < 0 || index >= options.length) {
			throw new AiError('unparsable', `AI 答案字母 ${letter} 超出选项范围（本题共 ${options.length} 个选项）`);
		}
	}
}

/**
 * 判断题：把 AI 给的答案映射到具体选项原文
 *
 * `resolveJudgement` 只按「对/正确/错/错误」这类词比对选项文本，不认字母，
 * 所以这里必须把字母转成选项原文，并把「对」这类同义词映射到选项的实际写法（如「√」）。
 */
function resolveJudgementOption(answer: string, options: string[]): string {
	const letters = extractLetters(answer);
	if (letters && letters.length) {
		assertLettersInRange(letters, options);
		return options[letters[0].charCodeAt(0) - 65];
	}

	const answerClass = classifyJudgement(answer);
	if (answerClass) {
		const matched = options.find((option) => classifyJudgement(option) === answerClass);
		if (matched) return matched;
	}

	// 最后兜底：原样返回，交给相似度匹配
	return answer;
}

/** 填空答案切分 */
function splitBlanks(answer: string, separators?: string[]): string[] {
	const seps = (separators?.length ? separators : ['#', '｜', '|']).filter((s) => s && s.trim().length > 0);
	let parts: string[] = [];
	for (const sep of seps) {
		if (answer.includes(sep)) {
			parts = answer.split(sep);
			break;
		}
	}
	if (parts.length === 0) {
		// 没有分隔符时按换行切（模型偶尔一段一行）
		parts = answer.includes('\n') ? answer.split('\n') : [answer];
	}
	return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * 把解析结果规范化成既有匹配器可用的答案字符串
 *
 * @throws AiError('unparsable') 当答案无法安全地映射到题目时
 */
export function normalizeAiAnswer(parsed: ParsedAiAnswer | string, opts: NormalizeOptions = {}): string {
	const answer = (typeof parsed === 'string' ? parsed : parsed.answer || '').trim();
	if (!answer) {
		throw new AiError('unparsable', '模型返回的答案为空');
	}

	const options = Array.isArray(opts.options) ? opts.options : [];

	// 有效题型：题目本身是单选题但选项是「对/错」两态时，按判断题处理（与 question.resolver 行为一致）
	let type = opts.type;
	if (type === 'single' && options.length === 2 && isJudgementOptions(options)) {
		type = 'judgement';
	}

	switch (type) {
		case 'judgement': {
			if (options.length === 0) return answer;
			return resolveJudgementOption(answer, options);
		}

		case 'multiple': {
			const letters = extractLetters(answer);
			if (letters && letters.length && options.length) {
				assertLettersInRange(letters, options);
				const unique = Array.from(new Set(letters)).sort();
				return unique.join('');
			}
			// 模型直接给了选项原文（可能用分隔符连接）：交给匹配器做归一化/相似度匹配
			return answer;
		}

		case 'completion': {
			const parts = splitBlanks(answer, opts.separators);
			if (parts.length === 0) {
				throw new AiError('unparsable', '填空答案为空');
			}
			const blankCount = opts.blankCount ?? 0;
			if (blankCount > 1) {
				if (parts.length !== blankCount) {
					throw new AiError('unparsable', `填空答案数量不符（本题 ${blankCount} 个空，AI 给了 ${parts.length} 段）`);
				}
				const joiner = (opts.separators?.find((s) => s && s.trim()) || '#').trim();
				return parts.join(joiner);
			}
			// 单空：多段合并为一句
			return parts.join(' ');
		}

		case 'single': {
			const letters = extractLetters(answer);
			if (letters && letters.length && options.length) {
				assertLettersInRange(letters, options);
				// 单选只取第一个字母
				return letters[0];
			}
			return answer;
		}

		default: {
			// 未知题型：能提取字母就取首字母，否则原样返回
			const letters = extractLetters(answer);
			if (letters && letters.length && options.length) {
				assertLettersInRange(letters, options);
				return letters[0];
			}
			return answer;
		}
	}
}

/** 一次性完成「解析 + 规范化」，供上层直接使用 */
export function toMatcherAnswer(
	text: string,
	opts: NormalizeOptions
): { answer: string; confidence?: number; reason?: string } {
	const parsed = parseAiAnswerText(text);
	const answer = normalizeAiAnswer(parsed, opts);
	return { answer, confidence: parsed.confidence, reason: parsed.reason };
}

/** 选项字母序号 → 选项文本（越界返回 undefined） */
export function letterToOption(letter: string, options: string[]): string | undefined {
	const index =
		String(letter || '')
			.toUpperCase()
			.charCodeAt(0) - 65;
	if (index < 0 || index >= options.length) return undefined;
	return options[index];
}

/** 选项序号 → 字母（超出 26 返回 undefined） */
export function optionIndexToLetter(index: number): string | undefined {
	return OPTION_LETTERS[index];
}
