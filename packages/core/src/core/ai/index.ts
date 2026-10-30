/**
 * AI 题库（AI 答题）模块
 *
 * 与固定题库（answer-wrapper）并列的一套「答题来源」：
 * 固定题库靠 `url + handler` 请求第三方题库接口；AI 题库靠大模型直接作答。
 * 两者最终都产出 `SearchInformation[]`，下游的选项匹配、结果面板完全复用。
 */
export * from './interface';
export * from './presets';
export * from './prompt';
export * from './providers';
export * from './parser';
export * from './transport';
export * from './answerer';
