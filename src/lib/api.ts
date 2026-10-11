/**
 * /api/heatmap 客户端。
 *
 * 一律返回结果对象、不抛异常：后端合约要求"任何失败都返回 200 + available:false"，
 * 但网络层本身可能失败（离线、Worker 5xx），所以这里把三类失败都收成 { ok:false, errors }，
 * 由 App.tsx 决定渲染骨架 / 降级卡 / 错误卡。
 */

import {
	parseHeatmapPayload,
	SCHEMA_VERSION,
	weekAnchoredWindow,
	WINDOW_DAYS,
	type HeatmapPayload,
} from "../../shared/schema2.ts";

export type HeatmapResult =
	| { ok: true; payload: HeatmapPayload }
	| { ok: false; errors: string[] };

const reason = (err: unknown): string =>
	err instanceof Error && err.message ? err.message : String(err);

export async function fetchHeatmap(owner: string, signal?: AbortSignal): Promise<HeatmapResult> {
	const url = `/api/heatmap?owner=${encodeURIComponent(owner)}`;

	let res: Response;
	try {
		res = await fetch(url, {
			signal,
			headers: { Accept: "application/json" },
		});
	} catch (err) {
		return { ok: false, errors: [`请求 ${url} 失败：${reason(err)}`] };
	}

	if (!res.ok) {
		return { ok: false, errors: [`接口返回 ${res.status} ${res.statusText}`.trim()] };
	}

	let body: unknown;
	try {
		body = await res.json();
	} catch (err) {
		return { ok: false, errors: [`响应不是合法 JSON：${reason(err)}`] };
	}

	const parsed = parseHeatmapPayload(body);
	if (!parsed.ok) return { ok: false, errors: parsed.errors };
	return { ok: true, payload: parsed.payload };
}

/* ------------------------------------------------------------------ */
/* ?fixture=1 用的内嵌样例：不发请求也能看到完整渲染与动效                */
/* ------------------------------------------------------------------ */

/** 确定性伪随机（mulberry32），保证每次刷新 fixture 数据一致、截图可比对 */
function mulberry32(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = seed;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const toIsoDay = (d: Date): string => {
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
};

const FIXTURE_REPOS = [
	{ name: "my-blog", count: 24, activeDays: 11 },
	{ name: "my-api", count: 18, activeDays: 6 },
	{ name: "side-project", count: 9, activeDays: 4 },
	{ name: "experiments", count: 5, activeDays: 2 },
];

/**
 * 造一份形状合法的 schema2 载荷：371 天窗口、起点是周日。
 *
 * 窗口直接调合约里的 `weekAnchoredWindow`，不自己再算一遍 —— 锚周规则只有一份，
 * 采集端 / Worker 兜底 / 这份 fixture 三处口径一致。
 * 副作用是窗口尾端可能含未来的空日，这是刻意保留的诚实空值，与真实后端形态一致；
 * 下面的循环不给未来日编造数据。
 */
export function fixturePayload(): HeatmapPayload {
	const today = new Date();
	today.setUTCHours(0, 0, 0, 0);
	const todayIso = toIsoDay(today);
	const rnd = mulberry32(20261010);

	const w = weekAnchoredWindow(todayIso, WINDOW_DAYS);
	const days = w.days;
	const from = new Date(`${w.from}T00:00:00Z`);
	const to = new Date(`${w.to}T00:00:00Z`);

	const dates: string[] = [];
	for (let i = 0; i < days; i++) {
		const d = new Date(from);
		d.setUTCDate(from.getUTCDate() + i);
		dates.push(toIsoDay(d));
	}

	const daily: Record<string, number> = {};
	let total = 0;
	for (const date of dates) {
		// 未来日不进 daily：真实后端也拿不到未来的活动，保持空
		if (date > todayIso) continue;
		// 约 2 成空日，非空日用指数分布造出"平时零散、偶尔爆发"的形状
		const count = rnd() < 0.2 ? 0 : Math.max(1, Math.round(Math.exp(rnd() * 3.2) - 1));
		daily[date] = count;
		total += count;
	}

	const commitTotal = FIXTURE_REPOS.reduce((sum, r) => sum + r.count, 0);
	const commitDaily: Record<string, { count: number; repos: Record<string, number> }> = {};
	for (const repo of FIXTURE_REPOS) {
		// 仓库的 count 份提交分摊到它的 activeDays 个活跃日上，
		// 保证"仓库计数"和"逐日明细"两边自洽
		const bucket: number[] = Array.from({ length: repo.activeDays }, () => 0);
		for (let c = 0; c < repo.count; c++) bucket[Math.floor(rnd() * bucket.length)] += 1;
		// 挑 activeDays 个互不重复的窗口日作为该仓库的活跃日（不选未来日）
		const picks: number[] = [];
		let attempts = 0;
		while (picks.length < repo.activeDays && attempts < 1000) {
			attempts += 1;
			const idx = Math.floor(rnd() * days);
			if (picks.includes(idx) || dates[idx] > todayIso) continue;
			picks.push(idx);
		}
		bucket.forEach((n, i) => {
			if (n === 0) return;
			const date = dates[picks[i]];
			if (!commitDaily[date]) commitDaily[date] = { count: 0, repos: {} };
			commitDaily[date].count += n;
			commitDaily[date].repos[repo.name] = (commitDaily[date].repos[repo.name] ?? 0) + n;
		});
	}

	return {
		schema: SCHEMA_VERSION,
		generatedAt: new Date().toISOString(),
		owner: "example",
		source: "kv",
		window: { from: toIsoDay(from), to: toIsoDay(to), days: w.days },
		calendar: { available: true, total, daily },
		commits: {
			total: commitTotal,
			repos: FIXTURE_REPOS.map((r) => ({
				...r,
				href: `https://github.com/example/${r.name}`,
			})),
			daily: commitDaily,
		},
		warnings: ["fixture 数据，来自 src/lib/api.ts 内嵌样例，不是真实统计"],
	};
}
