/**
 * 主题 + iframe 消息协议（两端都在这个文件）。
 *
 * 组件 src/components/github-activity.tsx 一行不改，它只需要两样东西：
 *   1) accent —— 由 `accentFor()` 算成具体颜色（5 级数组，或单个颜色字符串）
 *   2) Tailwind 的 --color-card / --color-foreground / --color-background 三个 token
 * 第 2 项由 index.css 的 @theme 接到 --hm-* 变量上，`applyTheme()` 只负责切 .dark class 与写 --hm-hue。
 */

/**
 * 允许嵌这个卡片的那个博客的源。构建时由环境变量 PARENT_ORIGIN 注入，不写死在代码里。
 *
 * 留空 = 完全开放：任何站点都能嵌、都能发主题消息、都能收到高度上报。
 * 真正决定"谁能嵌"的边界是 public/_headers 里的 frame-ancestors。
 */
export const PARENT_ORIGIN: string | null =
	(typeof import.meta.env.PARENT_ORIGIN === "string" && import.meta.env.PARENT_ORIGIN.trim()) || null;

if (typeof window !== "undefined" && !PARENT_ORIGIN) {
	console.warn(
		"[gh-activity-worker] 未配置 PARENT_ORIGIN：任何站点都能嵌这个卡片并控制主题。" +
			"建议构建时注入 PARENT_ORIGIN（见 README）。",
	);
}

/** 卡片默认色相。博客那边最好用同一个值，颜色和主题色能对上。 */
export const DEFAULT_HUE = 250;

/** `?parent=` 只在 DEV 下生效，用来在本地把博客源告诉 iframe。 */
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const COLOR_RE = /^(#[0-9a-f]{3,8}|(?:oklch|hsl|rgb)a?\([^()]*\))$/i;

export type WidgetConfig = {
	/** 是否暗色 */
	dark: boolean;
	/** 主题色调（度），驱动 accent 的 5 级色 */
	hue: number;
	/** URL 里显式给定的单一 accent 颜色；有值时覆盖由 hue 生成的 5 级色 */
	accent: string | null;
	/** backdrop-blur 开关，?blur=0 关掉 */
	blur: boolean;
	/** ?embed=1：被 iframe 嵌住时的干净形态 */
	embed: boolean;
	/** ?debug=1：显示 warnings */
	debug: boolean;
	/** ?fixture=1：不发请求，用内嵌样例数据 */
	fixture: boolean;
	/** DEV 下 `?parent=` 额外放行的父页源 */
	parent: string | null;
};

/** 父页可能通过 postMessage 带来的字段，协议里只有 dark 和 hue */
export type ThemePatch = Partial<Pick<WidgetConfig, "dark" | "hue">>;

const isFlag = (v: string | null): boolean => v === "1" || v === "true";

export function isLocalOrigin(origin: string | null | undefined): origin is string {
	return !!origin && LOCAL_ORIGIN_RE.test(origin);
}

const clampHue = (n: number): number => {
	if (!Number.isFinite(n)) return DEFAULT_HUE;
	const mod = Math.round(n) % 360;
	return mod < 0 ? mod + 360 : mod;
};

/**
 * 首屏配置。dark 缺省时跟随系统偏好，避免裸开页面时闪一下白。
 * hue 缺省用 DEFAULT_HUE（250），跟 GitHub 的蓝色调一致。
 */
export function parseConfig(search: string, opts: { dev: boolean }): WidgetConfig {
	const q = new URLSearchParams(search);
	const darkRaw = q.get("dark");
	// 注意 Number(null) === 0，所以缺省必须按"有没有这个参数"判断，不能靠 Number()
	const hueRaw = q.get("hue");
	const accentRaw = q.get("accent");
	const parentRaw = q.get("parent");

	return {
		dark:
			darkRaw === null
				? typeof window !== "undefined" &&
					window.matchMedia("(prefers-color-scheme: dark)").matches
				: isFlag(darkRaw),
		hue: hueRaw === null || hueRaw === "" ? DEFAULT_HUE : clampHue(Number(hueRaw)),
		accent: accentRaw !== null && COLOR_RE.test(accentRaw) ? accentRaw : null,
		blur: q.get("blur") !== "0",
		embed: isFlag(q.get("embed")),
		debug: isFlag(q.get("debug")),
		fixture: isFlag(q.get("fixture")),
		parent: opts.dev && isLocalOrigin(parentRaw) ? parentRaw : null,
	};
}

/** 把配置落到 documentElement 上；色值本身在 index.css 里按 .dark 分支写死。 */
export function applyTheme(cfg: WidgetConfig): void {
	const el = document.documentElement;
	el.classList.toggle("dark", cfg.dark);
	el.classList.toggle("hm-embed", cfg.embed);
	el.classList.toggle("hm-no-blur", !cfg.blur);
	el.style.setProperty("--hm-hue", String(cfg.hue));
}

/**
 * 生成组件 accent prop 需要的值。
 *
 * 返回 5 个色：第 0 项固定 "transparent" —— 组件 toScale() 对 transparent 给 opacity 0，
 * 空日于是露出格子自带的 bg-foreground/[0.08] 底，和 GitHub 原版一致。
 * 1-4 级用 oklch 字符串，oklch 是感知均匀色空间，同一 hue 下逐级拉开亮度+饱和度最稳。
 */
export function accentFor(cfg: WidgetConfig): string | string[] {
	if (cfg.accent) return cfg.accent;
	const h = cfg.hue;
	return cfg.dark
		? [
				"transparent",
				`oklch(33% 0.06 ${h})`,
				`oklch(46% 0.12 ${h})`,
				`oklch(59% 0.17 ${h})`,
				`oklch(71% 0.21 ${h})`,
			]
		: [
				"transparent",
				`oklch(90% 0.06 ${h})`,
				`oklch(78% 0.13 ${h})`,
				`oklch(65% 0.18 ${h})`,
				`oklch(54% 0.21 ${h})`,
			];
}

/* ------------------------------------------------------------------ */
/* 主题状态：initTheme 一次，之后 postMessage 走 applyThemePatch          */
/* ------------------------------------------------------------------ */

let config: WidgetConfig;
let version = 0;
let devMode = false;
const listeners = new Set<() => void>();

export function initTheme(search: string, opts: { dev: boolean }): WidgetConfig {
	config = parseConfig(search, opts);
	devMode = opts.dev;
	applyTheme(config);
	version = 0;
	return config;
}

export function getConfig(): WidgetConfig {
	return config;
}

export function themeVersion(): number {
	return version;
}

export function subscribeTheme(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

export function applyThemePatch(patch: ThemePatch): void {
	const next: WidgetConfig = { ...config };
	if (typeof patch.dark === "boolean") next.dark = patch.dark;
	if (typeof patch.hue === "number") next.hue = clampHue(patch.hue);
	config = next;
	applyTheme(config);
	version += 1;
	for (const fn of listeners) fn();
}

/* ------------------------------------------------------------------ */
/* iframe 协议：入站 hm-theme / 出站 hm-height                          */
/* ------------------------------------------------------------------ */

/**
 * 入站白名单。配了 PARENT_ORIGIN 就只放行它（DEV 下再放行回环地址与 ?parent=）；
 * 没配就全放行 —— 见文件顶部 PARENT_ORIGIN 的注释。
 */
export function allowedOrigins(): string[] {
	if (!PARENT_ORIGIN) return [];
	const out = [PARENT_ORIGIN];
	if (config.parent) out.push(config.parent);
	return out;
}

export function isAllowedOrigin(origin: string): boolean {
	if (!PARENT_ORIGIN) return true;
	if (allowedOrigins().includes(origin)) return true;
	// 父页可能在任意 localhost 端口起，DEV 下按来源形态放行（生产不放行）
	return devMode && isLocalOrigin(origin);
}

/**
 * 入站消息处理。返回 true 表示已处理。
 * 校验 event.origin：绝不接收 "*" 或非白名单源的消息。
 */
export function handleParentMessage(event: MessageEvent): boolean {
	if (!isAllowedOrigin(event.origin)) return false;
	learnedParentOrigin = event.origin;

	const data = event.data as { type?: unknown; dark?: unknown; hue?: unknown } | null;
	if (!data || typeof data !== "object" || data.type !== "hm-theme") return true;

	const patch: ThemePatch = {};
	if (typeof data.dark === "boolean") patch.dark = data.dark;
	if (typeof data.hue === "number") patch.hue = data.hue;
	if (Object.keys(patch).length > 0) applyThemePatch(patch);
	return true;
}

/** 出站目标：优先用最近一次校验过的入站源，否则回落到已知源。 */
let learnedParentOrigin: string | null = null;

export function postHeight(height: number): void {
	const safeHeight = Math.max(0, Math.ceil(Number.isFinite(height) ? height : 0));
	// 没配 PARENT_ORIGIN 时用 "*"：载荷里只有一个高度数字，不含敏感信息
	const target = learnedParentOrigin ?? config.parent ?? PARENT_ORIGIN ?? "*";
	try {
		window.parent.postMessage({ type: "hm-height", height: safeHeight }, target);
	} catch {
		// 出站失败不该影响渲染
	}
}
