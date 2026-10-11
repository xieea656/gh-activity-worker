/**
 * schema2 —— GitHub 活动数据的唯一合约定义。
 *
 * 采集端（worker/collect.ts）、Worker（worker/）、展示端（src/）三边共用这一份，
 * 避免"两边各写一份类型然后悄悄对不上"。这个文件必须是无依赖、能在 workerd 和浏览器里都跑的类型 + 纯函数。
 *
 */

export const SCHEMA_VERSION = 2 as const;

/** 展示窗口天数：371 = 53 个整周。采集端与展示端都必须用这个常量，不要各写一个 371。 */
export const WINDOW_DAYS = 371 as const;

export type DayCount = number;

/** "2026-09-12" -> 当日提交/贡献数 */
export type DailyMap = Record<string, DayCount>;

export type RepoCommitRow = {
	name: string;
	count: number;
	activeDays: number;
	href: string;
};

export type HeatmapPayload = {
	schema: 2;
	/** ISO 8601，UTC */
	generatedAt: string;
	owner: string;
	/** "kv" = 来自定时采集写入的聚合结果；"live" = Worker 现拉的兜底（只有 calendar 有效） */
	source: "kv" | "live";
	window: {
		/** ISO 日期，UTC */
		from: string;
		to: string;
		/** 窗口天数，固定 371 = 53 整周 */
		days: number;
	};
	calendar: {
		/** false = 没有可用的身份 key，或该 key 读不到 contributionsCollection */
		available: boolean;
		total: number;
		daily: DailyMap;
	};
	commits: {
		total: number;
		repos: RepoCommitRow[];
		/** 值里的 repos 子表用于给"仓库提交"这一栏做逐日 tooltip */
		daily: Record<string, { count: number; repos: Record<string, number> }>;
	};
	warnings: string[];
};

/** KV 里 heatmap 数据的 key。采集端与 Worker 必须用同一个函数生成。 */
export function kvKey(owner: string): string {
	return `heatmap:${owner.toLowerCase()}`;
}

/**
 * 分级：0 空，1-4 按非零值四分位。
 * 放在这里而不是各端自己算，是为了让 KV 路径与 live 兜底路径的颜色口径完全一致。
 */
export function computeLevelThresholds(daily: DailyMap): number[] {
	const values = Object.values(daily).filter((v) => v > 0).sort((a, b) => a - b);
	if (values.length === 0) return [1, 2, 3, 4];
	const q = (p: number) => {
		const idx = (values.length - 1) * p;
		const lo = Math.floor(idx);
		const hi = Math.ceil(idx);
		return values[lo] + (values[hi] - values[lo]) * (idx - lo);
	};
	const thresholds = [q(0.25), q(0.5), q(0.75)].map((t) => Math.max(1, Math.round(t)));
	// 保证严格递增，否则四级会塌成三级
	for (let i = 1; i < thresholds.length; i++) {
		if (thresholds[i] <= thresholds[i - 1]) thresholds[i] = thresholds[i - 1] + 1;
	}
	return thresholds;
}

export function levelFor(count: number, thresholds: number[]): 0 | 1 | 2 | 3 | 4 {
	if (count <= 0) return 0;
	if (count < thresholds[0]) return 1;
	if (count < thresholds[1]) return 2;
	if (count < thresholds[2]) return 3;
	return 4;
}

/** 生成 from..to（含端点）之间每一天的 key，用于补零，保证格子数恒定 */
export function eachDay(from: string, to: string): string[] {
	const out: string[] = [];
	const cursor = new Date(`${from}T00:00:00Z`);
	const end = new Date(`${to}T00:00:00Z`);
	while (cursor <= end) {
		out.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return out;
}

/**
 * 把窗口锚成 53 个**完整周**：终点是「今天所在那一周的周六」，起点 = 终点 - (days-1) 天，必然是周日。
 *
 * 为什么必须锚周：组件里唯一的周日对齐代码在 `fetchCalendar()`（`:134-136`），而我们靠传 props 绕过了它，
 * `toWeeks()`（`:229-236`）盲目 `i += 7` 切列，`toMonthLabels()`（`:76-91`）取每列首日月份 ——
 * 起点不是周日就会星期轴/月份轴整体错位一天。
 *
 * 为什么终点选「本周的周六」而不是「上个已过完的周六」：后者会把最近最多 6 天的活动整段藏掉，
 * 对一个本来就只有 20 多天有活动的稀疏账号是自残。代价是窗口尾部可能含未来的空日（count=0），
 * 这与 GitHub 自己的贡献图行为一致，属于可接受的诚实空值。
 *
 * 采集端与 Worker 的 live 兜底必须 import 这同一个函数，否则两条路径会锚出不同的窗口。
 */
export function weekAnchoredWindow(
	todayIsoDate: string,
	days = WINDOW_DAYS,
): { from: string; to: string; days: number } {
	const t = new Date(`${todayIsoDate}T00:00:00Z`);
	if (Number.isNaN(t.getTime())) throw new Error(`weekAnchoredWindow: 非法日期 ${todayIsoDate}`);
	// 本周周六：getUTCDay() 周日=0 … 周六=6
	const to = new Date(t);
	to.setUTCDate(t.getUTCDate() + (6 - t.getUTCDay()));
	const from = new Date(to);
	from.setUTCDate(to.getUTCDate() - (days - 1));
	return {
		from: from.toISOString().slice(0, 10),
		to: to.toISOString().slice(0, 10),
		days,
	};
}

type ParseResult =
	| { ok: true; payload: HeatmapPayload }
	| { ok: false; errors: string[] };

/**
 * 运行时校验。Worker 读 KV 后必须过这一关：坏数据宁可当没有，
 * 也不能把半截结构透传给前端（前端的降级依赖 `available` 一定存在）。
 */
export function parseHeatmapPayload(unknown: unknown): ParseResult {
	const errors: string[] = [];
	const p = unknown as Partial<HeatmapPayload> | null;

	if (!p || typeof p !== "object") return { ok: false, errors: ["载荷不是对象"] };
	if (p.schema !== SCHEMA_VERSION) errors.push(`schema 期望 ${SCHEMA_VERSION}，实际 ${String(p.schema)}`);
	if (typeof p.owner !== "string" || !p.owner) errors.push("owner 缺失");
	if (typeof p.generatedAt !== "string" || Number.isNaN(Date.parse(p.generatedAt)))
		errors.push("generatedAt 缺失或非法");
	if (!p.window || typeof p.window.from !== "string" || typeof p.window.to !== "string")
		errors.push("window.from/to 缺失");
	if (!p.calendar || typeof p.calendar.available !== "boolean") errors.push("calendar.available 缺失");
	if (!p.commits || !Array.isArray(p.commits.repos)) errors.push("commits.repos 不是数组");
	if (!Array.isArray(p.warnings)) errors.push("warnings 不是数组");

	if (errors.length) return { ok: false, errors };
	return { ok: true, payload: p as HeatmapPayload };
}
