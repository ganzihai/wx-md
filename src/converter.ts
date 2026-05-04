/**
 * 核心转换逻辑模块
 * 处理网页到 Markdown 的转换，包括微信公众号文章和通用网页
 */

import { fetchWithRetry, getArticleTitle, preprocessHtml, sanitizeFilename } from './utils';
import { generateHtmlWrapper } from './template';
import { replaceImageUrlsSync, uploadImagesToR2Async } from './r2-images';

/**
 * 清理 Markdown 中的冗余内容（轻量底底）
 */
export function cleanMarkdown(content: string, expectedTitle?: string): string {
	// 1. 删除开头的 YAML front matter
	content = content.replace(/^---[\s\S]*?---\n*/m, '');

	// 2. 删除正文开头的 Markdown 标题行
	content = content.replace(/^[\s\n\r]*#{1,6}\s+.+[\r\n]+/, '');

	// 3. 删除 AI 幻觉——小说阅读器三行噪音
	content = content.replace(/在小说阅读器读本章[\s\n\r]*去阅读[\s\n\r]*在小说阅读器中沉浸阅读[\s\n\r]*/m, '');

	// 4. 模糊匹配预期标题
	if (expectedTitle) {
		const normTitle = expectedTitle.replace(/\s+/g, '').substring(0, 30);
		const titleRegex = /^#{1,6}\s+(.+)[\r\n]+/gm;
		content = content.replace(titleRegex, (match, captured) => {
			const normCap = captured.trim().replace(/\s+/g, '').substring(0, 30);
			if (normCap === normTitle) return '';
			return match;
		});
	}

	// 5. 从"预览时标签不可点"开始删除到末尾
	content = content.replace(/预览时标签不可点[\s\S]*$/m, '');

	return content.trim();
}

/**
 * 调用 Gemini 对 Markdown 进行二次清洗和标题提取
 * 返回 { title, content }
 */
async function processWithGemini(
	rawMarkdown: string,
	fallbackTitle: string,
	geminiApiKey: string
): Promise<{ title: string; content: string }> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${geminiApiKey}`;

	const promptText = `你是一个专业的文字编辑与 Markdown 排版专家。请处理以下来自微信公众号的 Markdown 文本：

${rawMarkdown}

要求：
1. 提取文章的核心标题，如果无法确定则使用“${fallbackTitle}”。
2. 去除开头结尾的关注引导、广告推广、转发点赞、分享收藏等噪音。
3. 修复并规范 Markdown 语法（代码块、列表、标题级别）。
4. 正文中不要包含标题行（即不要以 # 开头的标题）。
5. 保留所有图片链接不要删除。
请严格以 JSON 格式输出：{"title": "提取的标题", "content": "清理并排版后的正文 Markdown"}`;

	const requestBody = JSON.stringify({
		contents: [{ role: 'user', parts: [{ text: promptText }] }],
		generationConfig: { responseMimeType: 'application/json' },
	});

	for (let i = 0; i < 3; i++) {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: requestBody,
		});

		const data = await response.json() as any;

		if (data.candidates && data.candidates.length > 0) {
			const jsonString = data.candidates[0].content.parts[0].text;
			return JSON.parse(jsonString) as { title: string; content: string };
		}

		const code = data.error?.code;
		if ((code === 503 || code === 429) && i < 2) {
			await new Promise(r => setTimeout(r, 2000 * (i + 1)));
			continue;
		}

		throw new Error(`Gemini API 异常: ${JSON.stringify(data)}`);
	}

	throw new Error('Gemini API 重试 3 次后仍失败');
}

/**
 * 处理网页转换为 Markdown 的核心逻辑
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

		if (isHtmlMode) {
			const htmlResponse = generateHtmlWrapper(title, markdownContent);
			return new Response(htmlResponse, {
				status: 200,
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}

		const headers: HeadersInit = { 'Content-Type': 'text/markdown; charset=utf-8' };
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

	const articleResponse = await fetchWithRetry(url);
	if (!articleResponse.ok) {
		throw new Error(`无法获取网页内容，状态码: ${articleResponse.status}`);
	}

	const htmlContent = await articleResponse.text();
	const processedHtml = preprocessHtml(htmlContent);

	// 从 HTML meta 提取原始标题（用于 fallback）
	const htmlTitle = getArticleTitle(processedHtml, fallbackTitle);

	// 用 Workers AI 将 HTML 转为初步 Markdown
	console.log('开始转换为 Markdown');
	const mdResult = await env.AI.toMarkdown([
		{
			name: `${htmlTitle}.html`,
			blob: new Blob([processedHtml], { type: 'text/html' }),
		},
	]);

	if (!mdResult || mdResult.length === 0) {
		throw new Error('Markdown 转换失败');
	}

	const result = mdResult[0];
	if (!('data' in result) || !result.data) {
		throw new Error('Markdown 转换失败: 无法获取转换结果');
	}
	let markdown = result.data;

	// 同步替换图片链接为 wsrv.nl 代理链接
	markdown = replaceImageUrlsSync(processedHtml, markdown, env);

	// 异步上传图片（当前为空操作）
	ctx.waitUntil(uploadImagesToR2Async(processedHtml, markdown, env));

	// 如果配置了 Gemini API Key，进行二次清洗
	if (env.GEMINI_API_KEY) {
		console.log('开始 Gemini 二次清洗');
		try {
			const geminiResult = await processWithGemini(markdown, htmlTitle, env.GEMINI_API_KEY);
			return {
				title: geminiResult.title || htmlTitle,
				markdown: geminiResult.content,
			};
		} catch (e) {
			// Gemini 失败时降级到正则清洗结果
			console.error('Gemini 清洗失败，降级到正则清洗:', e);
			markdown = cleanMarkdown(markdown, htmlTitle);
			return { title: htmlTitle, markdown };
		}
	}

	// 没有 Gemini Key 则用原有正则清洗
	markdown = cleanMarkdown(markdown, htmlTitle);
	return { title: htmlTitle, markdown };
}

/**
 * 处理通用网页转 Markdown 请求
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
		decodedUrl = targetUrl;
	}

	try {
		const urlObj = new URL(decodedUrl);
		const fallbackId = urlObj.hostname + urlObj.pathname.replace(/\//g, '_');
		const download = url.searchParams.get('download') === 'true';
		return await convertWebpageToMarkdown(decodedUrl, env, ctx, fallbackId, isHtmlMode, download);
	} catch (e) {
		return new Response(`无效的URL: ${decodedUrl}`, {
			status: 400,
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		});
	}
}
