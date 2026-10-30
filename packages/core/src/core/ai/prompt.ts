import { AiAnswerEnv, AiPromptOptions, AiPromptResult } from './interface';

/** 题型中文名（用于提示词，未知题型不写死） */
const TYPE_LABEL: Record<string, string> = {
	single: '单选题',
	multiple: '多选题',
	judgement: '判断题',
	completion: '填空题'
};

/** 默认系统提示词 */
export const DEFAULT_AI_SYSTEM_PROMPT = [
	'你是一名严谨的网课答题助手。',
	'你只能依据题目与给定选项作答，不得编造不存在的选项，也不得输出与选项无关的内容。',
	'只输出一行 JSON，不要输出任何解释性文字、不要使用 markdown 代码块。',
	'JSON 格式：{"answer": "答案", "confidence": 0到1之间的小数, "reason": "简短理由"}'
].join('\n');

/** 选项字母表（最多支持 26 个选项，实际试卷极少超过 8 个） */
const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 默认单题最大字符数（超长题目截断，避免 token 爆炸） */
export const DEFAULT_MAX_TITLE_CHARS = 2000;
/** 默认单个选项最大字符数 */
export const DEFAULT_MAX_OPTION_CHARS = 500;

/** 截断字符串并标注 */
function truncate(text: string, max: number): string {
	const value = String(text ?? '');
	if (max <= 0 || value.length <= max) return value;
	return value.slice(0, max) + '…（已截断）';
}

/**
 * 把换行分隔的选项文本拆成数组（与 buildAnswererEnv 的存储格式保持一致）
 * 空行会被过滤，顺序保持不变。
 */
export function splitOptions(options?: string): string[] {
	if (!options) return [];
	return options
		.split('\n')
		.map((o) => o.trim())
		.filter((o) => o.length > 0);
}

/**
 * 组装一次 AI 作答的提示词
 *
 * 纯函数：不读全局配置、不发请求，方便在 Node 下直接单测。
 */
export function buildAiPrompt(env: AiAnswerEnv, opts: AiPromptOptions = {}): AiPromptResult {
	const typeLabel = TYPE_LABEL[env.type || ''] || '未知题型';
	const maxTitleChars = opts.maxTitleChars ?? DEFAULT_MAX_TITLE_CHARS;
	const maxOptionChars = opts.maxOptionChars ?? DEFAULT_MAX_OPTION_CHARS;

	// 题目：优先使用「图片 URL 已替换为 [图片N]」的版本，避免把超长图片地址塞进提示词
	const rawTitle = env.suggestion_title || env.title || '';
	const title = truncate(rawTitle, maxTitleChars);

	// 选项：按行拆分后重新编号，选项文本中自带的前缀由提示词约定让模型忽略
	const optionList = splitOptions(env.suggestion_options || env.options);
	const optionLines = optionList.map((text, i) => `${OPTION_LETTERS[i] || i + 1}. ${truncate(text, maxOptionChars)}`);

	// 图片：仅在开启视觉能力时随请求发送
	const images = opts.vision && Array.isArray(env.images) ? env.images.filter(Boolean).slice(0, 4) : [];
	const hasImages = images.length > 0;

	const blankCount = env.blankCount ?? 0;
	const isCompletion = env.type === 'completion';

	const sections: string[] = [];
	sections.push(`题型：${typeLabel}`);
	sections.push(`题目：${title || '（题目为空）'}`);

	if (optionLines.length) {
		sections.push(['选项：', ...optionLines].join('\n'));
	} else if (!isCompletion) {
		sections.push('选项：（本题无可选项，请直接给出答案文本）');
	}

	if (hasImages) {
		sections.push(
			[
				`本题包含 ${images.length} 张图片，已按顺序附在本条消息中。`,
				'题目与选项中的 [图片1]、[图片2] … 依次对应该顺序的图片，请结合图片内容作答。'
			].join('\n')
		);
	}

	const rules: string[] = ['作答要求：'];
	rules.push('- 单选题：answer 填唯一选项字母，如 "B"');
	rules.push('- 多选题：answer 填全部正确选项字母，按字母升序、不重复，如 "AC"');
	rules.push('- 判断题：answer 填正确选项的字母；若选项为「对/错」「正确/错误」类，也填该选项原文');
	rules.push(
		`- 填空题：answer 按空格顺序用 # 连接${
			blankCount > 0 ? `（本题共 ${blankCount} 个空，必须输出 ${blankCount} 段）` : ''
		}，如 "北京#上海"`
	);
	rules.push('- 若选项文本自带「A.」「①」「（1）」等前缀，请忽略这些前缀，只按上面给出的编号作答');
	rules.push('- 无法确定时仍给出最可能的答案，并把 confidence 调低；不要输出"无法确定"之类的话');
	sections.push(rules.join('\n'));

	return {
		system: opts.systemPrompt?.trim() || DEFAULT_AI_SYSTEM_PROMPT,
		user: sections.join('\n\n'),
		hasImages,
		images
	};
}
