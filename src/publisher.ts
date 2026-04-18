/**
 * 推送模块
 * 将转换后的 Markdown 内容推送到 WordPress 或 Memos
 */

import { marked } from 'marked';

/**
 * 推送内容到 WordPress
 * WordPress REST API content 字段需要 HTML，将 Markdown 先转换再推送
 */
export async function postToWordPress(
	title: string,
	markdownContent: string,
	env: Env
): Promise<{ id: number; link: string }> {
	if (!env.WP_URL || !env.WP_USER || !env.WP_PASS) {
		throw new Error('WordPress 配置不完整，请检查 WP_URL、WP_USER、WP_PASS');
	}

	// 将 Markdown 转换为 HTML
	const htmlContent = await marked(markdownContent);

	const endpoint = `${env.WP_URL}/wp-json/wp/v2/posts`;
	const auth = btoa(`${env.WP_USER}:${env.WP_PASS}`);
	const categories = env.WP_CATEGORIES
		? env.WP_CATEGORIES.split(',').map((c: string) => parseInt(c.trim())).filter((n: number) => !isNaN(n))
		: [];

	console.log(`推送到 WordPress: ${endpoint}`);

	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'Authorization': `Basic ${auth}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			title,
			content: htmlContent,
			status: 'publish',
			...(categories.length > 0 ? { categories } : {}),
		}),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`WordPress 发布失败 (${response.status}): ${err.slice(0, 300)}`);
	}

	const result = await response.json() as { id: number; link: string };
	console.log(`WordPress 发布成功，ID: ${result.id}，链接: ${result.link}`);
	return result;
}

/**
 * 推送 Markdown 内容到 Memos（原生支持 Markdown，无需转换）
 */
export async function postToMemos(
	markdownContent: string,
	env: Env
): Promise<{ id: number }> {
	if (!env.MEMOS_API_URL || !env.MEMOS_API_KEY) {
		throw new Error('Memos 配置不完整，请检查 MEMOS_API_URL、MEMOS_API_KEY');
	}

	const endpoint = `${env.MEMOS_API_URL}/api/memos`;

	console.log(`推送到 Memos: ${endpoint}`);

	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${env.MEMOS_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			content: markdownContent,
			is_public: 0,
			tags: ['n8n', '自动推送'],
		}),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`Memos 发布失败 (${response.status}): ${err.slice(0, 300)}`);
	}

	const result = await response.json() as { id: number };
	console.log(`Memos 发布成功，ID: ${result.id}`);
	return result;
}
