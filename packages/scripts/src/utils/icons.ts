/**
 * 线性图标（24×24 网格，1.75 描边，跟随文字颜色）。
 * 替代原先的 emoji：emoji 在不同系统上渲染差异大，没有 emoji 字体时直接显示成方块。
 */
const SVG_ATTRS = [
	'xmlns="http://www.w3.org/2000/svg"',
	'viewBox="0 0 24 24"',
	'fill="none"',
	'stroke="currentColor"',
	'stroke-width="1.75"',
	'stroke-linecap="round"',
	'stroke-linejoin="round"',
	'aria-hidden="true"'
].join(' ');

const svg = (paths: string, size = 16) => `<svg ${SVG_ATTRS} width="${size}" height="${size}">${paths}</svg>`;

export const icons = {
	home: svg('<path d="M4 10.5 12 4l8 6.5"/><path d="M6 9v10h12V9"/><path d="M10 19v-5h4v5"/>'),
	results: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 2.5 2.5L16 9"/>'),
	settings: svg(
		'<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h4"/><path d="M12 17h8"/><circle cx="10" cy="17" r="2"/>'
	),
	model: svg(
		'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M10 10h4v4h-4z"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>'
	),
	console: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>'),
	study: svg('<circle cx="12" cy="12" r="8.5"/><path d="M10 8.5v7l5.5-3.5z"/>'),
	pause: svg('<path d="M9 5v14M15 5v14"/>', 14),
	play: svg('<path d="M7 5v14l11-7z"/>', 14),
	restart: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>', 14),
	download: svg('<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>', 28)
};

export type IconName = keyof typeof icons;
