# 微信公众号文章处理优化方案

## 一、问题诊断

通过分析你项目的完整代码（[index.ts](file:///f:/ganzi/wx-md/src/index.ts)、[converter.ts](file:///f:/ganzi/wx-md/src/converter.ts)、[utils.ts](file:///f:/ganzi/wx-md/src/utils.ts)、[publisher.ts](file:///f:/ganzi/wx-md/src/publisher.ts)、[r2-images.ts](file:///f:/ganzi/wx-md/src/r2-images.ts)），你的处理流程是：

```
抓取 HTML → 简单 HTML 预处理 → AI 转 Markdown → 正则清理 Markdown
```

**核心问题：你把清理工作放在了最后一步（Markdown 正则层面），而应该在 HTML 层面就做深度清理。**

原因很简单：在 HTML 层面，你可以通过 DOM 结构、CSS 类名、标签语义来精确定位噪音元素；而在 Markdown 层面，你只能用正则去匹配已经丢失了结构信息的纯文本，这天然就不稳定。

***

### 问题 1：标题在正文中重复出现

**当前做法** ([converter.ts:L31-L41](file:///f:/ganzi/wx-md/src/converter.ts#L31-L41))：

```typescript
// 步骤5：删除正文开头的 Markdown 标题行
content = content.replace(/^(\s*\n)*\s*#{1,6}\s+.+\n+/, '');

// 步骤6：精确匹配预期标题
const titleRegex = new RegExp(`^\\s*#{1,6}\\s*${escapedTitle}\\s*(\\n|$)`, 'm');
content = content.replace(titleRegex, '');
```

**缺陷分析：**

* 步骤5 的正则 `(\s*\n)*` 会贪婪吃掉所有前导空行和第一个标题行，但如果 Windows 换行是 `\r\n`，可能漏匹配

* 步骤6 做精确匹配，但 AI 转换后的标题可能带有 emoji、多余空格、换行方式不同，导致正则不命中

* 只匹配了 Markdown 标题格式（`# 标题`），如果标题以普通文本形式出现在正文开头，不会被删除

* Hugo front matter 里已经写了 `title:`，正文又出现标题，阅读体验很差

**根本原因：是你让 AI 把全文（含标题元素）一起转成了 Markdown，然后再试图用正则删掉 Markdown 里的标题。**

***

### 问题 2：文章开头和结尾的多余内容

**当前做法** ([converter.ts:L18-L43](file:///f:/ganzi/wx-md/src/converter.ts#L18-L43))：

```typescript
// 删除开头的 YAML front matter
// 删除"原创 作者名..."行
// 删除"在小说阅读器读本章..."行
// 从"预览时标签不可点"开始删除到末尾
```

**缺陷分析：**

* 全是硬编码的正则模式，微信文章格式一变就失效

* 只覆盖了极少数噪音模式，微信文章实际有大量未处理的噪音：

  * 开头：`"点击上方蓝字关注我们"`、`"关注公众号"`、作者信息区、广告横幅

  * 结尾：`"分享收藏划线"`、`"人划线"`（划线阅读标记）、`"阅读原文"`、`"推荐阅读"`、`"往期精选"`、`"点赞/在看/转发"`引导语

  * 各种分割线和装饰性内容

* 在 Markdown 层面用正则去匹配这些，非常脆弱

**根本原因：这些噪音在 HTML 中有清晰的 DOM 结构（特定 class、id、data 属性），但在 Markdown 中变成了无结构的文本，正则很难精确区分「正文内容」和「噪音文本」。**

***

### 问题 3：单行代码和多行代码的处理

**当前做法** ([utils.ts:L132-L176](file:///f:/ganzi/wx-md/src/utils.ts#L132-L176))：

```typescript
// 模式1：<section data-lang="..."> 微信专用代码块
// 模式2：<pre> 裸标签 / <pre class="...">
// 模式3：<code> 内含 <br> 换行的多行代码
// 模式4：不含换行的单行 <code> 保持不变
```

**缺陷分析：**

1. **模式3 可能误伤行内代码**：正则 `<code([^>]*)>([\s\S]*?<br[\s\S]*?)<\/code>` 只要 `<code>` 内包含 `<br>` 就认为是多行代码块，但有些行内代码可能正好包含 `<br>`（极少见但理论上存在）。

2. **`extractCodeText`** **过于粗暴**（[utils.ts:L116-L121](file:///f:/ganzi/wx-md/src/utils.ts#L116-L121)）：

   ```typescript
   function extractCodeText(raw: string): string {
       const text = raw
           .replace(/<br\s*\/?>/gi, '\n')
           .replace(/<[^>]+>/g, '');  // ← 这会删掉所有标签
       return decodeHtmlEntities(text).trim();
   }
   ```

   * 第2行 `.replace(/<[^>]+>/g, '')` 无差别删除所有 HTML 标签

   * 如果微信代码块内部有 `<span>` 做语法高亮，会被删掉

   * 可能导致缩进丢失（如果微信用 `<span style="padding-left:...">` 做缩进）

3. **模式2 的处理逻辑有 bug**（[utils.ts:L146-L164](file:///f:/ganzi/wx-md/src/utils.ts#L146-L164)）：

   ```typescript
   const code = hasCode
       ? content.replace(/<\/?code[^>]*>/gi, (m: string) => extractCodeText(m))
       : extractCodeText(content);
   const cleanCode = extractCodeText(hasCode ? content : `<x>${code}</x>`);
   ```

   这里对 `hasCode` 的分支处理逻辑不够清晰，`extractCodeText` 被调用了两次，中间变量 `code` 实际上没被用到。

4. **未覆盖的情况**：有些微信文章代码块用 `<p>` + `<span>` + `<br>` 组合渲染，完全不走 `<pre>` 或 `<code>`。

***

## 二、优化方案

### 核心理念：前置清理，后置微调

```
抓取 HTML → 【深度 HTML 清理】 → AI 转 Markdown → 【轻量 Markdown 微调】 → 发布
   ↑                                    ↑
  重点改造                           保持现有但精简
```

***

### 方案 A：渐进式改进（推荐，风险低，改动可控）

在现有架构上做以下改进：

#### A1. 增加 HTML 层面的结构化清理函数 `cleanArticleHtml()`

在 `utils.ts` 中新增一个函数，在 `preprocessHtml()` 调用时执行，**在 AI 转换前**从 HTML 中删除噪音元素：

```typescript
function cleanArticleHtml(html: string): string {
    // 使用正则删除明确的噪音 DOM 结构

    // 1. 删除标题区域（避免在 Markdown 中重复）
    //    - 微信文章的 h1/标题通常在 #activity-name、.rich_media_title 等元素中
    //    - 删除这些区域，让 AI 转换的 Markdown 不含标题

    // 2. 删除作者信息区
    //    - #js_name, .rich_media_meta_text, #js_author_area 等

    // 3. 删除关注引导区
    //    - 包含"关注"、"点击上方蓝字"、"公众号"等引导语的区域

    // 4. 删除底部噪音区
    //    - "分享收藏划线"、"阅读原文"、"推荐阅读"、"人划线"等
    //    - 广告区、往期精选等

    // 5. 删除装饰性元素
    //    - 分割线图片、装饰符号区域等

    // 6. 删除封面图区域（已做，但可以扩展）
    //    - js_cover_area, 以及以 cover 命名的区域
}
```

**关键改动点：**

* 在 [utils.ts preprocessHtml()](file:///f:/ganzi/wx-md/src/utils.ts#L184-L207) 中插入 HTML 清理步骤

* 在 [converter.ts cleanMarkdown()](file:///f:/ganzi/wx-md/src/converter.ts#L18-L44) 中简化 Markdown 清理逻辑

#### A2. 标题处理的改进策略（三层防护）

```
第一层（HTML层）：删除 HTML 中的标题元素
第二层（Markdown层）：删除 Markdown 开头的标题行（保留现有逻辑但优化正则）
第三层（Markdown层）：如果标题作为普通文本出现在前5行，也删除
```

具体改进：

* HTML 层：删除 `#activity-name`、`.rich_media_title`、`<h1>` 等标题元素

* Markdown 层：优化现有正则，支持 `\r\n` 换行，增加模糊匹配

* Markdown 层：新增「前5行内出现标题文本（非标题格式）」的检测

#### A3. 代码块处理的改进

1. **增加对** **`<p>`** **+** **`<span>`** **+** **`<br>`** **组合的识别**：检测连续多个 `<br>` 分隔的 `<span>` 元素
2. **模式3 增加更多限制条件**：要求 `<br>` 出现至少 2 次，或者代码长度超过阈值，才判定为多行代码块
3. **修复** **`extractCodeText`** **的重复调用问题**：简化逻辑
4. **保留语法高亮的** **`<span>`** **标签**：不无差别删除所有标签，而是选择性保留

#### A4. 增加噪音模式的可配置性

将噪音匹配模式提取为数组，便于维护和扩展（不做复杂的配置文件，只用常量数组）：

```typescript
const NOISE_PATTERNS_HTML = [
    // HTML 层面的噪音匹配模式（正则 + 说明）
];

const NOISE_PATTERNS_MD = [
    // Markdown 层面的噪音匹配模式
];
```

***

### 方案 B：引入 HTML 解析器（更彻底，但改动较大）

引入轻量级 HTML 解析器（如 `linkedom`，Worker 兼容，约 10KB gzip），用真正的 DOM API 操作 HTML：

```typescript
import { parseHTML } from 'linkedom';

function cleanArticleHtml(html: string): string {
    const { document } = parseHTML(html);

    // 用 CSS 选择器精确删除噪音元素
    document.querySelectorAll('#js_cover_area, .rich_media_title, ...').forEach(el => el.remove());

    return document.toString();
}
```

**优点：**

* 可以精确地通过 CSS 选择器定位元素

* 对 HTML 结构的处理比正则可靠得多

* 后续维护更简单（加一行选择器就多处理一种噪音）

**缺点：**

* 增加约 10KB 的依赖

* 需要测试 Worker 环境的兼容性

* 改动较大

***

### 方案 C：完全替换转换链路（最大改动，不推荐）

使用 Puppeteer/Playwright 在服务端渲染并提取纯文本正文，或使用专门的微信文章提取服务。改动太大，与当前 Cloudflare Worker 架构不兼容，**不推荐**。

***

## 三、推荐执行路径

**推荐方案 A（渐进式改进）**，具体步骤如下：

### 步骤 1：创建 HTML 清理模块

在 `src/` 下新建 `cleaner.ts`，包含：

* `cleanArticleHtml(html: string): string` — HTML 层面的噪音清理

* 将现有的 `normalizeCodeBlocks()` 迁移过来

* 所有噪音模式以结构化常量定义

### 步骤 2：改进标题处理

* HTML 层：在 `cleanArticleHtml` 中删除标题元素

* Markdown 层：优化 `cleanMarkdown` 中的标题移除逻辑

  * 支持 `\r\n`

  * 增加前 N 行模糊匹配

  * 增加 plain text 标题检测

### 步骤 3：改进代码块处理

* 修复 `extractCodeText` 重复调用问题

* 增加 `<p>` + `<span>` + `<br>` 组合的识别

* 模式3 增加更严格的判定条件

* 保留代码内的语法高亮标签

### 步骤 4：扩展噪音模式覆盖

分析你实际遇到的微信文章样本，补充以下噪音模式：

* 开头：关注引导、作者信息、课程推广、广告

* 结尾：划线标记、阅读原文、推荐阅读、往期精选、点赞引导

* 中间：分割线、装饰图片、公众号卡片

### 步骤 5：集成测试与微调

* 用 5-10 篇不同类型的微信文章测试

* 根据实际效果调整正则和匹配逻辑

* 确保对 Hugo 和 Memos 两种推送都有效

***

## 四、关于替代方案的思考

你问是否有「更有效的方案」，坦白说，纯正则方案（你当前的方案）的瓶颈在于：

> **AI 转换是不可控的，正则匹配是不可靠的，两者叠加让问题变得更复杂。**

如果你愿意接受稍大的改动，**方案 B（引入 linkedom 做真正的 DOM 操作）** 是长期来看最稳定的选择。因为微信文章虽然格式多变，但 DOM 结构是相对固定的（比如标题一定在 `#activity-name`，作者一定在 `#js_name`），用 CSS 选择器比用正则可靠一个数量级。

但如果你希望先快速见效、风险可控，方案 A 是最好的选择。它的改动范围小，每一步都可以独立测试和验证。

***

## 五、总结

| 问题       | 根因                         | 推荐解法                          |
| -------- | -------------------------- | ----------------------------- |
| 标题重复     | AI 转换了标题元素，Markdown 正则删不干净 | HTML 层删除标题元素 + Markdown 层模糊匹配 |
| 开头结尾多余内容 | 仅在 Markdown 正则层面处理，模式太少    | HTML 层结构化删除噪音 DOM + 扩展正则模式库   |
| 代码块处理    | extractCodeText 太粗暴，部分模式遗漏 | 修复逻辑缺陷 + 增加新模式 + 保留语法标签       |

