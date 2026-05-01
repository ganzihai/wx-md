/**
 * 核心转换逻辑模块
 * 处理网页到 Markdown 的转换，包括微信公众号文章和通用网页
 */

import { fetchWithRetry, getArticleTitle, preprocessHtml, sanitizeFilename } from './utils';
import { generateHtmlWrapper } from './template';
import { replaceImageUrlsSync, uploadImagesToR2Async } from './r2-images';

/**
 * 清理 Markdown 中的冗余内容（轻量兜底）
 * 大部分噪音已在 HTML 层面通过 linkedom 清理，此处仅做最终微调：
 * 1. 删除开头的 YAML front matter (--- ... ---)
 * 2. 删除正文开头的 Markdown 标题行（兜底，避免与 Hugo front matter title 重复）
 * 3. 删除 AI 转换产生的"小说阅读器"幻觉三行
 * 4. 模糊匹配预期标题，删除任何匹配的标题行
 * 5. 删除"预览时标签不可点"及之后所有内容
 */
export function cleanMarkdown(content: string, expectedTitle?: string): string {
	// 1. 删除开头的 YAML front matter
	content = content.replace(/^---[\s\S]*?---\n*/m, '');

	// 2. 删除正文开头的 Markdown 标题行（支持 \r\n，兜底）
	content = content.replace(/^[\s\n\r]*#{1,6}\s+.+[\r\n]+/, '');

	// 3. 删除 AI 幻觉——小说阅读器三行噪音（非原文章内容，AI 转换时产生）
	content = content.replace(/在小说阅读器读本章[\s\n\r]*去阅读[\s\n\r]*在小说阅读器中沉浸阅读[\s\n\r]*/m, '');

	// 4. 模糊匹配预期标题（比精确匹配更鲁棒）
	if (expectedTitle) {
		const normTitle = expectedTitle.replace(/\s+/g, '').substring(0, 30);
		const titleRegex = /^#{1,6}\s+(.+)[\r\n]+/gm;
		content = content.replace(titleRegex, (match, captured) => {
			const normCap = captured.trim().replace(/\s+/g, '').substring(0, 30);
			if (normCap === normTitle) return '';
			return match;
		});
	}

	// 5. 从"预览时标签不可点"开始删除到末尾（最后兜底）
	content = content.replace(/预览时标签不可点[\s\S]*$/m, '');

	return content.trim();
}

/**
 * 处理网页转换为 Markdown 的核心逻辑
 * 支持 HTML 预览模式和纯 Markdown 模式
 * 返回 { title, markdown } 供内部调用，或直接返回 Response
 */
export async function convertWebpageToMarkdown(
	url: string,
	env: Env,
	ctx: ExecutionContext,
	fallbackTitle: string,
	isHtmlMode: boolean = false,
	download: boolean = false
): Promise<Response> {
	try {
		const { title, markdown: markdownContent } = await convertToMarkdownContent(url, env, ctx, fallbackTitle);

		// HTML 预览模式
		if (isHtmlMode) {
			const htmlResponse = generateHtmlWrapper(title, markdownContent);
			return new Response(htmlResponse, {
				status: 200,
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}

		// 纯 Markdown 模式
		const headers: HeadersInit = {
			'Content-Type': 'text/markdown; charset=utf-8',
		};

		if (download) {
			const safeFileName = sanitizeFilename(title);
			headers['Content-Disposition'] = `attachment; filename="${safeFileName}.md"`;
		}

		return new Response(markdownContent, { headers });
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error('处理请求时发生错误:', error);
		return new Response(`处理请求时发生错误: ${errorMessage}`, {
			status: 500,
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		});
	}
}

/**
 * 核心转换函数，返回 { title, markdown } 供推送模块复用
 */
export async function convertToMarkdownContent(
	url: string,
	env: Env,
	ctx: ExecutionContext,
	fallbackTitle: string
): Promise<{ title: string; markdown: string }> {
	console.log(`请求网页内容: ${url}`);

	// 请求网页内容
	const articleResponse = await fetchWithRetry(url);

	if (!articleResponse.ok) {
		console.error(`无法获取网页内容，状态码: ${articleResponse.status}`);
		throw new Error(`无法获取网页内容，状态码: ${articleResponse.status}`);
	}

	// 获取原始 HTML 内容
	const htmlContent = await articleResponse.text();

	// 预处理 HTML 内容，处理懒加载图片
	const processedHtml = preprocessHtml(htmlContent);

	// 提取文章标题用于文件名
	const title = getArticleTitle(processedHtml, fallbackTitle);

	// 将 HTML 内容转换为 Markdown
	console.log('开始转换为 Markdown');
	const mdResult = await env.AI.toMarkdown([
		{
			name: `${title}.html`,
			blob: new Blob([processedHtml], { type: 'text/html' }),
		},
	]);

	if (!mdResult || mdResult.length === 0) {
		throw new Error('Markdown 转换失败');
	}

	// 获取转换后的 Markdown 内容
	const result = mdResult[0];
	if (!('data' in result) || !result.data) {
		throw new Error('Markdown 转换失败: 无法获取转换结果');
	}
	let markdown = result.data;

	// 同步替换图片链接为 wsrv.nl 代理链接
	markdown = replaceImageUrlsSync(processedHtml, markdown, env);

	// 清理微信文章冗余内容
	markdown = cleanMarkdown(markdown, title);

	// 异步上传图片（当前为空操作）
	ctx.waitUntil(uploadImagesToR2Async(processedHtml, markdown, env));

	return { title, markdown };
}

/**
 * 处理通用网页转 Markdown 请求
 * 解析 URL 参数并调用核心转换函数
 */
export async function handleGenericWebpage(
	url: URL,
	env: Env,
	ctx: ExecutionContext,
	isHtmlMode: boolean = false
): Promise<Response> {
	const targetUrl = url.searchParams.get('url');
	if (!targetUrl) {
		return new Response('缺少必要的url参数，请提供要转换的网页地址', {
			status: 400,
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		});
	}

	let decodedUrl;
	try {
		decodedUrl = decodeURIComponent(targetUrl);
	} catch (e) {
		// 如果URL已经是解码状态，直接使用
		decodedUrl = targetUrl;
	}

	try {
		// 验证URL是否有效
		const urlObj = new URL(decodedUrl);
		const fallbackId = urlObj.hostname + urlObj.pathname.replace(/\//g, '_');

		// 检查是否请求下载文件
		const download = url.searchParams.get('download') === 'true';

		return await convertWebpageToMarkdown(decodedUrl, env, ctx, fallbackId, isHtmlMode, download);
	} catch (e) {
		return new Response(`无效的URL: ${decodedUrl}`, {
			status: 400,
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		});
	}
}
