/**
 * AI 题库核心模块单测（不联网）
 *
 * 运行：npx tsx tests/ai-answerer.test.ts
 *
 * 重点关注三件事：
 * 1. 提示词组装是否符合预期（含图片、填空题空数）；
 * 2. 模型输出能否被安全地规范化成「匹配器可用的答案」，且异常情况**拒绝作答**而不是瞎猜；
 * 3. 规范化后的答案喂给既有 resolve* 匹配器，确实能选中目标选项（端到端回归）。
 */

import { buildAiPrompt, DEFAULT_AI_SYSTEM_PROMPT } from '../packages/core/src/core/ai/prompt';
import {
	parseAiAnswerText,
	normalizeAiAnswer,
	extractLetters,
	toMatcherAnswer
} from '../packages/core/src/core/ai/parser';
import {
	buildAiRequest,
	parseAiResponse,
	normalizeBaseUrl,
	isAzureProfile
} from '../packages/core/src/core/ai/providers';
import { askAi, probeAiProfile, redactSecrets, validateAiProfile } from '../packages/core/src/core/ai/transport';
import { createAiSearchInformation, aiAnswererHandler } from '../packages/core/src/core/ai/answerer';
import { AiError, AiProfile } from '../packages/core/src/core/ai/interface';
import { resolveSingle } from '../packages/core/src/core/worker/resolvers/single';
import { resolveMultiple } from '../packages/core/src/core/worker/resolvers/multiple';
import { resolveJudgement } from '../packages/core/src/core/worker/resolvers/judgement';
import { resolveCompletion } from '../packages/core/src/core/worker/resolvers/completion';
import { createQuestionHash, fnv1a32 } from '../packages/scripts/src/utils/hash';

// ========== 极简断言 ==========

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: any) {
	if (cond) {
		passed++;
		return;
	}
	failures.push(`${name}${detail === undefined ? '' : ' -> ' + JSON.stringify(detail)}`);
	console.error(`❌ ${name}`, detail === undefined ? '' : detail);
}

function eq(name: string, actual: any, expected: any) {
	check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/** 断言抛出指定错误码的 AiError */
function throwsCode(name: string, fn: () => any, code: string) {
	try {
		fn();
		check(name + '（应当抛错）', false, 'no throw');
	} catch (err) {
		const actual = err instanceof AiError ? err.code : 'not-AiError:' + String(err);
		check(name, actual === code, { actual, expected: code });
	}
}

// ========== 1. 提示词 ==========

function testPrompt() {
	const single = buildAiPrompt({
		type: 'single',
		title: '中华人民共和国成立于哪一年？',
		options: '1949年\n1950年\n1911年'
	});
	check('单选题型标注', single.user.includes('单选题'), single.user);
	check('选项按字母编号', single.user.includes('A. 1949年') && single.user.includes('C. 1911年'), single.user);
	check('包含单选作答规则', single.user.includes('唯一选项字母'), single.user);
	check('默认系统提示词', single.system === DEFAULT_AI_SYSTEM_PROMPT, single.system);
	check('无图片时不标记 hasImages', single.hasImages === false, single);

	const completion = buildAiPrompt({ type: 'completion', title: '中国的首都是____', blankCount: 2 });
	check('填空题空数写入提示词', completion.user.includes('共 2 个空'), completion.user);
	check('填空题无选项时不写选项块', !completion.user.includes('选项：'), completion.user);

	const withImage = buildAiPrompt(
		{
			type: 'single',
			title: '看图选择 [图片1]',
			options: 'A图\nB图',
			images: ['data:image/png;base64,AAA'],
			suggestion_title: '看图选择 [图片1]'
		},
		{ vision: true }
	);
	check('视觉开启时附带图片', withImage.hasImages === true && withImage.images.length === 1, withImage);

	const noVision = buildAiPrompt(
		{ type: 'single', title: '看图选择 [图片1]', options: 'A图\nB图', images: ['data:image/png;base64,AAA'] },
		{ vision: false }
	);
	check('视觉关闭时丢弃图片', noVision.hasImages === false && noVision.images.length === 0, noVision);

	const longTitle = 'x'.repeat(3000);
	const truncated = buildAiPrompt({ type: 'single', title: longTitle, options: 'a\nb' }, { maxTitleChars: 100 });
	check('超长题干被截断', truncated.user.includes('已截断'), truncated.user.length);

	const customSystem = buildAiPrompt({ type: 'single', title: 't', options: 'a\nb' }, { systemPrompt: '自定义系统词' });
	eq('自定义系统提示词生效', customSystem.system, '自定义系统词');
}

// ========== 2. 输出解析 ==========

function testParse() {
	eq('纯 JSON', parseAiAnswerText('{"answer":"B","confidence":0.9,"reason":"因为…"}'), {
		answer: 'B',
		confidence: 0.9,
		reason: '因为…'
	});

	eq('代码围栏 JSON', parseAiAnswerText('```json\n{"answer":"AC"}\n```').answer, 'AC');

	eq('前后带解释的 JSON', parseAiAnswerText('好的，分析如下：{"answer":"A"} 以上。').answer, 'A');

	eq('数组答案拼接', parseAiAnswerText('{"answer":["A","C"]}').answer, 'AC');

	eq('置信度百分比', parseAiAnswerText('{"answer":"A","confidence":85}').confidence, 0.85);

	eq('纯文本兜底', parseAiAnswerText('B').answer, 'B');

	eq('带「答案：」前缀的兜底', parseAiAnswerText('答案：C').answer, 'C');

	eq('引号包裹的兜底', parseAiAnswerText('“对”').answer, '对');

	throwsCode('空响应', () => parseAiAnswerText('   '), 'unparsable');

	eq('字母提取：AC', extractLetters('AC'), ['A', 'C']);
	eq('字母提取：A,C', extractLetters('A,C'), ['A', 'C']);
	eq('字母提取：A、C', extractLetters('A、C'), ['A', 'C']);
	eq('字母提取：选项A', extractLetters('选项A'), ['A']);
	eq('字母提取：中文非字母', extractLetters('北京'), undefined);
}

// ========== 3. 规范化 ==========

function testNormalize() {
	const options3 = ['正确选项', '错误选项一', '错误选项二'];

	eq('单选字母', normalizeAiAnswer({ answer: 'A' }, { type: 'single', options: options3 }), 'A');
	eq('单选多字母只取首个', normalizeAiAnswer({ answer: 'AC' }, { type: 'single', options: options3 }), 'A');
	eq('单选选项原文透传', normalizeAiAnswer({ answer: '正确选项' }, { type: 'single', options: options3 }), '正确选项');
	throwsCode(
		'单选字母越界拒绝',
		() => normalizeAiAnswer({ answer: 'E' }, { type: 'single', options: options3 }),
		'unparsable'
	);

	eq('多选去重升序', normalizeAiAnswer({ answer: 'C,A,A' }, { type: 'multiple', options: options3 }), 'AC');
	eq('多选中文分隔', normalizeAiAnswer({ answer: 'A、B' }, { type: 'multiple', options: options3 }), 'AB');
	throwsCode(
		'多选字母越界拒绝',
		() => normalizeAiAnswer({ answer: 'AD' }, { type: 'multiple', options: options3 }),
		'unparsable'
	);

	// 判断题：字母要映射成选项原文（resolveJudgement 不认字母）
	eq(
		'判断字母→选项原文（对/错）',
		normalizeAiAnswer({ answer: 'A' }, { type: 'judgement', options: ['对', '错'] }),
		'对'
	);
	eq('判断字母→选项原文（√/×）', normalizeAiAnswer({ answer: 'B' }, { type: 'judgement', options: ['√', '×'] }), '×');
	eq(
		'判断同义词映射（正确→√）',
		normalizeAiAnswer({ answer: '正确' }, { type: 'judgement', options: ['√', '×'] }),
		'√'
	);
	eq(
		'单选型但选项是判断题→按判断处理',
		normalizeAiAnswer({ answer: 'A' }, { type: 'single', options: ['正确', '错误'] }),
		'正确'
	);

	// 填空题
	eq(
		'填空多空用 # 拼接',
		normalizeAiAnswer({ answer: '北京#上海' }, { type: 'completion', blankCount: 2 }),
		'北京#上海'
	);
	eq(
		'填空单空多段合并',
		normalizeAiAnswer({ answer: '北京#上海' }, { type: 'completion', blankCount: 1 }),
		'北京 上海'
	);
	throwsCode(
		'填空数量不符拒绝',
		() => normalizeAiAnswer({ answer: '北京#上海' }, { type: 'completion', blankCount: 3 }),
		'unparsable'
	);
	eq(
		'填空自定义分隔符',
		normalizeAiAnswer({ answer: '北京|上海' }, { type: 'completion', blankCount: 2, separators: ['|'] }),
		'北京|上海'
	);

	throwsCode(
		'空答案拒绝',
		() => normalizeAiAnswer({ answer: '  ' }, { type: 'single', options: ['a', 'b'] }),
		'unparsable'
	);
}

// ========== 4. 端到端：AI 答案 → 既有匹配器 ==========

function testMatchers() {
	// 单选
	const singleOptions = ['巴黎', '伦敦', '东京'];
	const singleAnswer = toMatcherAnswer('{"answer":"A"}', { type: 'single', options: singleOptions }).answer;
	const singleResult = resolveSingle([singleAnswer], singleOptions);
	check('单选：AI 字母能被 resolveSingle 选中', singleResult.finish && singleResult.option === '巴黎', singleResult);

	// 多选
	const multipleOptions = ['选项甲', '选项乙', '选项丙', '选项丁'];
	const multipleAnswer = toMatcherAnswer('{"answer":"AC"}', { type: 'multiple', options: multipleOptions }).answer;
	const multipleResult = resolveMultiple([multipleAnswer], multipleOptions);
	check(
		'多选：AI 字母能被 resolveMultiple 选中',
		multipleResult.finish &&
			JSON.stringify([...(multipleResult.options || multipleResult.plainOptions || [])].sort()) ===
				JSON.stringify(['选项丙', '选项甲'].sort()),
		multipleResult
	);

	// 判断
	const judgementOptions = ['正确', '错误'];
	const judgementAnswer = toMatcherAnswer('{"answer":"B"}', { type: 'judgement', options: judgementOptions }).answer;
	const judgementResult = resolveJudgement([[judgementAnswer]], judgementOptions);
	check(
		'判断：AI 字母能被 resolveJudgement 选中',
		judgementResult.finish && judgementResult.option === '错误',
		judgementResult
	);

	// 填空
	const completionAnswer = toMatcherAnswer('{"answer":"北京#上海"}', { type: 'completion', blankCount: 2 }).answer;
	const completionResult = resolveCompletion([[completionAnswer]], 2, ['#']);
	check(
		'填空：AI 答案能被 resolveCompletion 选中',
		completionResult.finish && JSON.stringify(completionResult.answers) === JSON.stringify(['北京', '上海']),
		completionResult
	);
}

// ========== 5. 请求组装（各协议） ==========

function baseProfile(over: Partial<AiProfile> = {}): AiProfile {
	return {
		id: 'p1',
		name: '测试',
		protocol: 'openai',
		baseUrl: 'https://api.example.com/v1',
		apiKey: 'sk-test-1234567890',
		model: 'test-model',
		...over
	};
}

function testProviders() {
	eq('baseUrl 去尾斜杠', normalizeBaseUrl('https://a.com/v1//'), 'https://a.com/v1');

	const openai = buildAiRequest(baseProfile(), buildAiPrompt({ type: 'single', title: 't', options: 'a\nb' }));
	eq('openai url', openai.url, 'https://api.example.com/v1/chat/completions');
	eq('openai 鉴权头', openai.headers['Authorization'], 'Bearer sk-test-1234567890');
	check('openai Key 不进 URL', !openai.url.includes('sk-test'), openai.url);
	eq('openai model', openai.body.model, 'test-model');
	eq('openai 默认 temperature', openai.body.temperature, 0);
	check('openai jsonMode 默认开启', openai.body.response_format?.type === 'json_object', openai.body);
	eq('openai stream 关闭', openai.body.stream, false);
	eq('openai 系统消息', openai.body.messages[0].role, 'system');

	const noJson = buildAiRequest(
		baseProfile({ jsonMode: false, extraBody: { top_p: 0.9 } }),
		buildAiPrompt({ type: 'single', title: 't', options: 'a\nb' })
	);
	check('jsonMode 关闭时无 response_format', noJson.body.response_format === undefined, noJson.body);
	eq('extraBody 合并', noJson.body.top_p, 0.9);

	const azureProfile = baseProfile({
		baseUrl: 'https://res.openai.azure.com/openai/deployments/dep',
		apiVersion: '2024-06-01'
	});
	check('识别 Azure 端点', isAzureProfile(azureProfile), azureProfile.baseUrl);
	const azure = buildAiRequest(azureProfile, buildAiPrompt({ type: 'single', title: 't', options: 'a\nb' }));
	check('Azure 用 api-key 头', azure.headers['api-key'] === 'sk-test-1234567890', azure.headers);
	check('Azure 无 Authorization 头', azure.headers['Authorization'] === undefined, azure.headers);
	check('Azure 带 api-version', azure.url.includes('api-version=2024-06-01'), azure.url);

	const anthropic = buildAiRequest(
		baseProfile({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }),
		buildAiPrompt({ type: 'single', title: 't', options: 'a\nb' })
	);
	eq('anthropic url', anthropic.url, 'https://api.anthropic.com/v1/messages');
	eq('anthropic x-api-key', anthropic.headers['x-api-key'], 'sk-test-1234567890');
	eq('anthropic version 头', anthropic.headers['anthropic-version'], '2023-06-01');
	check('anthropic system 是顶层字段', typeof anthropic.body.system === 'string', anthropic.body);
	check('anthropic 必填 max_tokens', typeof anthropic.body.max_tokens === 'number', anthropic.body);

	const gemini = buildAiRequest(
		baseProfile({
			protocol: 'gemini',
			baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
			model: 'gemini-1.5-flash'
		}),
		buildAiPrompt({ type: 'single', title: 't', options: 'a\nb' })
	);
	eq(
		'gemini url',
		gemini.url,
		'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent'
	);
	eq('gemini Key 走请求头', gemini.headers['x-goog-api-key'], 'sk-test-1234567890');
	check('gemini Key 不进 URL', !gemini.url.includes('sk-test'), gemini.url);
	check('gemini systemInstruction', typeof gemini.body.systemInstruction === 'object', gemini.body);
	eq('gemini responseMimeType', gemini.body.generationConfig.responseMimeType, 'application/json');

	const responses = buildAiRequest(
		baseProfile({ protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1/' }),
		buildAiPrompt({ type: 'single', title: 't', options: 'a\nb' })
	);
	eq('responses url', responses.url, 'https://api.openai.com/v1/responses');
	eq('responses 鉴权头', responses.headers['Authorization'], 'Bearer sk-test-1234567890');
	check('responses Key 不进 URL', !responses.url.includes('sk-test'), responses.url);
	eq('responses 系统提示词走 instructions', responses.body.instructions, DEFAULT_AI_SYSTEM_PROMPT);
	eq('responses input 角色', responses.body.input[0].role, 'user');
	eq('responses 文本片段类型', responses.body.input[0].content[0].type, 'input_text');
	eq('responses max_output_tokens', responses.body.max_output_tokens, 4096); // 默认值改为 4096：思考模型 1024 经常不够
	check('responses 不带 max_tokens', responses.body.max_tokens === undefined, responses.body);
	eq('responses JSON 模式', responses.body.text, { format: { type: 'json_object' } });
	eq('responses 不在服务端保存', responses.body.store, false);
	check('responses 不带 messages', responses.body.messages === undefined, responses.body);

	const responsesNoJson = buildAiRequest(
		baseProfile({
			protocol: 'openai-responses',
			jsonMode: false,
			extraBody: { temperature: null, reasoning: { effort: 'low' } }
		}),
		buildAiPrompt({ type: 'single', title: 't', options: 'a\nb' })
	);
	check('responses jsonMode 关闭时无 text.format', responsesNoJson.body.text === undefined, responsesNoJson.body);
	check('extraBody 填 null 去掉字段', !('temperature' in responsesNoJson.body), responsesNoJson.body);
	eq('extraBody 合并嵌套对象', responsesNoJson.body.reasoning, { effort: 'low' });

	const azureResponses = buildAiRequest(
		baseProfile({ protocol: 'openai-responses', baseUrl: 'https://res.openai.azure.com/openai/v1' }),
		buildAiPrompt({ type: 'single', title: 't', options: 'a\nb' })
	);
	eq(
		'Azure responses url（v1 端点不拼 api-version）',
		azureResponses.url,
		'https://res.openai.azure.com/openai/v1/responses'
	);
	check(
		'Azure responses 用 api-key 头',
		azureResponses.headers['api-key'] === 'sk-test-1234567890',
		azureResponses.headers
	);
	check(
		'Azure responses 无 Authorization 头',
		azureResponses.headers['Authorization'] === undefined,
		azureResponses.headers
	);
	const azureResponsesVersioned = buildAiRequest(
		baseProfile({
			protocol: 'openai-responses',
			baseUrl: 'https://res.openai.azure.com/openai',
			apiVersion: '2025-04-01-preview'
		}),
		buildAiPrompt({ type: 'single', title: 't', options: 'a\nb' })
	);
	check(
		'Azure responses 填了 api-version 才拼接',
		azureResponsesVersioned.url.endsWith('/openai/responses?api-version=2025-04-01-preview'),
		azureResponsesVersioned.url
	);

	// 图片：各协议的图片包装方式
	const visionPrompt = buildAiPrompt(
		{ type: 'single', title: 't', options: 'a\nb', images: ['data:image/png;base64,QUJD'] },
		{ vision: true }
	);
	const openaiImg = buildAiRequest(baseProfile(), visionPrompt);
	const openaiParts = openaiImg.body.messages[1].content;
	check('openai 图片用 image_url', Array.isArray(openaiParts) && openaiParts[1].type === 'image_url', openaiParts);

	const anthropicImg = buildAiRequest(baseProfile({ protocol: 'anthropic' }), visionPrompt);
	const anthropicParts = anthropicImg.body.messages[0].content;
	check(
		'anthropic 图片用 base64 source',
		anthropicParts.some((p: any) => p.type === 'image' && p.source?.type === 'base64' && p.source?.data === 'QUJD'),
		anthropicParts
	);

	const geminiImg = buildAiRequest(baseProfile({ protocol: 'gemini' }), visionPrompt);
	const geminiParts = geminiImg.body.contents[0].parts;
	check(
		'gemini 图片用 inline_data',
		geminiParts.some((p: any) => p.inline_data?.mime_type === 'image/png' && p.inline_data?.data === 'QUJD'),
		geminiParts
	);

	const responsesImg = buildAiRequest(baseProfile({ protocol: 'openai-responses' }), visionPrompt);
	const responsesParts = responsesImg.body.input[0].content;
	check(
		'responses 图片用 input_image',
		responsesParts.some((p: any) => p.type === 'input_image' && p.image_url === 'data:image/png;base64,QUJD'),
		responsesParts
	);
}

// ========== 6. 响应解析 ==========

function testParseResponse() {
	const openai = parseAiResponse(baseProfile(), {
		choices: [{ message: { content: '{"answer":"A"}' } }],
		usage: { prompt_tokens: 10, completion_tokens: 5 }
	});
	eq('openai 文本', openai.text, '{"answer":"A"}');
	eq('openai usage', openai.usage, { prompt: 10, completion: 5 });

	const anthropic = parseAiResponse(baseProfile({ protocol: 'anthropic' }), {
		content: [
			{ type: 'text', text: '前缀 ' },
			{ type: 'text', text: '{"answer":"B"}' }
		],
		usage: { input_tokens: 3, output_tokens: 4 }
	});
	eq('anthropic 文本拼接', anthropic.text, '前缀 {"answer":"B"}');
	eq('anthropic usage', anthropic.usage, { prompt: 3, completion: 4 });

	const gemini = parseAiResponse(baseProfile({ protocol: 'gemini' }), {
		candidates: [{ content: { parts: [{ text: '{"answer":"C"}' }] } }],
		usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 }
	});
	eq('gemini 文本', gemini.text, '{"answer":"C"}');
	eq('gemini usage', gemini.usage, { prompt: 7, completion: 2 });

	const responsesProfile = baseProfile({ protocol: 'openai-responses' });
	const responsesFromOutput = parseAiResponse(responsesProfile, {
		status: 'completed',
		error: null,
		output: [
			{ type: 'reasoning', id: 'rs_1', summary: [] },
			{
				type: 'message',
				role: 'assistant',
				content: [
					{ type: 'output_text', text: '{"answer":' },
					{ type: 'output_text', text: '"D"}' }
				]
			}
		],
		usage: { input_tokens: 11, output_tokens: 6 }
	});
	eq('responses 跳过 reasoning 条目并拼接 output_text', responsesFromOutput.text, '{"answer":"D"}');
	eq('responses usage', responsesFromOutput.usage, { prompt: 11, completion: 6 });
	eq(
		'responses 优先用 output_text 字段',
		parseAiResponse(responsesProfile, { output_text: '{"answer":"A"}', output: [] }).text,
		'{"answer":"A"}'
	);
	throwsCode(
		'responses 拒答',
		() =>
			parseAiResponse(responsesProfile, {
				status: 'completed',
				output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }]
			}),
		'bad-response'
	);
	try {
		parseAiResponse(responsesProfile, {
			status: 'incomplete',
			incomplete_details: { reason: 'max_output_tokens' },
			output: [{ type: 'reasoning', summary: [] }]
		});
		check('responses token 用完（应当抛错）', false, 'no throw');
	} catch (err) {
		check(
			'responses token 用完提示调大上限',
			err instanceof AiError && err.message.includes('最大回复 token'),
			String((err as any)?.message)
		);
	}
	throwsCode(
		'responses 供应商报错',
		() => parseAiResponse(responsesProfile, { status: 'failed', error: { code: 'server_error', message: 'boom' } }),
		'bad-response'
	);

	throwsCode(
		'openai 供应商报错',
		() => parseAiResponse(baseProfile(), { error: { message: 'invalid api key' } }),
		'bad-response'
	);
	throwsCode('openai 空内容', () => parseAiResponse(baseProfile(), { choices: [] }), 'empty'); // 空内容可重试，单独的错误码
	throwsCode(
		'gemini 安全拦截',
		() => parseAiResponse(baseProfile({ protocol: 'gemini' }), { promptFeedback: { blockReason: 'SAFETY' } }),
		'bad-response'
	);
}

// ========== 7. 传输层（注入假 sender） ==========

async function testTransport() {
	const profile = baseProfile({ retries: 1, timeoutMs: 5000 });
	const env = { type: 'single', title: 't', options: 'a\nb' };

	// 200 成功
	const okAnswer = await askAi(profile, env, {
		deps: {
			send: async () => ({
				status: 200,
				responseText: JSON.stringify({ choices: [{ message: { content: '{"answer":"B","confidence":0.8}' } }] })
			})
		}
	});
	eq('传输层：200 解析答案', okAnswer.answer, 'B');
	eq('传输层：置信度透传', okAnswer.confidence, 0.8);
	eq('传输层：模型名', okAnswer.model, 'test-model');

	// 401 不重试
	let callCount = 0;
	const unauthorized = await askAi(profile, env, {
		deps: {
			send: async () => {
				callCount++;
				return { status: 401, responseText: JSON.stringify({ error: { message: 'invalid key' } }) };
			}
		}
	}).then(
		() => undefined,
		(err) => err as AiError
	);
	eq('传输层：401 错误码', unauthorized?.code, 'unauthorized');
	eq('传输层：401 不重试', callCount, 1);
	check('传输层：401 消息含脱敏后的原因', !!unauthorized?.message.includes('invalid key'), unauthorized?.message);

	// 429 重试后成功
	let attempts = 0;
	const retried = await askAi(profile, env, {
		deps: {
			send: async () => {
				attempts++;
				if (attempts === 1) return { status: 429, responseText: '{}' };
				return { status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '{"answer":"A"}' } }] }) };
			}
		}
	});
	eq('传输层：429 重试后成功', retried.answer, 'A');
	eq('传输层：429 重试次数', attempts, 2);

	// 404 提示 baseUrl / 模型
	const notFound = await askAi(profile, env, {
		deps: { send: async () => ({ status: 404, responseText: '{}' }) }
	}).then(
		() => undefined,
		(err) => err as AiError
	);
	eq('传输层：404 错误码', notFound?.code, 'not-found');
	check('传输层：404 提示含 /v1', !!notFound?.message.includes('/v1'), notFound?.message);

	// 响应非 JSON
	const badJson = await askAi(profile, env, {
		deps: { send: async () => ({ status: 200, responseText: '<html>502</html>' }) }
	}).then(
		() => undefined,
		(err) => err as AiError
	);
	eq('传输层：非 JSON 响应', badJson?.code, 'bad-response');

	// 配置不全
	const noConfig = await askAi({ ...profile, apiKey: '' }, env, {
		deps: { send: async () => ({ status: 200, responseText: '{}' }) }
	}).then(
		() => undefined,
		(err) => err as AiError
	);
	eq('传输层：缺 Key 判定 no-config', noConfig?.code, 'no-config');
	eq('配置校验：合法', validateAiProfile(profile), undefined);
	eq('配置校验：非法 URL', validateAiProfile({ ...profile, baseUrl: 'not-a-url' })?.code, 'no-config');

	// 连接测试
	const probeOk = await probeAiProfile(profile, {
		send: async () => ({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) })
	});
	check('连接测试：成功', probeOk.ok === true && typeof probeOk.latency === 'number', probeOk);

	// JSON 模式下 OpenAI 要求消息里出现 "json"，否则 400
	let probeBody: any;
	await probeAiProfile(profile, {
		send: async (http) => {
			probeBody = http.body;
			return { status: 200, responseText: JSON.stringify({ choices: [{ message: { content: '{"answer":"OK"}' } }] }) };
		}
	});
	check('连接测试：保留 JSON 模式', probeBody?.response_format?.type === 'json_object', probeBody);
	check('连接测试：提示词含 json 字样', /json/i.test(JSON.stringify(probeBody?.messages || [])), probeBody?.messages);

	const probeResponsesTruncated = await probeAiProfile(baseProfile({ protocol: 'openai-responses' }), {
		send: async () => ({
			status: 200,
			responseText: JSON.stringify({
				status: 'incomplete',
				incomplete_details: { reason: 'max_output_tokens' },
				error: null,
				output: [{ type: 'reasoning', summary: [] }]
			})
		})
	});
	check(
		'连接测试：responses 推理模型 token 不够仍判连通',
		probeResponsesTruncated.ok === true,
		probeResponsesTruncated
	);
	const probeFail = await probeAiProfile(profile, { send: async () => ({ status: 403, responseText: '{}' }) });
	check('连接测试：403 失败', probeFail.ok === false && probeFail.code === 'forbidden', probeFail);
}

// ========== 8. 结果结构与脱敏 ==========

async function testAnswerer() {
	const profile = baseProfile();
	const env = { type: 'single', title: '题干', options: 'a\nb' };

	const info = createAiSearchInformation(profile, env, {
		answer: 'A',
		model: 'test-model',
		raw: '{"answer":"A"}',
		confidence: 0.9
	});
	eq('结果名含模型', info.name, 'AI 题库：test-model');
	eq('extra_data.ai 标记', (info.results[0].extra_data as any).ai, true);
	eq('结果答案', info.results[0].answer, 'A');
	eq('主页由 baseUrl 推导', info.homepage, 'https://api.example.com');

	// 失败：不抛异常，返回带 error 的空结果
	const failed = await aiAnswererHandler(profile, env, {
		deps: { send: async () => ({ status: 500, responseText: '{}' }) }
	});
	eq('失败结果数量', failed.length, 1);
	eq('失败结果无答案', failed[0].results.length, 0);
	check('失败结果带 error', !!failed[0].error, failed[0].error);
	eq('失败错误码透传', (failed[0].response as any)?.code, 'server-error');

	// 脱敏
	eq('脱敏 sk- 前缀', redactSecrets('key=sk-abcdef123456'), 'key=***');
	eq('脱敏显式密钥', redactSecrets('Authorization abc123xyz', ['abc123xyz']), 'Authorization ***');
}

// ========== 9. 题目缓存签名 ==========

function testHash() {
	const a = createQuestionHash('以下哪个正确？', 'A. 甲\nB. 乙', 'single');
	eq('签名稳定', a, createQuestionHash('以下哪个正确？', 'A. 甲\nB. 乙', 'single'));
	check('同题干不同选项签名不同', a !== createQuestionHash('以下哪个正确？', 'A. 丙\nB. 丁', 'single'), a);
	check('不同题型签名不同', a !== createQuestionHash('以下哪个正确？', 'A. 甲\nB. 乙', 'multiple'), a);
	eq('空白差异不影响签名', a, createQuestionHash('  以下哪个正确？  ', 'A. 甲\nB. 乙  ', 'single'));
	check('fnv1a32 输出 16 进制', /^[0-9a-f]{1,8}$/.test(fnv1a32('任意内容')), fnv1a32('任意内容'));
}

// ========== 运行 ==========

async function main() {
	console.log('🔍 AI 题库核心模块单测');
	testPrompt();
	testParse();
	testNormalize();
	testMatchers();
	testProviders();
	testParseResponse();
	testHash();
	await testTransport();
	await testAnswerer();

	console.log(`\n通过 ${passed}，失败 ${failures.length}`);
	if (failures.length) {
		console.error('\n失败用例：');
		for (const f of failures) console.error(' - ' + f);
		process.exit(1);
	}
	console.log('✅ 全部通过');
	process.exit(0);
}

main().catch((err) => {
	console.error('❌ 测试执行异常', err);
	process.exit(1);
});
