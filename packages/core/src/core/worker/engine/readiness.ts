/**
 * 页面就绪协调
 *
 * 问题：超星等平台的题目文字用加密字体渲染，脚本需要先异步解密再读题。
 * 解密和答题是两个独立脚本（甚至运行在不同的脚本实例里：章节测试的 iframe 有自己的实例，
 * 答题却由顶层实例驱动），旧实现中答题线程会在解密完成前读到第一题的密文，
 * 于是「跳转后第一题老是答不上」。
 *
 * 方案：在文档根元素上用 data 属性登记「忙碌原因」，属性写在 DOM 上，
 * 同一文档内的任意脚本实例都能看到；答题引擎读题前等待所有忙碌原因解除。
 */

const BUSY_ATTR = 'data-ocs-busy';

function readReasons(doc: Document): string[] {
	const raw = doc.documentElement?.getAttribute(BUSY_ATTR) || '';
	return raw.split(' ').filter(Boolean);
}

function writeReasons(doc: Document, reasons: string[]) {
	const el = doc.documentElement;
	if (!el) return;
	if (reasons.length) el.setAttribute(BUSY_ATTR, reasons.join(' '));
	else el.removeAttribute(BUSY_ATTR);
}

/**
 * 登记文档忙碌（如字体解密进行中），返回释放函数。
 * 同一原因可重复登记，按次数释放。
 */
export function markDocumentBusy(doc: Document, reason: string): () => void {
	const token = reason.replace(/\s+/g, '-');
	writeReasons(doc, [...readReasons(doc), token]);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const reasons = readReasons(doc);
		const index = reasons.indexOf(token);
		if (index !== -1) reasons.splice(index, 1);
		writeReasons(doc, reasons);
	};
}

/** 文档当前的忙碌原因 */
export function getDocumentBusyReasons(doc: Document): string[] {
	return readReasons(doc);
}

export interface ReadinessOptions {
	/** 最长等待（毫秒），超时后放行，默认 30000 */
	timeoutMs?: number;
	/** 轮询间隔（毫秒），默认 100 */
	pollMs?: number;
	/** 平台自定义的额外就绪条件 */
	check?: (doc: Document) => boolean;
	/** 关闭检查：返回 true 时立即结束等待 */
	cancelled?: () => boolean;
}

/**
 * 等待文档就绪：加载完成 + 没有忙碌登记 + 自定义条件成立。
 * @returns 是否在超时前就绪（超时也会返回，调用方自行决定是否继续）
 */
export async function waitForDocumentReady(doc: Document, opts: ReadinessOptions = {}): Promise<boolean> {
	const timeoutMs = opts.timeoutMs ?? 30000;
	const pollMs = Math.max(10, opts.pollMs ?? 100);
	const started = Date.now();
	const isReady = () => {
		if (doc.readyState === 'loading') return false;
		if (readReasons(doc).length) return false;
		try {
			return opts.check ? opts.check(doc) : true;
		} catch {
			return true;
		}
	};
	while (!isReady()) {
		if (opts.cancelled?.()) return false;
		if (Date.now() - started >= timeoutMs) return false;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	return true;
}
