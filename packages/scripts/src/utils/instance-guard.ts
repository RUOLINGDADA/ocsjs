import { blockAllWorkers } from '@ocsjs/core';
import { $elements, $message, $store } from 'easy-us';

/**
 * 多实例冲突保护
 *
 * 脚本管理器按「名称 + 命名空间」识别脚本。本构建与官方版标识相同，安装时会直接替换官方版。
 * 但下面几种情况仍会有两个 OCS 同时运行：
 * - 旧的「OCS 网课助手 AI 版」（命名空间不同，不会被替换）；
 * - 官方版装在另一个脚本管理器里（如同时装了 Tampermonkey 和 ScriptCat）；
 * - 本构建的标准版、通用版、开发版同时启用。
 *
 * 脚本管理器不允许一个脚本停用另一个脚本，所以这里做的是：检测到其他 OCS 后，
 * 本实例停止答题、不再提交，并提示用户去脚本管理器里停用多余的那个。
 * 两个实例同时答题会互相点掉对方选中的多选项，并且重复提交，比只运行一个更糟。
 */

const CONFLICT_TAB_KEY = 'ocs.instance-conflict';

/** 入口脚本在 start() 之前记录的检测结果 */
let foreignBeforeStart = false;

/**
 * 在 start() 之前调用：同一运行环境里另一个 OCS（同一 UI 框架）已经注册过自定义元素，
 * 说明它比本实例先启动。
 */
export function detectForeignInstanceBeforeStart(): boolean {
	try {
		foreignBeforeStart = typeof customElements !== 'undefined' && !!customElements.get('container-element');
	} catch {
		foreignBeforeStart = false;
	}
	return foreignBeforeStart;
}

/**
 * 查找页面上不属于本实例的 OCS 悬浮窗。
 *
 * OCS 悬浮窗挂在一个没有属性、没有子节点的 div 上，内容放在封闭的 Shadow DOM 里，
 * 外部读不到内容，但 elementFromPoint 命中悬浮窗时会返回这个宿主 div。
 * 宿主本身高度为 0，不可能被直接命中，所以命中即说明它在渲染 Shadow DOM 内容。
 */
export function findForeignPanels(doc: Document = document, own?: Element | null): Element[] {
	/** 每个候选宿主被命中的范围 */
	const hits = new Map<Element, { minX: number; maxX: number; minY: number; maxY: number }>();
	const rejected = new Set<Element>();
	const width = doc.documentElement.clientWidth || window.innerWidth;
	const height = doc.documentElement.clientHeight || window.innerHeight;
	const step = 24;
	for (let y = step / 2; y < height; y += step) {
		for (let x = step / 2; x < width; x += step) {
			const el = doc.elementFromPoint(x, y);
			if (!el || el === own || rejected.has(el)) continue;
			const box = hits.get(el);
			if (box) {
				box.minX = Math.min(box.minX, x);
				box.maxX = Math.max(box.maxX, x);
				box.minY = Math.min(box.minY, y);
				box.maxY = Math.max(box.maxY, y);
				continue;
			}
			const candidate =
				el.tagName === 'DIV' &&
				el.attributes.length === 0 &&
				el.childNodes.length === 0 &&
				(el.parentElement === doc.body || el.parentElement === doc.documentElement) &&
				el.getBoundingClientRect().height === 0;
			if (candidate) hits.set(el, { minX: x, maxX: x, minY: y, maxY: y });
			else rejected.add(el);
		}
	}
	// OCS 悬浮窗最小宽度 300px、展开时高度远大于标题栏；小于这个范围的多半是其他扩展的小部件（按钮、图标）
	return Array.from(hits.entries())
		.filter(([, b]) => b.maxX - b.minX >= 240 && b.maxY - b.minY >= 24)
		.map(([el]) => el);
}

const CONFLICT_TEXT =
	'页面上还有另一个 OCS 在运行（多半是旧的 AI 版），本脚本已停止答题。请在脚本管理器里停用另一个，然后刷新页面。';

function block() {
	blockAllWorkers(CONFLICT_TEXT);
}

/**
 * 启动冲突保护（start() 之后调用，所有窗口都要调用）
 * - 顶层窗口负责检测，结果写入标签页存储；
 * - 子窗口（章节测试等 iframe）读取并跟随停用。
 */
export function startInstanceGuard() {
	// 同一标签页内所有窗口共享：任何窗口检测到冲突，其余窗口一起停用
	$store.addTabChangeListener(CONFLICT_TAB_KEY, (value: any) => {
		if (value) block();
	});

	if (self !== top) {
		Promise.resolve($store.getTab(CONFLICT_TAB_KEY)).then((value) => value && block());
		return;
	}

	const report = async (how: string) => {
		console.warn('[OCS] 检测到另一个 OCS 实例：' + how);
		block();
		await $store.setTab(CONFLICT_TAB_KEY, { how, at: Date.now() });
		$message.warn({ content: CONFLICT_TEXT, duration: 0 });
	};

	// 新的页面加载重新检测（标签页存储在刷新后仍保留）
	Promise.resolve($store.setTab(CONFLICT_TAB_KEY, undefined)).then(() => {
		if (foreignBeforeStart) {
			report('另一个实例先启动');
			return;
		}
		const scan = () => {
			const panels = findForeignPanels(document, $elements.wrapper);
			if (panels.length) report(`页面上有 ${panels.length} 个其他悬浮窗`);
		};
		// 悬浮窗在页面可交互后挂载；答题最早在页面加载完成 5 秒后开始，这里在那之前检测
		const schedule = () => setTimeout(scan, 1500);
		if (document.readyState === 'complete') schedule();
		else window.addEventListener('load', schedule, { once: true });
	});
}
