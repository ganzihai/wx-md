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
 * - POST /push/hugo      将任务入队，立即返回 202
 * - POST /push/memos     将任务入队，立即返回 202
 */

import INDEX_HTML from '../index.html';
import { convertWebpageToMarkdown, handleGenericWebpage, convertToMarkdownContent } from './converter';
import { postToHugo, postToMemos } from './publisher';
import { convertYoutubeToMarkdown } from './youtube';

const WECHAT_URL_PREFIX = 'https://mp.weixin.qq.com/';

export interface PushMessage {
	url: string;
	target: 'hugo' | 'memos';
}

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

async function fallbackToMemos(sourceUrl: string, reason: string, env: Env): Promise<void> {
	try {
		const content = `⚠️ 自动处理失败，请手动处理：\n\n${sourceUrl}\n\n>失败原因: ${reason}`;
		await postToMemos(content, env);
		console.log(`[fallback] 居底链接已存入 Memos: ${sourceUrl}`);
	} catch (e) {
		console.error('[fallback] 居底存入 Memos 也失败:', e);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			const url = new URL(request.url);
			const path = url.pathname;
			console.log(`处理请求路径: ${path}`);

			if (path === '/health' || path === '/healthz') {
				return new Response(JSON.stringify({ status: 'ok', version: '3.0.0', timestamp: new Date().toISOString() }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			if (path === '/' || path === '') {
				return new Response(INDEX_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
			}

			// 推送路由：将任务入队，立即返回
			if (path === '/push/hugo' || path === '/push/memos') {
				const target = path === '/push/hugo' ? 'hugo' : 'memos';
				const sourceUrl = await resolveUrl(request, url);

				if (!sourceUrl) {
					return new Response(JSON.stringify({ success: false, error: '缺少 URL，请通过 ?url= 参数或 POST body 提供' }), {
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					});
				}

				const message: PushMessage = { url: sourceUrl, target };
				await env.PUSH_QUEUE.send(message);

				console.log(`[push/${target}] 入队成功: ${sourceUrl}`);
				return new Response(
					JSON.stringify({ success: true, queued: true, target, url: sourceUrl }),
					{ status: 202, headers: { 'Content-Type': 'application/json' } }
				);
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

	async queue(batch: MessageBatch<PushMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
		for (const message of batch.messages) {
			const { url: sourceUrl, target } = message.body;
			try {
				let title: string;
				let markdown: string;

				if (isYoutubeUrl(sourceUrl)) {
					console.log(`[queue/${target}] YouTube 流程: ${sourceUrl}`);
					({ title, markdown } = await convertYoutubeToMarkdown(sourceUrl, env));
				} else {
					console.log(`[queue/${target}] 微信流程: ${sourceUrl}`);
					const match = sourceUrl.match(/\/s\/([A-Za-z0-9_-]+)/);
					const fallbackId = match ? match[1] : new URL(sourceUrl).hostname;
					({ title, markdown } = await convertToMarkdownContent(sourceUrl, env, ctx, fallbackId));
				}

				if (target === 'hugo') {
					const result = await postToHugo(title, markdown, env);
					console.log(`[queue/hugo] 推送成功: ${result.path}`);
				} else {
					const result = await postToMemos(markdown, env);
					console.log(`[queue/memos] 推送成功, id: ${result.id}`);
				}
				message.ack();
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error);
				console.error(`[queue/${target}] 处理失败，居底存入 Memos:`, error);
				if (env.MEMOS_API_URL && env.MEMOS_API_KEY) {
					await fallbackToMemos(sourceUrl, errMsg, env);
				}
				message.ack(); // 避免无限重试
			}
		}
	},
} satisfies ExportedHandler<Env>;
