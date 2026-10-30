// @ts-check

const { series } = require('gulp');
const del = require('del');
const util = require('util');
/**
 * 发布版本号：必须高于官方版（当前 5.2.3），脚本管理器才会把安装视为「更新」直接覆盖官方脚本。
 * 发布工作流用 git 标签（如 v6.0.1）传入 RELEASE_VERSION，本地构建使用默认值。
 */
const RELEASE_VERSION = String(process.env.RELEASE_VERSION || '6.0.0').replace(/^v/, '');
/** 发布仓库（GitHub Actions 中自动取当前仓库） */
const RELEASE_REPO = process.env.GITHUB_REPOSITORY || 'RUOLINGDADA/ocsjs';
/** 最新 Release 的附件地址：脚本管理器从这里检查和下载更新 */
const releaseAsset = (name) => `https://github.com/${RELEASE_REPO}/releases/latest/download/${name}`;
/** @type {(...args: any[])=> Promise<void>} */
const execOut = util.promisify(require('./utils').execOut);
const { createUserScript, createMetaFile } = require('../packages/utils');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const { build: buildStyle } = require('./build-style');

dotenv.config();

const distPath = process.env.BUILD_PATH || '../dist';
console.log('BUILD_PATH: ', distPath);
const distResolvedPath = path.resolve(__dirname, distPath);

function cleanOutput() {
	return del([distPath, '../lib'], { force: true });
}

async function testResolver() {
	await execOut('tsx ../tests/resolver.test.ts');
}

async function buildPackages() {
	await execOut('tsc', { cwd: '../packages/core' });
	await execOut('vite build', { cwd: '../packages/core' });
	await execOut('tsc', { cwd: '../packages/scripts' });
	await execOut('vite build', { cwd: '../packages/scripts' });
}

async function createUserJs() {
	/** 模拟浏览器环境 */
	require('browser-env')();

	/** 先编译样式（easy-us 基础样式 + OCS 自定义样式），保证 style.css 为最新 */
	await buildStyle();
	const CSS_PATH = path.join(__dirname, '../packages/scripts/assets/css/style.css')

	// @ts-ignore
	globalThis.unsafeWindow = {};

	/** @type {import('../packages/scripts/src/index')} */
	// @ts-ignore
	const ocs = require(path.join(distPath, 'index.js'));

	/** @return {import('../packages/utils').CreateOptions} */
	const createOptions = () => {
		const { CXProject, ZHSProject, ZJYProject, IcveMoocProject, ICourseProject, YKTProject } = ocs;
		const projectList = [CXProject, ZHSProject, ZJYProject, IcveMoocProject, ICourseProject, YKTProject]
			.map((s) => `【${s.name}】`)
			.join(' ');

		const matchMetadata = Array.from(
			new Set(
				ocs
					.definedProjects()
					.map((p) => (p.domains || []).map((d) => `*://*.${d}/*`))
					.flat()
			)
		);

		return {
			parseRequire: true,
			parseResource: true,
			resourceBuilder: (key, value) => `const ${key} = \`${value}\`;`,
			metaDataFormatter: {
				header: '==UserScript==',
				footer: '==/UserScript==',
				prefix: '// ',
				symbol: '@',
				gap: '\t'.repeat(4)
			},
			metadata: {
				// ===== 与官方版相同的脚本标识 =====
				// 脚本管理器（Tampermonkey / ScriptCat）以 name + namespace 识别同一个脚本：
				// 安装本构建会直接覆盖官方版，官方版不会和本构建同时运行。
				name: 'OCS 网课助手',
				namespace: 'https://enncy.cn',
				version: RELEASE_VERSION,
				// 更新地址指向本仓库的最新 Release：只会更新到本仓库发布的版本，不会被官方版覆盖回去
				downloadURL: releaseAsset('ocs.user.js'),
				updateURL: releaseAsset('ocs.meta.js'),
				supportURL: `https://github.com/${RELEASE_REPO}/issues`,
				description: [
					'OCS(online-course-script) 网课助手（本地改造版）：在固定题库之外支持自定义大模型接口答题，失败自动重试。',
					'脚本原项目 https://docs.ocsjs.com ，专注于帮助大学生从网课中释放出来，',
					'让自己的时间把握在自己的手中，拥有人性化的操作页面，流畅的步骤提示，支持 ',
					projectList,
					`等网课的学习，作业。使用说明见 https://github.com/${RELEASE_REPO}`
				].join(' '),
				author: 'enncy',
				license: 'MIT',
				homepage: 'https://docs.ocsjs.com',
				source: `https://github.com/${RELEASE_REPO}`,
				icon: 'https://cdn.ocsjs.com/logo.png',
				connect: ['enncy.cn', 'icodef.com', 'ocsjs.com', 'zaizhexue.top', 'localhost', '127.0.0.1',
					// 智慧树阿里云资源，应用： 图片题资源访问
					'aliyuncs.com',
					// ===== AI 题库（大模型接口）预置域名 =====
					// 说明：自定义/自建网关无法穷举，官方版未覆盖的域名需使用「全域名通用版」
					// （ocs.common.user.js 会追加 @connect *），或在脚本管理器中手动添加 @connect。
					// OpenAI
					'api.openai.com',
					// Anthropic
					'api.anthropic.com',
					// Google Gemini
					'generativelanguage.googleapis.com',
					// DeepSeek
					'api.deepseek.com',
					// Moonshot Kimi
					'api.moonshot.cn',
					// 智谱 GLM
					'open.bigmodel.cn',
					// 硅基流动
					'api.siliconflow.cn',
					// OpenRouter
					'openrouter.ai',
					// Groq
					'api.groq.com',
					// Azure OpenAI（*.openai.azure.com）
					'openai.azure.com'],
				match: matchMetadata,
				grant: [
					'GM_info',
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
				],
				require: [path.join(__dirname, distPath, 'index.js')],
				resource: [`STYLE ${CSS_PATH}`],
				'run-at': 'document-start',
				antifeature: 'payment'
			},
			entry: path.join(__dirname, '../packages/scripts/entry.js'),
			dist: path.join(__dirname, distPath, 'ocs.user.js')
		};
	};

	const officialOpts = createOptions();
	console.log('CreateUserScript: ', officialOpts.metadata.name, officialOpts.dist);
	await createUserScript(officialOpts);
	console.log('createMetaFile: ', path.join(distResolvedPath, 'ocs.meta.js'));
	await createMetaFile({ dist: officialOpts.dist, metaDist: path.join(distResolvedPath, 'ocs.meta.js') });

	/** 创建调试脚本 */
	const devOpts = createOptions();
	devOpts.parseRequire = false;
	devOpts.parseResource = false;
	devOpts.metadata.name = devOpts.metadata.name + '(dev)';
	// 开发版从本地文件加载，不检查更新
	devOpts.metadata.downloadURL = 'none';
	devOpts.metadata.updateURL = 'none';
	devOpts.metadata.require = ['file:///' + path.join(distResolvedPath, 'index.js')];
	devOpts.metadata.resource = [`STYLE file:///${CSS_PATH}`];
	devOpts.entry = path.join(__dirname, '../packages/scripts/entry.dev.js');
	devOpts.dist = path.join(distResolvedPath, 'ocs.dev.user.js');
	/** 导出样式文件 */
	fs.copyFileSync(
		CSS_PATH,
		path.join(distResolvedPath, 'style.css')
	);
	console.log('createUserScript: ', devOpts.metadata.name, devOpts.dist);
	await createUserScript(devOpts);

	/** 创建全Connect域名通用脚本 */
	const commonOpts = createOptions();
	// 通用版与标准版使用同一标识（只多了 @connect *），两者互相覆盖，不会同时运行
	const connect = Array.isArray(commonOpts.metadata.connect) ? commonOpts.metadata.connect : [];
	connect.push('*');
	commonOpts.metadata.connect = connect;
	// 通用版从 Release 里的通用版文件更新，不会被更新成标准版
	commonOpts.metadata.downloadURL = releaseAsset('ocs.common.user.js');
	commonOpts.metadata.updateURL = releaseAsset('ocs.common.user.js');
	commonOpts.entry = path.join(__dirname, '../packages/scripts/entry.common.js');
	commonOpts.dist = path.join(distResolvedPath, 'ocs.common.user.js');

	console.log('createUserScript: ', commonOpts.metadata.name, commonOpts.dist);
	await createUserScript(commonOpts);
}

exports.default = series(cleanOutput, testResolver, buildPackages, createUserJs);
