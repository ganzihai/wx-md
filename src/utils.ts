/**
 * 工具函数模块
 * 包含 HTTP 请求、HTML 处理、标题提取等通用功能
 */

import { cleanArticleHtml } from './cleaner';

/**
 * 带重试功能的 fetch 请求
 * 支持自定义 Referer 和错误重试
 */
export async function fetchWithRetry(url: string, retries = 3, delay = 1000, customReferer?: string): Promise<Response> {
	const urlObj = new URL(url);
	const defaultReferer = `${urlObj.protocol}//${urlObj.hostname}`;

	const headers = {
		'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		Accept: 'text/html,application/xhtml+xml,application/xml',
		'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
		'Cache-Control': 'no-cache',
		Pragma: 'no-cache',
		Referer: customReferer || defaultReferer,
	};

	for (let i = 0; i < retries; i++) {
		try {
			return await fetch(url, { headers });
		} catch (error) {
			if (i === retries - 1) throw error;
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.log(`请求失败 (${i + 1}/${retries})，${delay}ms 后重试: ${errorMessage}`);
			await new Promise((resolve) => setTimeout(resolve, delay));
			delay *= 1.5;
		}
	}

	throw new Error('超过最大重试次数');
}

/**
 * 解码常见 HTML 实体
 */
export function decodeHtmlEntities(str: string): string {
	return str
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ');
}

/**
 * 从 HTML 内容中提取文章标题
 */
export function getArticleTitle(html: string, fallbackId: string): string {
	const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["'](.*?)["']\s*\/?>/i);
	const twitterTitleMatch = html.match(/<meta\s+property=["']twitter:title["']\s+content=["'](.*?)["']\s*\/?>/i);
	const titleTagMatch = html.match(/<title>(.*?)<\/title>/i);

	let title = '';
	if (ogTitleMatch && ogTitleMatch[1]) {
		title = ogTitleMatch[1].trim();
	} else if (twitterTitleMatch && twitterTitleMatch[1]) {
		title = twitterTitleMatch[1].trim();
	} else if (titleTagMatch && titleTagMatch[1]) {
		title = titleTagMatch[1].trim();
	} else {
		title = `wechat-article-${fallbackId}`;
	}

	// 解码 HTML 实体，并进行基础清洗
	return decodeHtmlEntities(title)
		.replace(/[\r\n]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.substring(0, 200);
}

/**
 * 将标题转换为安全的文件名
 */
export function sanitizeFilename(title: string): string {
	return title
		.replace(/\s+/g, '_')
		.replace(/[\\/:*?"<>|]/g, '')
		.replace(/[^\w\u4e00-\u9fa5_\-.]/g, '')
		.substring(0, 100);
}

/**
 * HTML内容转义
 */
export function escapeHtml(unsafe: string): string {
	return unsafe
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

/**
 * HTML属性值转义（用于双引号包裹的属性）
 */
export function escapeHtmlAttr(unsafe: string): string {
	return unsafe
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;');
}

/**
 * 预处理 HTML 内容
 * 1. DOM 级深度清理（方案B核心，使用 linkedom）
 * 2. 处理懒加载图片的 data-src 属性，将其转换为 src 属性
 */
export function preprocessHtml(html: string): string {
	// 第一步：DOM 级深度清理（移除标题、作者信息、噪音内容、标准化代码块）
	html = cleanArticleHtml(html);

	// 第二步：处理懒加载图片
	return html.replace(/<img\s+([^>]*?)data-src=["']([^"']+)["']([^>]*)>/gi, (match, before, dataSrc, after) => {
		const otherAttrs = before + after;
		const srcMatch = otherAttrs.match(/src=["']([^"']*)["']/i);
		const srcValue = srcMatch ? srcMatch[1] : '';

		if (!srcValue || srcValue.startsWith('data:')) {
			const cleanedBefore = before.replace(/src=["'][^"']*["']\s*/gi, '');
			const cleanedAfter = after.replace(/src=["'][^"']*["']\s*/gi, '');
			const safeSrc = escapeHtmlAttr(dataSrc);
			return `<img ${cleanedBefore}src="${safeSrc}" data-src="${safeSrc}"${cleanedAfter}>`;
		}

		return match;
	});
}
