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
 * - POST /push/hugo      微信文章转换后推送到 Hugo
 * - POST /push/memos     微信文章转换后推送到 Memos
 * - POST /push/hugo/youtube   YouTube 视频总结推送到 Hugo
 * - POST /push/memos/youtube  YouTube 视频总结推送到 Memos
 */

import INDEX_HTML from '../index.html';
import { convertWebpageToMarkdown, convertToMarkdownContent, handleGenericWebpage } from './converter';
import { postToHugo, postToMemos } from './publisher';
import { convertYoutubeToMarkdown } from './youtube';

const WECHAT_URL_PREFIX = 'https://mp.weixin.qq.com/';

async function resolveWechatUrl(request: Request, url: URL): Promise<string> {
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

async function handlePush(
	request: Request,
	url: URL,
	env: Env,
	ctx: ExecutionContext,
	target: 'hugo' | 'memos'
): Promise<Response> {
	const wechatUrl = await resolveWechatUrl(request, url);
	if (!wechatUrl) {
		return new Response(JSON.stringify({ success: false, error: '缺少微信文章 URL，请通过 ?url= 参数或 POST body 提供' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	try {
		const match = wechatUrl.match(/\/s\/([A-Za-z0-9_-]+)/);
		const fallbackId = match ? match[1] : new URL(wechatUrl).hostname;
		console.log(`[push/${target}] 开始转换: ${wechatUrl}`);

		const { title, markdown } = await convertToMarkdownContent(wechatUrl, env, ctx, fallbackId);

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
		console.error(`[push/${target}] 处理失败:`, error);
		return new Response(
			JSON.stringify({ success: false, error: msg }),
			{ status: 500, headers: { 'Content-Type': 'application/json' } }
		);
	}
}

async function handleYoutubePush(
	request: Request,
	target: 'hugo' | 'memos',
	env: Env
): Promise<Response> {
	try {
		const contentType = request.headers.get('Content-Type') || '';
		let youtubeUrl = '';

		if (contentType.includes('application/json')) {
			try {
				const body = await request.json() as Record<string, string>;
				youtubeUrl = body.url || body.content || body.text || body.link || '';
			} catch { /* 忽略 */ }
		} else {
			youtubeUrl = (await request.text()).trim();
		}

		youtubeUrl = youtubeUrl.trim().replace(/^"|"$/g, '');

		if (!youtubeUrl) {
			return new Response(JSON.stringify({ success: false, error: '缺少 YouTube 链接' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const isYoutube = youtubeUrl.includes('youtube.com') || youtubeUrl.includes('youtu.be');
		if (!isYoutube) {
			return new Response(JSON.stringify({ success: false, error: '请提供有效的 YouTube 链接' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		console.log(`[push/${target}/youtube] 开始处理: ${youtubeUrl}`);
		const { title, markdown } = await convertYoutubeToMarkdown(youtubeUrl, env);

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
		console.error(`[push/${target}/youtube] 处理失败:`, error);
		return new Response(
			JSON.stringify({ success: false, error: msg }),
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
				return new Response(JSON.stringify({ status: 'ok', version: '2.1.0', timestamp: new Date().toISOString() }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			if (path === '/' || path === '') {
				return new Response(INDEX_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
			}

			// YouTube 推送路由（顺序要在微信推送路由前判断）
			if (path === '/push/hugo/youtube') {
				return await handleYoutubePush(request, 'hugo', env);
			}
			if (path === '/push/memos/youtube') {
				return await handleYoutubePush(request, 'memos', env);
			}

			// 微信推送路由
			if (path === '/push/hugo') {
				return await handlePush(request, url, env, ctx, 'hugo');
			}
			if (path === '/push/memos') {
				return await handlePush(request, url, env, ctx, 'memos');
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
