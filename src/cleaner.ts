/**
 * HTML 清理模块
 * 使用 linkedom 进行 DOM 级别的微信文章噪音清理，替代原有正则方案
 */

import { parseHTML } from 'linkedom';
import { decodeHtmlEntities } from './utils';

/**
 * 检查是否为微信文章 HTML
 */
function isWechatArticle(doc: Document): boolean {
	return !!doc.querySelector('#js_content');
}

/**
 * 判断元素是否匹配噪音文本模式
 */
function matchesNoiseText(el: Element, noisePatterns: RegExp[]): boolean {
	const text = (el.textContent || '').trim().slice(0, 50);
	return noisePatterns.some((p) => p.test(text));
}

/**
 * 删除满足噪声文本模式的子元素
 */
function removeNoiseByText(doc: Document, selector: string, noisePatterns: RegExp[]): void {
	doc.querySelectorAll(selector).forEach((el) => {
		if (matchesNoiseText(el, noisePatterns)) {
			el.remove();
		}
	});
}

/**
 * 从 HTML 中提取代码文本
 * - <br> 转换行
 * - 保留语法高亮标签（剥离属性只留标签名）
 * - 解码 HTML 实体
 */
function extractCodeText(raw: string): string {
	let text = raw.replace(/<br\s*\/?>/gi, '\n');
	// 剥离标签属性但保留标签名（用于保留语法高亮结构）
	text = text.replace(/<(\/?)(\w+)[^>]*>/gi, '<$1$2>');
	return decodeHtmlEntities(text).trim();
}

/**
 * 标准化微信代码块为 <pre><code> 格式
 * 处理五种微信/通用常见的代码块结构
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
	html = html.replace(
		/<pre([^>]*)>([\s\S]*?)<\/pre>/gi,
		(_, attrs, content) => {
			const langMatch = attrs.match(/(?:class|data-lang)=["'][^"']*?(?:language-)?([a-zA-Z0-9+#\-]+)["']/i);
			const lang = langMatch ? langMatch[1] : '';
			const langAttr = lang ? ` class="language-${lang}"` : '';

			const hasCode = /<code[\s>]/i.test(content);
			let cleanCode: string;
			if (hasCode) {
				cleanCode = extractCodeText(content.replace(/<\/?code[^>]*>/gi, ''));
			} else {
				cleanCode = extractCodeText(content);
			}

			return `<pre><code${langAttr}>${cleanCode}</code></pre>`;
		}
	);

	// 模式3：<code> 内含多个 <br> 的多行代码（微信把换行渲染为 <br>）
	// 仅当 <br> 出现 ≥2 次 或 代码文本 > 80 字符时才包装为 <pre>
	html = html.replace(
		/<code([^>]*)>([\s\S]*?)<\/code>/gi,
		(_, attrs, content) => {
			const brCount = (content.match(/<br\s*\/?>/gi) || []).length;
			const textOnly = content.replace(/<[^>]+>/g, '').trim();
			// 不含 <br> 或只有1个 <br> 且文本短 → 保持为行内代码
			if (brCount < 2 && textOnly.length <= 80) {
				return `<code${attrs}>${extractCodeText(content)}</code>`;
			}
			const code = extractCodeText(content);
			return `<pre><code${attrs}>${code}</code></pre>`;
		}
	);

	// 模式4：<p> 内连续多个 <span> 用 <br> 分隔（微信无 <pre> 时使用的降级渲染）
	html = html.replace(
		/<p[^>]*>((?:\s*<span[^>]*>.*?<\/span>\s*<br\s*\/?>\s*){2,}\s*<span[^>]*>.*?<\/span>\s*)<\/p>/gi,
		(_, content) => {
			const code = content
				.replace(/<br\s*\/?>/gi, '\n')
				.replace(/<span[^>]*>/gi, '')
				.replace(/<\/span>/gi, '');
			return `<pre><code>${decodeHtmlEntities(code).trim()}</code></pre>`;
		}
	);

	return html;
}

/**
 * 使用 linkedom 清理微信文章 HTML 中的噪音内容
 * 在 AI 转换前执行，从 DOM 层面精确删除噪音元素
 */
export function cleanArticleHtml(html: string): string {
	const { document } = parseHTML(html);

	if (!isWechatArticle(document)) {
		console.log('[cleaner] 非微信文章，跳过微信专用清理');
		// 仍然做代码块标准化
		const result = document.toString();
		return normalizeCodeBlocks(result);
	}

	console.log('[cleaner] 检测到微信文章，开始 DOM 级清理');

	// ① 移除标题元素（避免在 Markdown 中重复）
	const titleSelectors = [
		'#activity-name',
		'h1.rich_media_title',
		'.rich_media_title',
	];
	titleSelectors.forEach((sel) => {
		document.querySelectorAll(sel).forEach((el) => el.remove());
	});

	// ② 移除作者信息区
	const authorSelectors = [
		'#js_name',
		'#js_author_area',
		'.rich_media_meta_list',
		'.profile_container',
		'.reward_area',
		'.rich_media_meta_text',
	];
	authorSelectors.forEach((sel) => {
		document.querySelectorAll(sel).forEach((el) => el.remove());
	});

	// ③ 移除关注引导区
	const followSelectors = [
		'.follow_guide',
		'[data-type="follow"]',
	];
	followSelectors.forEach((sel) => {
		document.querySelectorAll(sel).forEach((el) => el.remove());
	});

	// 文本匹配的噪音模式
	const strongNoisePatterns: RegExp[] = [
		/^点击上方蓝字关注/,
		/^关注.*公众号/,
		/^关注我们/,
		/^设为星标/,
		/^星标.*关注/,
		/^点击.*关注/,
		/^戳蓝字关注/,
	];

	// ④ 移除底部分享/划线/推荐阅读区
	const bottomSelectors = [
		'#js_share_area',
		'.like_comment_wrp',
		'.original_area_primary',
		'.article-tag__list',
		'.rich_media_area_extra',
		'.reward_area',
	];
	bottomSelectors.forEach((sel) => {
		document.querySelectorAll(sel).forEach((el) => el.remove());
	});

	const bottomNoisePatterns: RegExp[] = [
		/^分享收藏/,
		/^人划线$/,
		/^推荐阅读/,
		/^往期精选/,
		/^更多精彩/,
		/^点赞.*在看/,
		/^转发.*点赞/,
		/^好看.*转发/,
		/^继续阅读/,
		/^阅读原文/,
		/^原文链接/,
	];

	// 在正文容器外部查找噪音元素
	const jsContent = document.querySelector('#js_content');
	const body = document.body || document.documentElement;

	function removeNoiseOutsideContent(selectors: string[], patterns: RegExp[]): void {
		selectors.forEach((sel) => {
			document.querySelectorAll(sel).forEach((el) => {
				if (jsContent && jsContent.contains(el)) return;
				if (matchesNoiseText(el, patterns)) {
					el.remove();
				}
			});
		});
	}

	// 处理关注引导区（body 级别）
	removeNoiseOutsideContent(['p', 'div', 'section', 'span', 'a'], strongNoisePatterns);

	// 处理底部噪音区（body 级别）
	const allElements = body.querySelectorAll('*');
	allElements.forEach((el) => {
		if (jsContent && jsContent.contains(el)) return;
		if (matchesNoiseText(el, bottomNoisePatterns)) {
			el.remove();
		}
	});

	// ⑤ 移除广告和推广区
	const adSelectors = [
		'.banner_ad',
		'[class*="-ad-"]',
		'[class*="ad_"]',
		'[class*="course"]',
		'[class*="promotion"]',
		'mp-common-profile',
		'.qr_code',
		'[class*="qrcode"]',
		'[id*="qrcode"]',
		'[id*="qr_code"]',
	];
	adSelectors.forEach((sel) => {
		document.querySelectorAll(sel).forEach((el) => el.remove());
	});

	// 移除含"广告"文本的元素
	removeNoiseOutsideContent(['p', 'div', 'section', 'span'], [/广告/]);

	// ⑥ 移除封面图区域
	const coverSelectors = [
		'#js_cover_area',
		'[id*="js_cover"]',
	];
	coverSelectors.forEach((sel) => {
		document.querySelectorAll(sel).forEach((el) => el.remove());
	});

	// ⑦ 移除装饰性元素
	const decorativeSelectors = [
		'img[src*="footer"]',
		'img[src*="endline"]',
		'img[class*="footer"]',
		'img[class*="end"]',
		'hr',
	];
	decorativeSelectors.forEach((sel) => {
		// 仅在正文外部删除 hr
		document.querySelectorAll(sel).forEach((el) => {
			if (sel === 'hr' && jsContent && jsContent.contains(el)) return;
			el.remove();
		});
	});

	// ⑧ 移除空的段落/div（清理后可能产生的空白元素）
	document.querySelectorAll('p, div, section, span').forEach((el) => {
		const text = (el.textContent || '').trim();
		if (!text && el.children.length === 0 && !el.querySelector('img, video, iframe')) {
			el.remove();
		}
	});

	console.log('[cleaner] DOM 级清理完成');

	// 获取清理后的 HTML 字符串
	const cleanedHtml = document.toString();

	// ⑨ 标准化代码块（正则层面，在序列化后的 HTML 上操作）
	return normalizeCodeBlocks(cleanedHtml);
}
