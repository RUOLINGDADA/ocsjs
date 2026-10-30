import { Project } from 'easy-us';
import { CommonProject } from './projects/common';
import { ZHSProject } from './projects/zhs';
import { CXProject } from './projects/cx';
import { BackgroundProject } from './projects/background';
import { IcveMoocProject } from './projects/icve';
import { ZJYProject } from './projects/zjy';
import { ICourseProject } from './projects/icourse';
import { YKTProject } from './projects/yuketang';

/** 导出所有的 OCS 核心模块 */
export * from '@ocsjs/core';
/** 导出启动函数，以及全局对象 */
export { start, $elements, $store } from 'easy-us';
/** 导出本包的核心脚本工程，开发者调试的时候使用 BackgroundProject 中的注入脚本，访问脚本 window 上下文 */
export { BackgroundProject } from './projects/background';
export { CommonProject } from './projects/common';
export { ZHSProject } from './projects/zhs';
export { CXProject } from './projects/cx';
export { ZJYProject } from './projects/zjy';
export { IcveMoocProject } from './projects/icve';
export { ICourseProject } from './projects/icourse';
export { YKTProject } from './projects/yuketang';
export { RenderScript } from './render';
export { logoSvg } from './utils/ui';
export { detectForeignInstanceBeforeStart, startInstanceGuard } from './utils/instance-guard';
export {
	setAnswererConfigProvider,
	getAnswererConfigProvider,
	openAnswererConnect,
	waitForAnswererConfig
} from './utils/answerer-connect';
export type { AnswererConfigProvider } from './utils/answerer-connect';
/** AI 题库（AI 答题）对外接口，供控制台调试与二次开发使用 */
export { getAiSettings, normalizeProfile, normalizeProfiles, saveAiProfiles } from './utils/ai/config';
export type { AiAnswerMode, AiSettings } from './utils/ai/config';
export { askAiSearch, hasUsableAnswerer, runAnswererPipeline, resetAiAnswererRuntime } from './utils/ai/answerer';
export { createAiAnswererPanel, openAiProfileEditor } from './utils/ai/ui';

export function definedProjects(): Project[] {
	return [
		ZHSProject,
		CXProject,
		IcveMoocProject,
		ZJYProject,
		ICourseProject,
		YKTProject,
		CommonProject,
		BackgroundProject
	];
}
