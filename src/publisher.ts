/**
 * 推送模块
 * 将转换后的 Markdown 内容推送到 Hugo 或 Memos
 */

/**
 * 将字符串编码为 base64（支持中文/UTF-8）
 */
function toBase64(str: string): string {
	const bytes = new TextEncoder().encode(str);
	let binary = '';
	for (const b of bytes) {
		binary += String.fromCharCode(b);
	}
	return btoa(binary);
}

/**
 * 推送内容到 Hugo（通过 GitHub API 提交 .md 文件到 blog 仓库）
 * 文件命名规则：YYYY-MM-DD-序号.md，与现有文章一致
 */
export async function postToHugo(
	title: string,
	markdownContent: string,
	env: Env
): Promise<{ path: string; url: string }> {
	if (!env.GITHUB_TOKEN || !env.HUGO_REPO) {
		throw new Error('Hugo 配置不完整，请检查 GITHUB_TOKEN、HUGO_REPO');
	}

	const now = new Date();
	const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
	const dateTimeStr = now.toISOString().replace('Z', '+00:00');

	const [owner, repo] = env.HUGO_REPO.split('/');
	const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
	const githubHeaders = {
		Authorization: `token ${env.GITHUB_TOKEN}`,
		'User-Agent': 'wx-md-worker',
		Accept: 'application/vnd.github.v3+json',
		'Content-Type': 'application/json',
	};

	// 查询当天已有几篇文章，序号+1
	const listResp = await fetch(`${apiBase}/contents/content/post`, { headers: githubHeaders });
	if (!listResp.ok) {
		const err = await listResp.text();
		throw new Error(`获取文章列表失败 (${listResp.status}): ${err.slice(0, 300)}`);
	}
	const files = await listResp.json() as { name: string }[];
	const todayCount = Array.isArray(files) ? files.filter((f) => f.name.startsWith(dateStr)).length : 0;
	const seq = String(todayCount + 1).padStart(2, '0');
	const filename = `${dateStr}-${seq}.md`;
	const filepath = `content/post/${filename}`;

	// 拼接 Hugo frontmatter（与现有文章格式一致）
	const safeTitle = title.replace(/"/g, '\\"');
	const frontmatter = [
		'---',
		`title: ${safeTitle}`,
		'author: 杆子',
		'type: post',
		`date: ${dateTimeStr}`,
		`url: /${filename.replace('.md', '.html')}`,
		'categories:',
		'  - 转载',
		'---',
		'',
		'',
	].join('\n');

	const fileContent = frontmatter + markdownContent;

	// 提交文件到 GitHub（使用 TextEncoder 保证 UTF-8 正确编码）
	const uploadResp = await fetch(`${apiBase}/contents/${filepath}`, {
		method: 'PUT',
		headers: githubHeaders,
		body: JSON.stringify({
			message: `feat: 新增文章 ${filename}`,
			content: toBase64(fileContent),
		}),
	});

	if (!uploadResp.ok) {
		const err = await uploadResp.text();
		throw new Error(`Hugo 发布失败 (${uploadResp.status}): ${err.slice(0, 300)}`);
	}

	console.log(`Hugo 发布成功：${filepath}`);
	return {
		path: filepath,
		url: `https://github.com/${owner}/${repo}/blob/main/${filepath}`,
	};
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
