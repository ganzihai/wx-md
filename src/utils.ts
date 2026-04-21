/**
 * 工具函数模块
 * 包含 HTTP 请求、HTML 处理、标题提取等通用功能
 */

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
 * 统一提取代码块内文本：
 * - 把 <br> / <br/> 换成换行
 * - 剥掉所有 HTML 标签
 * - 解码常见 HTML 实体
 */
function extractCodeText(raw: string): string {
	return raw
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.trim();
}

/**
 * 标准化微信代码块为 <pre><code> 格式
 * 处理四种微信/通用常见的代码块结构，让 toMarkdown 能正确识别为多行代码块
 *
 * 处理顺序（从高优先级到低）：
 *  1. <section data-lang="...">  微信专用代码块（带语言）
 *  2. <pre> 裸标签 / <pre class="...">  通用预格式化文本
 *  3. <code> 内含 <br> 换行（微信把多行代码渲染成 <br> 分隔）
 *  4. 不含换行的单行 <code> 保持不变（行内代码，不处理）
 */
function normalizeCodeBlocks(html: string): string {
	// 模式1：微信 <section data-lang="language"> ... </section> 代码块
	html = html.replace(
		/<section[^>]+data-lang=["']([^"']*)["'][^>]*>([\s\S]*?)<\/section>/gi,
		(_, lang, content) => {
			const code = extractCodeText(content);
			const langAttr = lang ? ` class="language-${lang}"` : '';
			return `<pre><code${langAttr}>${code}</code></pre>`;
		}
	);

	// 模式2：<pre> 标签（含或不含 class），内部可能有 <code> 或裸文本
	// 统一规整为 <pre><code class="language-xxx">...</code></pre>
	html = html.replace(
		/<pre([^>]*)>([\s\S]*?)<\/pre>/gi,
		(_, attrs, content) => {
			// 从已有 class / data-lang 里尝试提取语言
			const langMatch = attrs.match(/(?:class|data-lang)=["'][^"']*?(?:language-)?([a-zA-Z0-9+#\-]+)["']/i);
			const lang = langMatch ? langMatch[1] : '';
			const langAttr = lang ? ` class="language-${lang}"` : '';

			// 如果内部已经有 <code>，直接提取文本；否则视为裸文本
			const hasCode = /<code[\s>]/i.test(content);
			const code = hasCode
				? content.replace(/<\/?code[^>]*>/gi, (m: string) => extractCodeText(m))  // 剥掉 <code> 包装再提取
				: extractCodeText(content);

			// 重新用 extractCodeText 清理一遍（处理嵌套标签残留）
			const cleanCode = extractCodeText(hasCode ? content : `<x>${code}</x>`);
			return `<pre><code${langAttr}>${cleanCode}</code></pre>`;
		}
	);

	// 模式3：<code> 内含 <br> 换行的多行代码（微信把换行渲染为 <br>，但未包在 <pre> 里）
	html = html.replace(
		/<code([^>]*)>([\s\S]*?<br[\s\S]*?)<\/code>/gi,
		(_, attrs, content) => {
			const code = extractCodeText(content);
			return `<pre><code${attrs}>${code}</code></pre>`;
		}
	);

	return html;
}

/**
 * 预处理 HTML 内容
 * 1. 标准化微信代码块为 <pre><code> 格式
 * 2. 处理懒加载图片的 data-src 属性，将其转换为 src 属性
 */
export function preprocessHtml(html: string): string {
	// 第一步：标准化代码块
	html = normalizeCodeBlocks(html);

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
