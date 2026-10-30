/* eslint-disable no-undef, max-len */
/// <reference path="./global.d.ts" />

// 环境检测
if (
	[
		'GM_getTab',
		'GM_saveTab',
		'GM_setValue',
		'GM_getValue',
		'unsafeWindow',
		'GM_listValues',
		'GM_deleteValue',
		'GM_notification',
		'GM_xmlhttpRequest',
		'GM_getResourceText',
		'GM_addValueChangeListener',
		'GM_removeValueChangeListener'
	].some((api) => typeof Reflect.get(globalThis, api) === 'undefined')
) {
	const open = confirm(
		`OCS网课脚本不支持当前的脚本管理器（${GM_info.scriptHandler}）。` +
		'请前往 https://docs.ocsjs.com/docs/script 下载指定的脚本管理器，例如 “Scriptcat 脚本猫” 或者 “Tampermonkey 油猴”'
	);

	if (open) {
		window.location.href = 'https://docs.ocsjs.com/docs/script';
	}
	return;
}

const {
	start,
	definedProjects,
	CommonProject,
	RenderScript,
	logoSvg,
	detectForeignInstanceBeforeStart,
	startInstanceGuard
} = OCS;

const infos = GM_info;

(function () {
	'use strict';

	/**
	 * 单实例锁：同一页面只允许一个 OCS 实例运行。
	 * 标准版、通用版、开发版或其他渠道安装的副本同时启用时，后启动的实例自动停用，
	 * 避免两个实例同时答题、重复提交。锁写在文档根元素上，同一文档内的脚本实例都能看到。
	 */
	const LOCK_ATTR = 'data-ocs-instance';
	const root = document.documentElement;
	const owner = root && root.getAttribute(LOCK_ATTR);
	if (owner) {
		console.warn(`[OCS] 当前页面已有 OCS 实例在运行（${owner}），本实例（${infos.script.name} ${infos.script.version}）已停用。`);
		return;
	}
	// 另一个 OCS（旧的 AI 版、其他脚本管理器里的官方版）先启动了：仍然显示悬浮窗说明情况，但不答题
	detectForeignInstanceBeforeStart();
	if (root) root.setAttribute(LOCK_ATTR, `${infos.script.name} ${infos.script.version}`);

	start({
		projects: definedProjects(),
		renderConfig: {
			renderScript: RenderScript,
			styles: [STYLE],
			defaultPanelName: CommonProject.scripts.guide.namespace,
			title: `${logoSvg}<span class="ocs-brand">OCS</span><span class="ocs-version">${infos.script.version}</span>`
		},
		// 不跟随官方更新：「前往更新」会把本构建覆盖回官方版
		updatePage: ''
	});

	startInstanceGuard();
})();
