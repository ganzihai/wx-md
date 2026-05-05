/**
 * Queue Consumer 模块
 * 异步处理推送任务，不受请求超时限制
 */

import { convertToMarkdownContent } from './converter';
import { postToHugo, postToMemos } from './publisher';
import { convertYoutubeToMarkdown } from './youtube';

export interface PushMessage {
	url: string;
	target: 'hugo' | 'memos';
}

function isYoutubeUrl(url: string): boolean {
	return url.includes('youtube.com') || url.includes('youtu.be');
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

async function processMessage(msg: PushMessage, env: Env, ctx: ExecutionContext): Promise<void> {
	const { url: sourceUrl, target } = msg;

	try {
		let title: string;
		let markdown: string;

		if (isYoutubeUrl(sourceUrl)) {
			console.log(`[consumer/${target}] YouTube 流程: ${sourceUrl}`);
			({ title, markdown } = await convertYoutubeToMarkdown(sourceUrl, env));
		} else {
			console.log(`[consumer/${target}] 微信流程: ${sourceUrl}`);
			const match = sourceUrl.match(/\/s\/([A-Za-z0-9_-]+)/);
			const fallbackId = match ? match[1] : new URL(sourceUrl).hostname;
			({ title, markdown } = await convertToMarkdownContent(sourceUrl, env, ctx, fallbackId));
		}

		if (target === 'hugo') {
			const result = await postToHugo(title, markdown, env);
			console.log(`[consumer/hugo] 推送成功: ${result.path}`);
		} else {
			const result = await postToMemos(markdown, env);
			console.log(`[consumer/memos] 推送成功, id: ${result.id}`);
		}
	} catch (error) {
		const msg2 = error instanceof Error ? error.message : String(error);
		console.error(`[consumer/${target}] 处理失败，居底存入 Memos:`, error);
		if (env.MEMOS_API_URL && env.MEMOS_API_KEY) {
			await fallbackToMemos(sourceUrl, msg2, env);
		}
	}
}

export default {
	async queue(batch: MessageBatch<PushMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
		for (const message of batch.messages) {
			await processMessage(message.body, env, ctx);
			message.ack();
		}
	},
} satisfies ExportedHandler<Env>;
