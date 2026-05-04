/**
 * YouTube 视频处理模块
 * 使用 Jina Reader 抓取字幕/描述，再由 Gemini 总结为结构化 Markdown 笔记
 */

/**
 * 通过 Jina Reader 抓取 YouTube 页面内容
 */
async function fetchWithJina(url: string, jinaApiKey?: string): Promise<string> {
	const jinaUrl = `https://r.jina.ai/${url}`;
	const headers: Record<string, string> = { 'Accept': 'text/markdown' };
	if (jinaApiKey) {
		headers['Authorization'] = `Bearer ${jinaApiKey}`;
	}

	for (let i = 0; i < 3; i++) {
		const response = await fetch(jinaUrl, { headers });
		if (response.ok) return await response.text();
		if (response.status === 429 && i < 2) {
			await new Promise(r => setTimeout(r, 2000 * (i + 1)));
			continue;
		}
		throw new Error(`Jina Reader 抓取失败: ${response.statusText}`);
	}
	throw new Error('Jina Reader 重试 3 次后仍失败');
}

/**
 * 调用 Gemini 对 YouTube 内容进行知识萃取
 */
async function summarizeWithGemini(
	rawContent: string,
	geminiApiKey: string
): Promise<{ title: string; content: string }> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${geminiApiKey}`;

	const promptText = `你是一个知识萃取专家。以下是一段 YouTube 视频的字幕或网页抓取文本：

${rawContent}

请总结为结构化的 Markdown 笔记，包含：
1. 视频核心主题一句话摘要
2. 分点详细内容总结
3. 如有代码/技术要点请保留
正文中不要包含标题行。
请严格以 JSON 格式输出：{"title": "视频核心标题", "content": "总结的 Markdown 内容"}`;

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
			return JSON.parse(data.candidates[0].content.parts[0].text) as { title: string; content: string };
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
 * 处理 YouTube 链接的完整流程：Jina 抓取 → Gemini 总结
 * 返回 { title, markdown }
 */
export async function convertYoutubeToMarkdown(
	youtubeUrl: string,
	env: Env
): Promise<{ title: string; markdown: string }> {
	if (!env.GEMINI_API_KEY) {
		throw new Error('处理 YouTube 需要配置 GEMINI_API_KEY');
	}

	console.log(`[youtube] 开始抓取: ${youtubeUrl}`);
	const rawContent = await fetchWithJina(youtubeUrl, env.JINA_API_KEY);

	console.log(`[youtube] 开始 Gemini 总结`);
	const result = await summarizeWithGemini(rawContent, env.GEMINI_API_KEY);

	return {
		title: result.title,
		markdown: result.content,
	};
}
