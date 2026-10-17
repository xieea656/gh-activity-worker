# gh-activity-worker

一个 Cloudflare Worker，把 GitHub 的「贡献墙 + 仓库提交」做成一张可以嵌进博客的卡片。

```
Cloudflare Cron Trigger（每天一次，UTC 03:17）
        │  发 1 个 GraphQL 请求取贡献墙 + 1 个请求取仓库列表 + 每个仓库 1 个请求
        ▼
      KV ──── 1 个 key，存一整份 371 天的数据（几 KB）
        │
        ▼
  GET /api/heatmap  ←── 博客 iframe 里的那张卡片
        │  KV 读不到就发 1 个 GraphQL 请求兜底，任何情况都返回 200
        ▼
   Workers Static Assets（React 展示站）
```

仓库里没有配置，也不该有：**你的域名、你的 KV、你的 GitHub token 全部在 Cloudflare 面板里填**，不用改一行代码。

---

## 前置条件

- 一个 Cloudflare 账号，plan 里带 Workers
- 一个 GitHub 账号
- 想嵌的地方：任意一个博客 / 网页

---

## 安装

### 1. Fork 这个仓库

页面上点 `Fork`。以后你只维护自己那份。

### 2. 建一个 KV 命名空间

Cloudflare Dashboard → **Workers & Pages** → 左侧 **KV Namespaces** → **Create namespace**。

名字随便起（比如 `gh-activity-kv`）。记下页面顶部那个 **Namespace ID**（一串 32 位十六进制）。

### 3. 建 Worker 并接上这个仓库

**Workers & Pages** → **Create** → **Build an application** → 选你的仓库 → **Install and deploy**。

构建命令留默认：`npm install && npm run build`（`npm run build` 会先跑 `scripts/gen-headers.mjs` 再生成静态资源，别改）。

### 4. 绑 KV

进入这个 Worker → **Settings** → **Bindings** → **KV Namespace** → **Add**。

- `Binding name` 填 `HEATMAP_KV`（**必须一字不差**，代码里写死了这个名字）
- 下拉里选第 2 步建的那个命名空间

### 5. 填你的 GitHub 用户名

同一个 Worker → **Settings** → **Variables and Secrets** → **Variables and Secrets** 区域 → **Add Variable**。

| 名称 | 值 |
| --- | --- |
| `HEATMAP_OWNER` | 你的 GitHub 用户名，小写 |

### 6. 填 GitHub token

还是在 **Variables and Secrets**，下面那个 **Secrets** 区域 → **Add Secret**。

| 名称 | 值 |
| --- | --- |
| `GITHUB_TOKEN` | 你的 GitHub token |

**token 怎么生成**（github.com → Settings → Developer settings → Personal access tokens）：

- **classic token**（推荐，最省心）：勾 `read:user`。要看私有仓库的提交再勾 `repo`。
- **fine-grained token**：给 `User profile` 开 Read-only，再给 `Repositories` 开 Read-only。

只读权限就够，不要给写权限。

### 7. 重部署

**Deploy** → **Deploy from GitHub**。以后每次 push 到默认分支都会自动部署。

### 8. （可选）绑一个自己的域名

**Settings** → **Domains & Routes** → **Custom Domains** → **Deploy to Custom Domain** → 填子域名（比如 `widgets.example.com`）。

不绑也能用：面板会给你分配一个 `xxx.your-account.workers.dev`，直接拿那个地址也行。

### 9. 确认 KV 里已经有数据

Worker → **Logs**（Workers Logs），找一条 `[collect] owner=... 已写入 KV`。

有这条说明定时采集跑通了。也可以直接打开 `https://你的地址/api/heatmap`，应该是一整份 JSON。

### 10. 收紧谁能嵌你的卡片（建议做）

`public/_headers` 里的 `frame-ancestors` 默认是 `*`，意味着任何网站都能把你的卡片嵌进它自己的页面里。想只允许自己的博客：

在 Cloudflare Dashboard → 这个 Worker → **Settings** → **Environment variables** 里，把 `PARENT_ORIGIN` 加成一个**构建环境变量**，值是博客地址（不带结尾斜杠）：

```
PARENT_ORIGIN = https://blog.example.com
```

重部署一次，`scripts/gen-headers.mjs` 会把它写进 `Content-Security-Policy: frame-ancestors`，前端的 `postMessage` 白名单也同时收紧成这个源。

---

## 嵌进博客

博客端集成。整段直接抄：

```astro
---
/**
 * 首页"博客活动"栏 —— GitHub 活动展示 iframe 容器。
 *
 * 数据与展示由 https://widgets.example.com/ 承载（Cloudflare Workers + React +
 * Rare UI github-activity 组件，见本仓库），本页只负责：
 *   - 首屏把当前主题（dark/hue）拼进 iframe 的 src，避免"先亮后暗"闪一下；
 *   - 监听 <html> 的 class / style 变化，主题切换时向 iframe 发 hm-theme；
 *   - 接收 iframe 的 hm-height 消息，写 iframe.style.height 保持无内部滚动条。
 *
 * 注意：本仓库同一页面分组里只能存在一个 <style is:global> 块，
 * 因此这里一律用 Tailwind 类与内联样式，不新增任何 <style> 块。
 */
interface Props {
	class?: string;
	style?: string;
}
const { class: className = "", style = "" } = Astro.props;

// 首屏占位高度，避免 iframe 加载期间出现 CLS 抖动（组件收起态约 120–140px）。
const PLACEHOLDER_HEIGHT = "130px";
---

<div
	class={`card-base px-9 py-6 w-full rounded-[var(--radius-large)] overflow-hidden ${className}`}
	style={style}
>
	<iframe
		data-widget="true"
		data-base="https://widgets.example.com/"
		loading="lazy"
		frameborder="0"
		scrolling="no"
		title="博客活动：GitHub 活动热力图与仓库提交"
		class="block w-full border-0"
		style={`height: ${PLACEHOLDER_HEIGHT}; min-height: ${PLACEHOLDER_HEIGHT};`}
	></iframe>
	<noscript>
		<div class="text-sm opacity-70">
			本页在启用 JavaScript 后会在此显示 GitHub 活动；或直接访问
			<a class="transition link text-[var(--primary)] font-medium" href="https://widgets.example.com/" target="_blank" rel="noopener noreferrer">
				widgets.example.com
			</a>
			。
		</div>
	</noscript>
</div>

<script is:inline data-astro-rerun>
	// 消息来源 / 目标都写死为 widgets 域，绝不接受任何 "*" 或不校验 origin 的写法。
	const WIDGET_ORIGIN = "https://widgets.example.com";
	const DEFAULT_HUE = 250;

	// swup 翻页会让脚本重跑；先释放上一轮挂在全局的句柄，避免 listener / observer 累积。
	const PREV = window.__ghActivityWidget;
	if (PREV) {
		if (PREV.observer) PREV.observer.disconnect();
		if (PREV.onMessage) window.removeEventListener("message", PREV.onMessage);
	}

	const HOST = document.querySelector('[data-widget="true"]');
	if (!HOST) {
		/* 静默跳过：找不到宿主时不抛错，不影响页面其它功能。 */
	} else {
		const readTheme = function () {
			const root = document.documentElement;
			const dark = root.classList.contains("dark");
			const raw = getComputedStyle(root).getPropertyValue("--hue").trim();
			const parsed = Number.parseInt(raw, 10);
			return { dark: dark, hue: Number.isFinite(parsed) ? parsed : DEFAULT_HUE };
		};

		const buildUrl = function (theme) {
			const base = HOST.getAttribute("data-base") || (WIDGET_ORIGIN + "/");
			const url = new URL(base);
			url.searchParams.set("dark", theme.dark ? "1" : "0");
			url.searchParams.set("hue", String(theme.hue));
			url.searchParams.set("embed", "1");
			return url.toString();
		};

		const sendTheme = function (theme) {
			if (HOST.contentWindow) {
				HOST.contentWindow.postMessage(
					{ type: "hm-theme", dark: theme.dark, hue: theme.hue },
					WIDGET_ORIGIN,
				);
			}
		};

		const applyHeight = function (height) {
			if (Number.isFinite(height) && height > 0) {
				HOST.style.height = height + "px";
			}
		};

		// 首屏：把当前主题写进 iframe 的 src，避免"先亮后暗"。
		HOST.src = buildUrl(readTheme());

		// 接收 iframe 上报的高度；必须校验 origin，不接受任何非 widgets 域的消息。
		// 用具名函数引用，以便 swup 重跑时 removeEventListener 能真正删掉。
		const onMessage = function (event) {
			if (event.origin !== WIDGET_ORIGIN) return;
			const data = event.data;
			if (!data || data.type !== "hm-height") return;
			applyHeight(data.height ?? 0);
		};
		window.addEventListener("message", onMessage);

		// 主题切换：博客切明暗就是改 <html> 的 class，改色相就是改 <html> 的 style。
		// 变化时读一次当前值发给 iframe（不重建 iframe，避免闪烁）。
		const root = document.documentElement;
		const observer = new MutationObserver(function () {
			sendTheme(readTheme());
		});
		observer.observe(root, { attributes: true, attributeFilter: ["class", "style"] });

		// 把本轮句柄挂到全局槽，下一轮重跑时先释放。
		window.__ghActivityWidget = { observer: observer, onMessage: onMessage };
	}
</script>
```

样式类换成你博客自己的（`card-base`、`rounded-[var(--radius-large)]`、`text-[var(--primary)]` 是 CSS 变量名，值随博客主题走）。`swup` 相关那段（`data-astro-rerun`、`window.__ghActivityWidget` 释放句柄）只在博客用了 swup 翻页时才需要，其它框架删掉也无影响。

**URL 参数**

| 参数 | 作用 |
| --- | --- |
| `embed` | `1` = 嵌进别的站点的形态（去掉外层留白） |
| `dark` | `1` / `0`，明暗主题 |
| `hue` | 色相，`0`-`360`，默认 `250` |
| `accent` | 一个 CSS 颜色，覆盖整个调色板 |
| `owner` | 换一个 GitHub 用户名展示（只在 `HEATMAP_OWNER` 匹配时才返回数据，否则给空态） |
| `cellSize` / `months` / `label` | 格子大小 / 月份轴 / 底部标签文案 |
| `debug` | `1` = 在卡片下方打印数据诊断信息 |
| `fixture` | `1` = 不发请求，用内置假数据（本地开发用） |

---

## 数据是怎么刷新的

**Cloudflare 免费版没有免费的"后台定时任务"** —— 唯一的定时机制就是 **Cron Trigger**，而它每次触发都是一次真实的 Worker 调用。所以这套设计把定时和取数合在一处：

`worker/index.ts` 的 `scheduled()` 每天被 Cron Trigger 打一次，调 `worker/collect.ts` 取完整数据写进 KV；博客访问时走的 `fetch()` 只读 KV，不碰 GitHub。

```
wrangler.jsonc:  "crons": ["17 3 * * *"]      ← UTC 时区，北京时间每天 11:17
worker/collect.ts:  贡献墙 1 次 + 仓库列表 1 次 + 最多 20 个仓库各 1 次 = 最多 22 次请求
```

**为什么敢把采集塞进 Worker**：免费版单次调用限 50 个外部子请求，这条链路最多 22 个，留有余量；而且 Cloudflare 计费只看 CPU 时间，等网络（`fetch` / KV 读写）不计入 CPU，10ms 那条限制够不着这里。

**GitHub 请求量**：认证 token 限额是每小时 5000 次，一天 22 次绰绰有余。

**KV 空或数据坏掉时**：`worker/heatmap.ts` 自己发 1 个 GraphQL 请求现拉贡献墙（只出日历，不出仓库提交），并**永远返回 200**。前端拿到的永远是形状完整的 JSON，只是 `calendar.available` 可能是 `false`。

**单调性守卫**：`collect.ts` 写入前会先读旧值 —— 如果旧值里有贡献墙、新值里取不到，就**拒绝覆盖**。GitHub 偶尔限流，下次采集会自己补回来，不至于把好数据冲掉。

**缓存**：`/api/heatmap` 的响应头是 `Cache-Control: public, max-age=21600, stale-while-revalidate=86400`，也就是最多六小时内是同一份数据。想立刻看到变化，看 JSON 里的 `generatedAt` 字段判断数据新旧，别拿秒级预期。

---

## 常见情况

**卡片空白，控制台报 `frame-ancestors`**
嵌入方的域名不在 `frame-ancestors` 里。要么把 `PARENT_ORIGIN` 加进去，要么别收紧。

**数字和 GitHub 页面上看到的对不上**
两边统计口径不同：这里的"贡献"是 GitHub 贡献墙的定义，"提交"是 REST `/commits` 的口径，且窗口固定 371 天、按周对齐（起点必然是周日，终点可能落在未来）。看 `?debug=1` 输出的 `warnings` 和 `thresholds` 能看出具体丢了几天。

**`warnings` 里出现「未配置 GITHUB_TOKEN」**
第 6 步没做，或名称写错了（必须是 `GITHUB_TOKEN`）。

**私有仓库的提交没算进去**
`/users/{owner}/repos?type=owner` 默认只列公开仓库。要看私有仓库得用带 `repo` 权限的 classic token，并把私有仓库也拉进来 —— 注意这会把你私有仓库的活跃度暴露给任何能看到这张卡片的人。

**某个仓库的计数像是被截断了**
`warnings` 里会有「371 天内提交超过 100 次，只统计了前 100 次」。要更多就把 `worker/collect.ts` 里的 `PER_PAGE` / `MAX_REPOS` 调大，同时留意的 50 个子请求上限。

**改动之后卡片没变**
先确认第 9 步的日志里有没有新的 `[collect]`，再确认浏览器缓存（`max-age=21600`）。加 `?_=随便一串` 强制绕过。

**本地开发**
```
npm install
npm run dev                     # Vite dev server，前端 + Worker 本地跑
PARENT_ORIGIN=http://localhost:5173 npm run build
npm run lint
```
本地起的是 `localhost`，所以 `PARENT_ORIGIN` 也要是本地地址，否则主题消息进不来。

---

## 二次开发

- **改颜色 / 排版**：`src/index.css`（全部样式）、`src/lib/theme.ts`（主题与 `postMessage` 协议）。
- **改卡片内容**：`src/components/github-activity.tsx` 是第三方组件，**尽量别改**。要加东西就在 `src/App.tsx` 的外层加。
- **改数据契约**：`shared/schema2.ts`。前端、Worker、采集三边共用这一个文件，改它不会有一边悄悄落后。
- **改时间窗口**：`WINDOW_DAYS`（默认 371 = 53 周）。组件是 53 周布局，改别的值会撑破或留白。

---

## 署名与授权

卡片的 UI 组件来自 **Rare UI**（MIT + Commons Clause + Attribution）。授权条款要求：任何使用这份代码的项目都必须放一个**可见的 https://rareui.com 链接**，位置可以是页脚、关于页、致谢页或 README。

这份仓库已经做到两点：

1. `LICENSE-rare-ui.txt` 原样保留，版权与署名声明未被移除；
2. 卡片独立打开时（不带 `?embed=1`）底部会自动显示 `UI by Rare UI` 链接。

**你把卡片嵌进博客时**，请在博客自己的页脚（或关于页 / 致谢页）放一个指向 https://rareui.com 的可见链接。

另外授权只允许你把组件用在**你自己的网站或产品**里。不允许把组件本身（或这个仓库整体）拿出来转售、再分发、或作为产品的一部分提供给别人 —— 这是 Commons Clause 的硬限制。
