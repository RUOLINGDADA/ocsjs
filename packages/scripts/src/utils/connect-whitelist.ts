import { $gm } from 'easy-us';

/**
 * 脚本白名单（`@connect`）检测
 *
 * 用户填自定义接口地址时，如果域名不在脚本头部的 `@connect` 列表中，
 * 脚本管理器会拦截 GM_xmlhttpRequest，表现为"连接失败"但看不到明确原因。
 * 这里统一做检测，供题库配置与 AI 题库配置共用。
 */

/** 返回不在白名单内的域名（去重）。空数组表示全部放行 */
export function getNotAllowedConnectHosts(urls: string[]): string[] {
	let connects: string[] = [];
	try {
		connects = $gm.getMetadataFromScriptHead('connect') || [];
	} catch {
		// 非脚本环境（如桌面端注入的全局上下文）取不到元数据，直接放行
		return [];
	}
	// 未声明 @connect 或声明了通配符：视为全部允许
	if (!connects.length || connects.includes('*')) return [];

	const notAllowed: string[] = [];
	for (const url of urls) {
		try {
			const host = new URL(url).hostname;
			if (!connects.some((connect) => host.includes(connect))) {
				notAllowed.push(host);
			}
		} catch {
			// URL 非法，忽略
		}
	}
	return Array.from(new Set(notAllowed));
}

/** 是否由「全域名通用版」提供（该版本已放行全部域名） */
export function isAllDomainScript(): boolean {
	try {
		return ($gm.getMetadataFromScriptHead('connect') || []).includes('*');
	} catch {
		return true;
	}
}
