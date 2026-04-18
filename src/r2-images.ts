/**
 * 图片代理模块
 * 使用 wsrv.nl 公共服务代理微信图片，解决防盗链问题
 * 无需 R2 存储，零成本方案
 */

/**
 * 检查是否为微信 qpic.cn 或 qlogo.cn 域名
 */
export function isWechatImageDomain(url: string): boolean {
return url.includes('qpic.cn') || url.includes('qlogo.cn');
}

/**
 * 将微信图片 URL 转换为 wsrv.nl 代理 URL
 * 示例：
 * 输入：https://mmbiz.qpic.cn/sz_mmbiz_png/xxx/640?wx_fmt=png&from=appmsg
 * 输出：https://wsrv.nl/?output=webp&url=https%3A%2F%2Fmmbiz.qpic.cn%2Fsz_mmbiz_png%2Fxxx%2F640%3Fwx_fmt%3Dpng%26from%3Dappmsg
 */
export function processImageUrl(originalUrl: string): string {
if (isWechatImageDomain(originalUrl)) {
return `https://wsrv.nl/?output=webp&url=${encodeURIComponent(originalUrl)}`;
}
return originalUrl;
}

/**
 * 从 HTML 和 Markdown 中提取所有微信图片 URL
 * 返回去重后的 URL 列表
 */
export function extractWechatImageUrls(html: string, markdown: string): string[] {
// 匹配微信图片域名的 URL（改进的正则，在遇到&时停止，避免匹配 HTML 实体）
const regex = /https?:\/\/mmbiz\.q(?:pic|logo)\.cn\/[^?\s"'<>)\]]+(?:\?[^&\s"'<>)\]]+)?/gi;

const htmlMatches = html.match(regex) || [];
const mdMatches = markdown.match(regex) || [];

// 合并并去重
const allUrls = [...new Set([...htmlMatches, ...mdMatches])];

// 清理 URL（移除尾部的标点符号）
return allUrls.map((url) => url.replace(/[,.)\]]+$/, ''));
}

/**
 * 同步替换图片链接为 wsrv.nl 代理链接
 */
export function replaceImageUrlsSync(html: string, markdown: string, _env: Env): string {
const imageUrls = extractWechatImageUrls(html, markdown);
if (imageUrls.length === 0) {
return markdown;
}

console.log(`发现 ${imageUrls.length} 张图片，开始替换为 wsrv.nl 代理链接`);
let result = markdown;

for (const originalUrl of imageUrls) {
const newUrl = processImageUrl(originalUrl);
if (newUrl === originalUrl) {
continue; // 非微信图片，跳过
}

const escapedUrl = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 匹配 URL 及其后续 HTML 实体查询参数（&amp;from=appmsg 等）
const htmlEscapedUrl = escapedUrl.replace(/&/g, '&amp;');
const htmlRegexWithParams = new RegExp(htmlEscapedUrl + '(?:&amp;[^)\\s"\'<>\\]]+)*', 'g');
result = result.replace(htmlRegexWithParams, newUrl);

// 同样处理普通的&参数
const regexWithParams = new RegExp(escapedUrl + '(?:&[^)\\s"\'<>\\]]+)*', 'g');
result = result.replace(regexWithParams, newUrl);
}

console.log('图片链接替换完成');
return result;
}

/**
 * 异步上传图片（使用 wsrv.nl 无需上传，此函数为空操作）
 */
export async function uploadImagesToR2Async(_html: string, _markdown: string, _env: Env): Promise<void> {
// 使用 wsrv.nl 代理，无需上传到 R2
return Promise.resolve();
}
