/**
 * 定时采集：Cron Trigger 每跑一次，重新取一份完整数据写进 KV。
 *
 * 为什么敢把采集塞进 Worker：Cloudflare 免费版单次调用限 50 个外部子请求，
 * 这条链路最多发 1（GraphQL 贡献墙）+ 1（仓库列表）+ MAX_REPOS（每仓 1 页提交）
 * = 默认 22 个，留有余量。而且等网络不计入 CPU 时间，10ms 那条限制够不着这里。
 *
 * 铁律：任何一步失败都只返回结果、绝不抛出 —— 页面永远走"读 KV"那条路，
 * 采集失败最多让数据旧一天，不会让博客白屏。
 */
import {
	SCHEMA_VERSION,
	WINDOW_DAYS,
	weekAnchoredWindow,
	eachDay,
	kvKey,
	parseHeatmapPayload,
	type HeatmapPayload,
	type RepoCommitRow,
} from "../shared/schema2.ts";
import { fetchLiveCalendar } from "./github.ts";

const API = "https://api.github.com";
const UA = "gh-activity-worker/1.0";

/** 一次只统计前几个活跃仓库：每仓 1 个请求，直接决定子请求总数 */
const MAX_REPOS = 20;
/** 每仓只取 1 页。371 天内提交超过这么多次的仓库会被截断，并写进 warnings */
const PER_PAGE = 100;

type Stats = { calls: number };

const baseHeaders: Record<string, string> = {
	accept: "application/vnd.github+json",
	"x-github-api-version": "2022-11-28",
	"user-agent": UA,
};

/** 空仓库 409、重命名或删仓 404 都不算异常，当没数据 */
async function gh(token: string, path: string, stats: Stats): Promise<unknown> {
	stats.calls += 1;
	const headers = { ...baseHeaders };
	if (token) headers.authorization = `Bearer ${token}`;

	const res = await fetch(`${API}${path}`, { headers });
	if (res.status === 404 || res.status === 409) return null;
	if (res.status === 401 || res.status === 403 || res.status === 429) {
		const remaining = res.headers.get("x-ratelimit-remaining") ?? "未知";
		throw new Error(`GitHub 拒绝访问 HTTP ${res.status}（x-ratelimit-remaining=${remaining}）`);
	}
	if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
	return res.json();
}

export type CollectResult =
	| {
			ok: true;
			owner: string;
			calendarDays: number;
			commitTotal: number;
			repos: number;
			calls: number;
	  }
	| { ok: false; error: string };

export async function collect(env: Env): Promise<CollectResult> {
	const owner = (env.HEATMAP_OWNER ?? "").trim().toLowerCase();
	if (!owner) return { ok: false, error: "未配置 HEATMAP_OWNER 变量，跳过采集" };

	const token = (env.GITHUB_TOKEN ?? "").trim();
	if (!token) return { ok: false, error: "未配置 GITHUB_TOKEN secret，跳过采集" };

	const stats: Stats = { calls: 0 };
	const window = weekAnchoredWindow(new Date().toISOString().slice(0, 10));
	const daySet = new Set(eachDay(window.from, window.to));
	const warnings: string[] = [];

	// ---- 1) 贡献墙：恰好 1 个 GraphQL 请求，失败只降级成 available=false ----
	const calendar = await fetchLiveCalendar(owner, env, window);

	// ---- 2) 公开仓库列表：1 个请求 ----
	let repos: Array<{ name?: string; pushed_at?: string; archived?: boolean }>;
	try {
		const list = (await gh(token, `/users/${owner}/repos?per_page=${PER_PAGE}&type=owner`, stats)) as
			| Array<{ name?: string; pushed_at?: string; archived?: boolean }>
			| null;
		if (!Array.isArray(list)) throw new Error("仓库列表返回空");
		repos = list;
	} catch (error) {
		// 列不到仓库就不写入 —— 写进去等于把已统计到的提交数据清零
		return { ok: false, error: `仓库列表取不到，KV 保持不动（${reason(error)}）` };
	}

	const sorted = repos
		.filter((r) => typeof r.name === "string" && !r.archived)
		.sort((a, b) => ((a.pushed_at ?? "") < (b.pushed_at ?? "") ? 1 : -1))
		.slice(0, MAX_REPOS);

	// ---- 3) 每个仓库 1 页提交记录 ----
	const daily: HeatmapPayload["commits"]["daily"] = {};
	const rows: RepoCommitRow[] = [];

	for (const repo of sorted) {
		const name = repo.name!;
		const batch = (await gh(
			token,
			`/repos/${owner}/${name}/commits?since=${window.from}T00:00:00Z&per_page=${PER_PAGE}`,
			stats,
		)) as Array<{ commit?: { author?: { date?: string } } }> | null;
		if (!Array.isArray(batch)) continue;

		let count = 0;
		const active = new Set<string>();
		for (const commit of batch) {
			const day = commit?.commit?.author?.date?.slice(0, 10);
			if (!day || !daySet.has(day)) continue;
			count += 1;
			active.add(day);
			const slot = (daily[day] ??= { count: 0, repos: {} });
			slot.count += 1;
			slot.repos[name] = (slot.repos[name] ?? 0) + 1;
		}

		if (count > 0) rows.push({ name, count, activeDays: active.size, href: `https://github.com/${owner}/${name}` });
		if (batch.length >= PER_PAGE) {
			warnings.push(`${name}：371 天内提交超过 ${PER_PAGE} 次，只统计了前 ${PER_PAGE} 次`);
		}
	}

	rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

	const payload: HeatmapPayload = {
		schema: SCHEMA_VERSION,
		generatedAt: new Date().toISOString(),
		owner,
		source: "kv",
		window: { from: window.from, to: window.to, days: WINDOW_DAYS },
		calendar: { available: calendar.available, total: calendar.total, daily: calendar.daily },
		commits: { total: rows.reduce((sum, r) => sum + r.count, 0), repos: rows, daily },
		warnings: [...warnings, ...calendar.warnings],
	};

	const checked = parseHeatmapPayload(payload);
	if (!checked.ok) return { ok: false, error: `产物未通过合约校验：${checked.errors.join("；")}` };

	// 单调性守卫：不许用残缺产物覆盖完整数据。GitHub 偶尔限流，下次采集会补回来
	let key: string;
	try {
		key = kvKey(owner);
		const existing = await env.HEATMAP_KV.get(key);
		if (existing) {
			const prev = parseHeatmapPayload(JSON.parse(existing));
			if (prev.ok && prev.payload.calendar.available && !checked.payload.calendar.available) {
				return { ok: false, error: "本次取不到贡献墙，KV 里已有完整数据，拒绝覆盖（保留旧值）" };
			}
		}
	} catch (error) {
		return { ok: false, error: `读旧值失败，KV 保持不动（${reason(error)}）` };
	}

	await env.HEATMAP_KV.put(key, JSON.stringify(checked.payload));

	return {
		ok: true,
		owner,
		calendarDays: Object.keys(checked.payload.calendar.daily).length,
		commitTotal: checked.payload.commits.total,
		repos: rows.length,
		calls: stats.calls + 1, // +1 是贡献墙那次 GraphQL
	};
}

const reason = (err: unknown): string =>
	err instanceof Error && err.message ? err.message : String(err);
