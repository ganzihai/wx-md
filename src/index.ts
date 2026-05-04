/**
 * 微信公众号文章转 Markdown 工具 - Worker 入口
 *
 * 路由说明:
 * - /                    首页
 * - /health, /healthz    健康检查
 * - /s/{article_id}      微信文章转 Markdown
 * - /html/s/{article_id} 微信文章 HTML 预览
 * - /md?url=...          通用网页转 Markdown
 * - /html/md?url=...     通用网页 HTML 预览
 * - POST /push/hugo      自动识别 URL 类型推送到 Hugo
 * - POST /push/memos     自动识别 URL 类型推送到 Memos
 *   YouTube 地址 → Jina + Gemini
 *   其他地址 → 微信 AI 流程
 *   任何流程失败 → 居底把原始链接存入 Memos
 */

import INDEX_HTML from '../index.html';
import { convertWebpageToMarkdown, convertToMarkdownContent, handleGenericWebpage } from './converter';
import { postToHugo, postToMemos } from './publisher';
import { convertYoutubeToMarkdown } from './youtube';

const WECHAT_URL_PREFIX = 'https://mp.weixin.qq.com/';

function isYoutubeUrl(url: string): boolean {
	return url.includes('youtube.com') || url.includes('youtu.be');
}

async function resolveUrl(request: Request, url: URL): Promise<string> {
	const queryUrl = url.searchParams.get('url');
	if (queryUrl) return decodeURIComponent(queryUrl);

	if (request.method === 'POST') {
		const contentType = request.headers.get('Content-Type') || '';
		if (contentType.includes('application/json')) {
			try {
				const body = await request.json() as Record<string, string>;
				const val = body.url || body.text || body.content || body.link || '';
				if (val) return val.trim().replace(/^"|"$/g, '');
			} catch { /* 忽略解析错误 */ }
		} else {
			const text = await request.text();
			const trimmed = text.trim().replace(/^"|"$/g, '');
			if (trimmed) return trimmed;
		}
	}
	return '';
}

/**
 * 居底方案：把原始链接存入 Memos
 */
async function fallbackToMemos(sourceUrl: string, reason: string, env: Env): Promise<void> {
	try {
		const content = `⚠️ 自动处理失败，请手动处理：\n\n${sourceUrl}\n\n>失败原因: ${reason}`;
		await postToMemos(content, env);
		console.log(`[fallback] 居底链接已存入 Memos: ${sourceUrl}`);
	} catch (e) {
		console.error('[fallback] 居底存入 Memos 也失败:', e);
	}
}

async function handlePush(
	request: Request,
	urlObj: URL,
	target: 'hugo' | 'memos',
	env: Env,
	ctx: ExecutionContext
): Promise<Response> {
	const sourceUrl = await resolveUrl(request, urlObj);

	if (!sourceUrl) {
		return new Response(JSON.stringify({ success: false, error: '缺少 URL，请通过 ?url= 参数或 POST body 提供' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	try {
		let title: string;
		let markdown: string;

		if (isYoutubeUrl(sourceUrl)) {
			console.log(`[push/${target}] YouTube 流程: ${sourceUrl}`);
			({ title, markdown } = await convertYoutubeToMarkdown(sourceUrl, env));
		} else {
			console.log(`[push/${target}] 微信流程: ${sourceUrl}`);
			const match = sourceUrl.match(/\/s\/([A-Za-z0-9_-]+)/);
			const fallbackId = match ? match[1] : new URL(sourceUrl).hostname;
			({ title, markdown } = await convertToMarkdownContent(sourceUrl, env, ctx, fallbackId));
		}

		if (target === 'hugo') {
			const result = await postToHugo(title, markdown, env);
			return new Response(
				JSON.stringify({ success: true, target: 'hugo', title, path: result.path, url: result.url }),
				{ headers: { 'Content-Type': 'application/json' } }
			);
		} else {
			const result = await postToMemos(markdown, env);
			return new Response(
				JSON.stringify({ success: true, target: 'memos', title, id: result.id }),
				{ headers: { 'Content-Type': 'application/json' } }
			);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`[push/${target}] 处理失败，居底存入 Memos:`, error);

		// 居底：将原始链接存入 Memos
		if (env.MEMOS_API_URL && env.MEMOS_API_KEY) {
			ctx.waitUntil(fallbackToMemos(sourceUrl, msg, env));
		}

		return new Response(
			JSON.stringify({
				success: false,
				fallback: true,
				message: '处理失败，原始链接已存入 Memos',
				error: msg,
			}),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			const url = new URL(request.url);
			const path = url.pathname;
			console.log(`处理请求路径: ${path}`);

			if (path === '/health' || path === '/healthz') {
				return new Response(JSON.stringify({ status: 'ok', version: '2.2.0', timestamp: new Date().toISOString() }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			if (path === '/' || path === '') {
				return new Response(INDEX_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
			}

			if (path === '/push/hugo') {
				return handlePush(request, url, 'hugo', env, ctx);
			}
			if (path === '/push/memos') {
				return handlePush(request, url, 'memos', env, ctx);
			}

			if (path === '/html/md') {
				return await handleGenericWebpage(url, env, ctx, true);
			}
			if (path === '/md') {
				const isHtmlMode = url.searchParams.get('format') === 'html';
				return await handleGenericWebpage(url, env, ctx, isHtmlMode);
			}

			let isHtmlMode = false;
			let articleId = '';

			if (path.startsWith('/html/s/')) {
				isHtmlMode = true;
				articleId = path.substring(8);
			} else if (path.startsWith('/s/')) {
				articleId = path.substring(3);
				if (articleId.endsWith('.html')) {
					isHtmlMode = true;
					articleId = articleId.slice(0, -5);
				}
			} else {
				return new Response(
					'请提供正确的微信公众号文章路径，格式: /s/{article_id} 或 /html/s/{article_id}，或使用 /md?url=网址 转换其他网页',
					{ status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
				);
			}

			if (!articleId) {
				return new Response('请提供微信公众号文章 ID', {
					status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
				});
			}

			const wxArticleUrl = `${WECHAT_URL_PREFIX}s/${articleId}`;
			const download = url.searchParams.get('download') === 'true';
			return await convertWebpageToMarkdown(wxArticleUrl, env, ctx, articleId, isHtmlMode, download);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('处理请求时发生错误:', error);
			return new Response(`处理请求时发生错误: ${errorMessage}`, {
				status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
			});
		}
	},
} satisfies ExportedHandler<Env>;
