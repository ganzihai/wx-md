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
 * 获取北京时间各字段
 * 北京时间 = UTC+8
 */
function getBeijingTimeParts(now: Date): {
	dateStr: string;       // 2026-04-21
	timeStr: string;       // 1338
	dateTimeISO: string;   // 2026-04-21T13:38:00+08:00
} {
	// UTC 毫秒 + 8小时偏移
	const bjOffset = 8 * 60 * 60 * 1000;
	const bjTime = new Date(now.getTime() + bjOffset);

	const Y = bjTime.getUTCFullYear();
	const M = String(bjTime.getUTCMonth() + 1).padStart(2, '0');
	const D = String(bjTime.getUTCDate()).padStart(2, '0');
	const H = String(bjTime.getUTCHours()).padStart(2, '0');
	const m = String(bjTime.getUTCMinutes()).padStart(2, '0');
	const S = String(bjTime.getUTCSeconds()).padStart(2, '0');

	return {
		dateStr: `${Y}-${M}-${D}`,
		timeStr: `${H}${m}`,
		dateTimeISO: `${Y}-${M}-${D}T${H}:${m}:${S}+08:00`,
	};
}

/**
 * 推送内容到 Hugo（通过 GitHub API 提交 .md 文件到 blog 仓库）
 * 文件命名规则：YYYY-MM-DD-HHmm.md（北京时间，精确到分钟）
 * 例如：2026-04-21-1338.md
 */
export async function postToHugo(
	title: string,
	markdownContent: string,
	env: Env
): Promise<{ path: string; url: string }> {
	if (!env.GITHUB_TOKEN || !env.HUGO_REPO) {
		throw new Error('Hugo 配置不完整，请检查 GITHUB_TOKEN、HUGO_REPO');
	}

	const { dateStr, timeStr, dateTimeISO } = getBeijingTimeParts(new Date());

	const filename = `${dateStr}-${timeStr}.md`;
	const filepath = `content/post/${filename}`;
	const urlSlug = `/${dateStr}-${timeStr}.html`;

	const [owner, repo] = env.HUGO_REPO.split('/');
	const apiBase = `https://api.github.com/repos/${owner}/${repo}`;
	const githubHeaders = {
		Authorization: `token ${env.GITHUB_TOKEN}`,
		'User-Agent': 'wx-md-worker',
		Accept: 'application/vnd.github.v3+json',
		'Content-Type': 'application/json',
	};

	// 拼接 Hugo frontmatter
	const safeTitle = title.replace(/"/g, '\\"');
	const frontmatter = [
		'---',
		`title: ${safeTitle}`,
		'author: 杆子',
		'type: post',
		`date: ${dateTimeISO}`,
		`url: ${urlSlug}`,
		'views:',
		'  - 1',
		'categories:',
		'  - 网络',
		'---',
		'',
		'',
	].join('\n');

	const fileContent = frontmatter + markdownContent;

	// 提交文件到 GitHub
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
