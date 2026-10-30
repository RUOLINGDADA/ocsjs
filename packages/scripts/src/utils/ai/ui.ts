import { $modal, $message, $ui, h } from 'easy-us';
import {
	AI_VENDOR_PRESETS,
	AiProfile,
	AiProbeResult,
	normalizeBaseUrl,
	probeAiProfile,
	isProfileComplete
} from '@ocsjs/core';
import {
	AI_ANSWER_MODES,
	AiAnswerMode,
	AiSettings,
	createProfileByPresetId,
	createProfileId,
	getProfileHost,
	getAiSettings,
	maskApiKey,
	normalizeProfile,
	normalizeProfiles,
	saveAiProfiles
} from './config';
import { getNotAllowedConnectHosts, isAllDomainScript } from '../connect-whitelist';
import { CommonProject } from '../../projects/common';

/**
 * AI 题库配置面板（纯 UI）
 *
 * 与业务状态解耦：只读写 common.settings 的 AI 配置项，通过 rerender 回调驱动自身重绘。
 * 全部字段编辑即时保存（与 OCS 其它配置项一致的交互习惯），Key 展示与日志一律脱敏。
 */

/** 重绘回调（由挂载方提供） */
export type Rerender = () => void;

// ========== 基础控件 ==========

function createLabeledRow(label: string, control: Node | string, desc?: string): HTMLElement {
	const row = h('div', { className: 'ai-row' }, [
		h('div', { className: 'ai-row-label', title: desc || label }, label),
		h('div', { className: 'ai-row-control' }, [control])
	]);
	if (desc) {
		row.append(h('div', { className: 'ai-row-desc' }, desc));
	}
	return row;
}

function createSwitch(checked: boolean, onChange: (checked: boolean) => void, title?: string): HTMLElement {
	const input = h('input', { type: 'checkbox', className: 'base-style-switch' });
	input.checked = checked;
	if (title) input.title = title;
	input.onchange = () => onChange(input.checked);
	return input;
}

function createNumberInput(
	value: number,
	opts: { min: number; max: number; step?: number; title?: string },
	onChange: (value: number) => void
): HTMLElement {
	const input = h('input', {
		type: 'number',
		className: 'base-style-active-form-control',
		style: { width: '90px' }
	}) as HTMLInputElement;
	input.value = String(value);
	input.min = String(opts.min);
	input.max = String(opts.max);
	input.step = String(opts.step ?? 1);
	if (opts.title) input.title = opts.title;
	input.onchange = () => {
		const num = Number(input.value);
		const clamped = Math.max(opts.min, Math.min(opts.max, isFinite(num) ? num : opts.min));
		if (clamped !== num) input.value = String(clamped);
		onChange(clamped);
	};
	return input;
}

function createSelect(
	options: [string, string, string?][],
	value: string,
	onChange: (value: string) => void
): HTMLElement {
	const select = h('select', { className: 'base-style-active-form-control' }) as HTMLSelectElement;
	for (const [val, label, desc] of options) {
		const option = h('option', { value: val }, label) as HTMLOptionElement;
		if (desc) option.title = desc;
		select.append(option);
	}
	select.value = value;
	select.onchange = () => onChange(select.value);
	return select;
}

function createButton(
	text: string,
	onClick: () => void,
	opts: { className?: string; title?: string } = {}
): HTMLElement {
	const btn = h('button', { className: opts.className || 'base-style-button-secondary' }, text) as HTMLButtonElement;
	btn.style.padding = '4px 10px';
	btn.style.fontSize = '12px';
	if (opts.title) btn.title = opts.title;
	btn.onclick = onClick;
	return btn;
}

/** 协议徽标文案 */
function protocolLabel(profile: AiProfile): string {
	switch (profile.protocol) {
		case 'anthropic':
			return 'Anthropic';
		case 'gemini':
			return 'Gemini';
		case 'openai-responses':
			return 'OpenAI Responses';
		default:
			return 'OpenAI 兼容';
	}
}

// ========== 配置编辑弹窗 ==========

/** 解析 JSON 文本，失败返回 undefined */
function parseJsonObject(text: string): Record<string, any> | undefined | null {
	const value = String(text || '').trim();
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		return parsed as Record<string, any>;
	} catch {
		return null;
	}
}

/**
 * 打开单条配置的编辑弹窗
 * @param profile 待编辑配置（新建时传入预设生成的骨架）
 * @param onSave 保存回调（已归一化）
 */
export function openAiProfileEditor(profile: AiProfile, onSave: (profile: AiProfile) => void): void {
	const draft: AiProfile = normalizeProfile(profile) || { ...profile };

	/** 输入控件集合（保存时统一读值） */
	const nameInput = h('input', {
		className: 'base-style-active-form-control',
		style: { width: '100%' }
	}) as HTMLInputElement;
	nameInput.value = draft.name;

	const baseUrlInput = h('input', {
		className: 'base-style-active-form-control',
		style: { width: '100%' },
		placeholder: 'https://api.deepseek.com/v1'
	}) as HTMLInputElement;
	baseUrlInput.value = draft.baseUrl;

	const apiKeyInput = h('input', {
		type: 'password',
		className: 'base-style-active-form-control',
		style: { width: '100%' },
		placeholder: 'sk-...'
	}) as HTMLInputElement;
	apiKeyInput.value = draft.apiKey;

	const modelInput = h('input', {
		className: 'base-style-active-form-control',
		style: { width: '100%' },
		placeholder: 'deepseek-chat'
	}) as HTMLInputElement;
	modelInput.value = draft.model;
	// 关联模型候选 datalist（不写在 h 的 attrs 里：h 的 attrs 类型未声明 list）
	modelInput.setAttribute('list', 'ai-model-datalist');

	/** 模型候选：所有预设的模型 + 当前值 */
	const modelDatalist = h('datalist', { id: 'ai-model-datalist' });
	const modelSet = new Set<string>();
	for (const preset of AI_VENDOR_PRESETS) {
		for (const model of preset.models || []) modelSet.add(model);
		if (preset.model) modelSet.add(preset.model);
	}
	if (draft.model) modelSet.add(draft.model);
	for (const model of modelSet) modelDatalist.append(h('option', { value: model }));

	const protocolSelect = createSelect(
		[
			['openai', 'OpenAI 兼容（/chat/completions）', '绝大多数供应商与中转网关使用这种协议'],
			[
				'openai-responses',
				'OpenAI Responses（/responses）',
				'OpenAI 新版 Responses 接口；中转网关需支持 /v1/responses 才能用'
			],
			['anthropic', 'Anthropic（/v1/messages）', 'Claude 官方接口'],
			['gemini', 'Google Gemini（generateContent）', 'Gemini 官方接口']
		],
		draft.protocol,
		() => undefined
	) as HTMLSelectElement;

	const temperatureInput = createNumberInput(
		typeof draft.temperature === 'number' ? draft.temperature : 0,
		{ min: 0, max: 2, step: 0.1, title: '答题场景建议 0，保证同样题目得到同样答案' },
		() => undefined
	) as HTMLInputElement;

	const maxTokensInput = createNumberInput(
		draft.maxTokens ?? 4096,
		{ min: 16, max: 32768 },
		() => undefined
	) as HTMLInputElement;

	const timeoutInput = createNumberInput(
		Math.round((draft.timeoutMs ?? 60000) / 1000),
		{ min: 5, max: 300, title: '单题请求超时（秒）。太短会频繁超时，太长会拖慢整场答题' },
		() => undefined
	) as HTMLInputElement;

	const retriesInput = createNumberInput(draft.retries ?? 2, { min: 0, max: 5 }, () => undefined) as HTMLInputElement;

	const visionSwitch = createSwitch(
		draft.vision === true,
		() => undefined,
		'开启后会把题目/选项中的图片以 base64 发送给模型（模型需支持视觉）'
	);
	const jsonModeSwitch = createSwitch(
		draft.jsonMode !== false,
		() => undefined,
		'要求模型按 JSON 输出（部分推理模型不支持，可关闭）'
	);

	const apiVersionInput = h('input', {
		className: 'base-style-active-form-control',
		style: { width: '100%' },
		placeholder: '2024-06-01（仅 Azure OpenAI 需要）'
	}) as HTMLInputElement;
	apiVersionInput.value = draft.apiVersion || '';

	const headersTextarea = h('textarea', {
		className: 'modal-input',
		style: { width: '100%', minHeight: '60px' },
		placeholder: '{"X-Custom-Header": "value"}'
	}) as HTMLTextAreaElement;
	headersTextarea.value = draft.extraHeaders ? JSON.stringify(draft.extraHeaders, null, 2) : '';

	const bodyTextarea = h('textarea', {
		className: 'modal-input',
		style: { width: '100%', minHeight: '60px' },
		placeholder: '{"top_p": 0.9}'
	}) as HTMLTextAreaElement;
	bodyTextarea.value = draft.extraBody ? JSON.stringify(draft.extraBody, null, 2) : '';

	const systemPromptTextarea = h('textarea', {
		className: 'modal-input',
		style: { width: '100%', minHeight: '80px' },
		placeholder: '留空使用内置提示词（推荐）'
	}) as HTMLTextAreaElement;
	systemPromptTextarea.value = draft.systemPrompt || '';

	const keyVisibleToggle = createButton('显示', () => {
		const visible = apiKeyInput.type === 'text';
		apiKeyInput.type = visible ? 'password' : 'text';
		keyVisibleToggle.textContent = visible ? '显示' : '隐藏';
	});

	const advanced = h('details', { className: 'ai-advanced' }, [
		h('summary', {}, '高级设置（一般无需修改）'),
		createLabeledRow('采样温度', temperatureInput, '默认 0；越高越发散，答题场景不建议调高'),
		createLabeledRow(
			'最大回复 token',
			maxTokensInput,
			'默认 4096。思考模型（DeepSeek V4、o 系列、GPT-5 等）的思考过程也计入上限；回复被截断时会自动调大重试'
		),
		createLabeledRow('超时（秒）', timeoutInput),
		createLabeledRow('失败重试', retriesInput, '仅对 429/5xx/网络错误重试，401 等配置错误不会重试'),
		createLabeledRow('图片输入（视觉）', visionSwitch),
		createLabeledRow('JSON 输出模式', jsonModeSwitch, '若模型报 response_format / text.format 不支持，可关闭'),
		createLabeledRow(
			'Azure api-version',
			apiVersionInput,
			'仅 *.openai.azure.com 需要；Responses 协议使用 /openai/v1 地址时留空'
		),
		createLabeledRow('附加请求头', headersTextarea, 'JSON 对象，如中转网关需要的额外鉴权头'),
		createLabeledRow(
			'附加请求体',
			bodyTextarea,
			'JSON 对象，会被合并进请求体；值填 null 可去掉默认字段，如推理模型不支持温度时填 {"temperature": null}'
		),
		createLabeledRow('自定义系统提示词', systemPromptTextarea, '留空使用内置提示词')
	]);

	const content = h('div', { className: 'ai-editor' }, [
		createLabeledRow('名称', nameInput, '用于在列表里区分不同配置'),
		createLabeledRow('协议', protocolSelect, '决定请求路径与鉴权方式'),
		createLabeledRow('接口地址', baseUrlInput, '一般以 /v1 结尾；末尾斜杠会被自动去掉'),
		createLabeledRow(
			'API Key',
			h('div', { className: 'ai-inline' }, [apiKeyInput, keyVisibleToggle]),
			'以明文保存在脚本管理器存储中'
		),
		createLabeledRow(
			'模型',
			h('div', { className: 'ai-inline' }, [modelInput, modelDatalist]),
			'填写供应商文档中的模型名'
		),
		advanced
	]);

	/** 保存：归一化 + 校验 */
	const save = () => {
		const headers = parseJsonObject(headersTextarea.value);
		if (headers === null) {
			$modal.alert({ content: '「附加请求头」不是合法的 JSON 对象。' });
			return;
		}
		const body = parseJsonObject(bodyTextarea.value);
		if (body === null) {
			$modal.alert({ content: '「附加请求体」不是合法的 JSON 对象。' });
			return;
		}

		const next = normalizeProfile({
			...draft,
			name: nameInput.value,
			protocol: protocolSelect.value,
			baseUrl: normalizeBaseUrl(baseUrlInput.value),
			apiKey: apiKeyInput.value.trim(),
			model: modelInput.value.trim(),
			temperature: Number(temperatureInput.value),
			maxTokens: Number(maxTokensInput.value),
			timeoutMs: Number(timeoutInput.value) * 1000,
			retries: Number(retriesInput.value),
			vision: (visionSwitch as HTMLInputElement).checked,
			jsonMode: (jsonModeSwitch as HTMLInputElement).checked,
			apiVersion: apiVersionInput.value.trim() || undefined,
			extraHeaders: headers,
			extraBody: body,
			systemPrompt: systemPromptTextarea.value.trim() || undefined
		});

		if (!next) {
			$modal.alert({ content: '配置格式不合法，请检查后重试。' });
			return;
		}
		if (!isProfileComplete(next)) {
			$modal.alert({ content: '接口地址、API Key、模型名不能为空。' });
			return;
		}

		modal?.remove();
		onSave(next);

		// 域名白名单提示：自定义接口不在 @connect 中时请求会被脚本管理器拦截
		if (!isAllDomainScript()) {
			const notAllowed = getNotAllowedConnectHosts([next.baseUrl]);
			if (notAllowed.length) {
				$modal.alert({
					width: 600,
					title: '域名不在白名单内',
					content: h('div', [
						h('div', ['配置已保存，但以下域名不在脚本的 @connect 白名单中，请求可能被脚本管理器拦截：']),
						h(
							'ul',
							notAllowed.map((host) => h('li', host))
						),
						h('div', [
							'解决办法：安装 ',
							h(
								'a',
								{ href: 'https://docs.ocsjs.com/docs/other/api#全域名通用版本', target: '_blank' },
								'OCS 全域名通用版本'
							),
							'，或在脚本管理器中手动为该脚本添加 @connect。'
						])
					])
				});
			}
		}
	};

	const footer = h('div', { className: 'ai-editor-footer' }, [
		createButton('取消', () => modal?.remove(), { className: 'modal-cancel-button' }),
		createButton('保存配置', save, { className: 'modal-confirm-button' })
	]);

	const modal = $modal.prompt({
		width: 640,
		maskCloseable: false,
		content,
		footer
	});
}

// ========== 添加配置（选预设） ==========

function openPresetPicker(onPicked: (presetId: string) => void): void {
	const note = h('div', { className: 'ai-preset-note secondary' }, '');
	const select = createSelect(
		AI_VENDOR_PRESETS.map((p) => [p.id, p.name, p.note || ''] as [string, string, string]),
		'deepseek',
		(value) => {
			note.textContent = AI_VENDOR_PRESETS.find((p) => p.id === value)?.note || '';
		}
	) as HTMLSelectElement;
	note.textContent = AI_VENDOR_PRESETS.find((p) => p.id === select.value)?.note || '';

	const modal = $modal.prompt({
		width: 520,
		content: h('div', [
			$ui.notes(['选择一个供应商预设，系统会自动填好接口地址与默认模型，你只需要补上 API Key。']),
			createLabeledRow('供应商', select),
			note
		]),
		footer: h('div', { className: 'ai-editor-footer' }, [
			createButton('取消', () => modal?.remove(), { className: 'modal-cancel-button' }),
			createButton(
				'下一步',
				() => {
					modal?.remove();
					onPicked(select.value);
				},
				{ className: 'modal-confirm-button' }
			)
		])
	});
}

// ========== 导入 / 导出 ==========

function openExportModal(profiles: AiProfile[]): void {
	if (!profiles.length) {
		$modal.alert({ content: '还没有可导出的配置。' });
		return;
	}
	// 导出默认抹掉密钥：配置可能被贴到群里/发到网上
	const masked = profiles.map((p) => ({ ...p, apiKey: '***' }));
	const text = JSON.stringify(masked, null, 4);
	const textarea = h('textarea', {
		className: 'modal-input',
		style: { width: '100%', minHeight: '240px' }
	}) as HTMLTextAreaElement;
	textarea.value = text;

	$modal.simple({
		width: 640,
		content: h('div', [
			$ui.notes([
				'为防止密钥泄露，导出的配置中 API Key 已被替换为 ***，导入后需要重新填写。',
				'如需连密钥一起备份，请使用脚本管理器自带的导出功能（注意风险）。'
			]),
			textarea,
			h('div', { style: { marginTop: '8px', textAlign: 'right' } }, [$ui.copy('复制到剪贴板', text)])
		])
	});
}

function openImportModal(onImported: (profiles: AiProfile[]) => void): void {
	const textarea = h('textarea', {
		className: 'modal-input',
		style: { width: '100%', minHeight: '240px' },
		placeholder: '粘贴配置 JSON（数组或单个对象）'
	}) as HTMLTextAreaElement;

	const modal = $modal.prompt({
		width: 640,
		content: h('div', [
			$ui.notes(['支持粘贴本面板导出的 JSON，或直接粘贴单条配置对象。导入的配置会追加到列表末尾。']),
			textarea
		]),
		footer: h('div', { className: 'ai-editor-footer' }, [
			createButton('取消', () => modal?.remove(), { className: 'modal-cancel-button' }),
			createButton(
				'导入',
				() => {
					let parsed: any;
					try {
						parsed = JSON.parse(textarea.value);
					} catch {
						$modal.alert({ content: '不是合法的 JSON。' });
						return;
					}
					const imported = normalizeProfiles(Array.isArray(parsed) ? parsed : [parsed]);
					if (!imported.length) {
						$modal.alert({ content: '没有解析到有效配置（至少需要接口地址与模型名）。' });
						return;
					}
					// 重新分配 id，避免与已有配置冲突
					const withNewIds = imported.map((p) => ({ ...p, id: createProfileId() }));
					modal?.remove();
					onImported(withNewIds);
				},
				{ className: 'modal-confirm-button' }
			)
		])
	});
}

// ========== 主面板 ==========

/** 测试连接状态元素 */
function createProbeStatus(): { el: HTMLElement; set: (result: AiProbeResult | 'testing') => void } {
	const el = h('span', { className: 'ai-probe' }, '');
	const set = (result: AiProbeResult | 'testing') => {
		if (result === 'testing') {
			el.className = 'ai-probe testing';
			el.textContent = '检测中…';
			el.title = '正在发送一条极短的测试请求';
			return;
		}
		if (result.ok) {
			el.className = 'ai-probe success';
			el.textContent = `连接正常 · ${result.latency ?? 0}ms`;
			el.title = result.message || '';
		} else {
			el.className = 'ai-probe error';
			el.textContent = '连接失败';
			el.title = result.message || '未知错误';
		}
	};
	return { el, set };
}

/** 渲染单条配置卡片 */
function createProfileCard(profile: AiProfile, settings: AiSettings, context: { rerender: Rerender }): HTMLElement {
	const isActive = settings.activeProfile?.id === profile.id;
	const probe = createProbeStatus();

	const radio = h('input', { type: 'radio', name: 'ai-active-profile' }) as HTMLInputElement;
	radio.checked = isActive;
	radio.title = '设为当前使用的配置';
	radio.onchange = () => {
		if (radio.checked) {
			saveAiProfiles(settings.profiles, profile.id);
			$message.success({ content: `已切换到：${profile.name}`, duration: 3 });
			context.rerender();
		}
	};

	const enableSwitch = createSwitch(
		profile.enabled !== false,
		(enabled) => {
			const next = settings.profiles.map((p) => (p.id === profile.id ? { ...p, enabled } : p));
			saveAiProfiles(next);
			$message.info({ content: `配置「${profile.name}」已${enabled ? '启用' : '停用'}`, duration: 3 });
			context.rerender();
		},
		'停用后该配置不会参与答题'
	);

	const row = (label: string, value: string) =>
		h('div', { className: 'ai-detail-row' }, [
			h('span', { className: 'ai-detail-label' }, label),
			h('span', { className: 'ai-detail-value' }, value)
		]);

	const actions = h('div', { className: 'ai-card-actions' }, [
		createButton(
			'测试连接',
			async () => {
				probe.set('testing');
				const result = await probeAiProfile(profile);
				probe.set(result);
				if (!result.ok && result.message) {
					$message.error({ content: `AI 连接失败：${result.message}`, duration: 10 });
				}
			},
			{ title: '发送一条极短的请求，验证地址 / Key / 模型是否可用' }
		),
		createButton('编辑', () => {
			openAiProfileEditor(profile, (next) => {
				const list = settings.profiles.map((p) => (p.id === profile.id ? next : p));
				saveAiProfiles(list);
				$message.success({ content: '配置已保存', duration: 3 });
				context.rerender();
			});
		}),
		createButton('复制', () => {
			const copy = { ...profile, id: createProfileId(), name: profile.name + ' 副本' };
			saveAiProfiles([...settings.profiles, copy]);
			$message.success({ content: '已复制一份配置（密钥一并复制）', duration: 3 });
			context.rerender();
		}),
		createButton(
			'删除',
			() => {
				$modal.confirm({
					content: `确定删除配置「${profile.name}」吗？`,
					onConfirm: () => {
						const list = settings.profiles.filter((p) => p.id !== profile.id);
						const activeId = settings.activeProfileId === profile.id ? list[0]?.id : settings.activeProfileId;
						saveAiProfiles(list, activeId ?? '');
						$message.success({ content: '已删除', duration: 3 });
						context.rerender();
					}
				});
			},
			{ className: 'modal-cancel-button' }
		)
	]);

	return h(
		'div',
		{
			className: 'ai-card' + (isActive ? ' active' : '') + (profile.enabled === false ? ' disabled' : '')
		},
		[
			h('div', { className: 'ai-card-head' }, [
				$ui.tooltip(radio),
				h('span', { className: 'ai-card-name' }, profile.name),
				h('span', { className: 'ai-card-badge' }, protocolLabel(profile)),
				h('span', { className: 'ai-card-badge host', title: profile.baseUrl }, getProfileHost(profile)),
				probe.el,
				h('span', { className: 'ai-card-spacer' }),
				$ui.tooltip(enableSwitch)
			]),
			h('div', { className: 'ai-card-body' }, [
				row('模型', profile.model || '未填写'),
				row('API Key', maskApiKey(profile.apiKey)),
				row('接口', profile.baseUrl || '未填写'),
				...(profile.vision ? [row('能力', '支持图片输入（视觉）')] : []),
				actions
			])
		]
	);
}

/**
 * 渲染 AI 题库配置面板
 * @param context.rerender 配置变更后重绘自身
 */
export function createAiAnswererPanel(context: { rerender: Rerender }): HTMLElement {
	const settings = getAiSettings();

	const container = h('div', { className: 'ai-panel' });

	// 说明文字由 Script 的 notes 配置渲染（见 projects/common.ts 的 aiAnswerer），此处不重复

	// ===== 运行设置 =====
	const modeDesc = h('div', { className: 'ai-row-desc' }, '');
	const refreshModeDesc = () => {
		modeDesc.textContent = AI_ANSWER_MODES.find((m) => m[0] === settings.mode)?.[2] || '';
	};
	refreshModeDesc();

	const enabledSwitch = createSwitch(
		settings.enabled,
		(enabled) => {
			Common_setAi('aiEnabled', enabled);
			$message.success({ content: enabled ? 'AI 答题已开启' : 'AI 答题已关闭', duration: 3 });
			context.rerender();
		},
		'关闭后完全回到改造前的行为：只使用固定题库'
	);

	const modeSelect = createSelect(
		AI_ANSWER_MODES.map((m) => [m[0], m[1], m[2]] as [string, string, string]),
		settings.mode,
		(value) => {
			Common_setAi('aiMode', value as AiAnswerMode);
			settings.mode = value as AiAnswerMode;
			refreshModeDesc();
		}
	);

	const runCard = h('div', { className: 'card ai-section' }, [
		h('div', { className: 'ai-section-title' }, '运行设置'),
		createLabeledRow('启用 AI 答题', enabledSwitch),
		createLabeledRow('答题来源', modeSelect),
		modeDesc,
		createLabeledRow(
			'并发上限',
			createNumberInput(
				settings.maxConcurrency,
				{ min: 1, max: 5, title: '同时向 AI 发起的请求数，过高容易触发 429 限流' },
				(value) => Common_setAi('aiMaxConcurrency', value)
			)
		),
		createLabeledRow(
			'最低置信度',
			createNumberInput(
				settings.minConfidence,
				{ min: 0, max: 1, step: 0.05, title: '低于该置信度的答案会被丢弃（0 表示全部接受）' },
				(value) => Common_setAi('aiMinConfidence', value)
			),
			'0 表示全部接受；调高可减少"瞎答"，但可能导致更多题目判为未搜到'
		),
		createLabeledRow(
			'AI 答案写入题库缓存',
			createSwitch(
				settings.answerCache,
				(value) => Common_setAi('aiAnswerCache', value),
				'开启后重复题目不会再消耗 token；换模型后缓存自动失效'
			)
		)
	]);
	container.append(runCard);

	// ===== 配置列表 =====
	const listCard = h('div', { className: 'card ai-section' });
	const header = h('div', { className: 'ai-section-head' }, [
		h('div', { className: 'ai-section-title' }, `模型配置（${settings.profiles.length}）`),
		h('span', { className: 'ai-card-spacer' }),
		createButton(
			'＋ 添加配置',
			() => {
				openPresetPicker((presetId) => {
					const profile = createProfileByPresetId(presetId);
					if (!profile) {
						$message.error({ content: '未知的供应商预设', duration: 5 });
						return;
					}
					openAiProfileEditor(profile, (next) => {
						const list = [...settings.profiles, next];
						saveAiProfiles(list, settings.activeProfileId || next.id);
						context.rerender();
					});
				});
			},
			{ className: 'base-style-button' }
		)
	]);
	listCard.append(header);

	if (!settings.profiles.length) {
		listCard.append(
			h('div', { className: 'ai-empty' }, [
				h('div', { className: 'ai-empty-title' }, '还没有配置任何 AI 服务'),
				h(
					'div',
					{ className: 'ai-empty-desc' },
					'点击右上角「添加配置」，选择一个供应商预设，填上 API Key 即可开始使用。'
				),
				h('div', { className: 'ai-empty-desc' }, '没有 Key？可先用本地模型（Ollama / LM Studio）试跑。')
			])
		);
	} else {
		for (const profile of settings.profiles) {
			listCard.append(createProfileCard(profile, settings, context));
		}
	}

	// ===== 导入导出 =====
	listCard.append(
		h('div', { className: 'ai-section-footer' }, [
			createButton('导入配置', () => {
				openImportModal((imported) => {
					const list = [...settings.profiles, ...imported];
					saveAiProfiles(list, settings.activeProfileId || imported[0]?.id || '');
					$message.success({ content: `已导入 ${imported.length} 条配置，请补全 API Key`, duration: 6 });
					context.rerender();
				});
			}),
			createButton('导出配置', () => openExportModal(settings.profiles))
		])
	);

	container.append(listCard);

	return container;
}

/**
 * 写入 AI 设置项
 *
 * 单独封装：AI 配置项集中放在 common.settings 中（与固定题库配置同源），
 * 便于统一读取、桌面端同步与将来迁移命名空间。
 */
function Common_setAi(key: string, value: any) {
	// cfg 的键是各 Script 配置项的联合字面量类型，动态写入需要显式放宽
	(CommonProject.scripts.settings.cfg as Record<string, any>)[key] = value;
}
