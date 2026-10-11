/**
 * 实时兜底：KV 为空或数据坏掉时，用**恰好 1 个** GraphQL 请求现拉贡献墙。
 *
 * 为什么只发 1 个请求：贡献墙必须走 GraphQL（REST 拿不到 contributionsCollection），
 * 而"仓库提交"那一栏要遍历仓库 × 分页，单次调用的子请求上限塞不下 —— 那部分由
 * Cron Trigger 在 worker/collect.ts 里离线做，落进 KV。所以 live 路径只出 calendar。
 *
 * 铁律：任何失败都不抛错，一律降级成 available=false 并写明原因。
 */
import {
	SCHEMA_VERSION,
	WINDOW_DAYS,
	eachDay,
	computeLevelThresholds,
	levelFor,
	weekAnchoredWindow,
} from "../shared/schema2.ts";

/** 兜底只发这一个请求，打到固定的 github.com（不走代理，Worker 出口直连） */
const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

export type LiveCalendar = {
	/** false = 没配 secret / secret 读不到 / 请求失败。前端据此走空态 */
	available: boolean;
	total: number;
	/** date(YYYY-MM-DD, UTC) -> count，只收录窗口内且 count > 0 的日子 */
	daily: Record<string, number>;
	/** 人类可读的原因，进响应的 warnings 字段 */
	warnings: string[];
};

const QUERY = `query ($owner: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $owner) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

/**
 * live 兜底。`window` 省略时用合约 `weekAnchoredWindow()` 算出的当前窗口。
 * 锚点算法全仓库只有一份（shared/schema2.ts），本文件不另写日期算术 ——
 * 否则 live 路径与 KV 路径各算一套窗口，两条数据会错列。
 */
export async function fetchLiveCalendar(
	owner: string,
	env: Env,
	window: { from: string; to: string; days?: number } = weekAnchoredWindow(new Date().toISOString().slice(0, 10)),
): Promise<LiveCalendar> {
	const fail = (why: string): LiveCalendar => ({
		available: false,
		total: 0,
		daily: {},
		warnings: [`贡献墙实时兜底不可用：${why}`],
	});

	// 窗口长度以合约常量 WINDOW_DAYS 为准：调用方传进来的 days 若不是正数，
	// 退回合约算出的那份。live 路径是"发 1 个 GraphQL 请求换数据"，窗口算错了
	// 就是拿 135 冒充 141，而且没有任何报错 —— 宁可退到正确窗口。
	const canonicalWindow = {
		from: window.from,
		to: window.to,
		days: Number.isFinite(window.days) && window.days! > 0 ? window.days : WINDOW_DAYS,
	};

	// secret 没配不是异常，就是"这一档能力没开"
	const token = (env.GITHUB_TOKEN ?? "").trim();
	if (!token) return fail("未配置 GITHUB_TOKEN secret");

	const daySet = new Set(eachDay(canonicalWindow.from, canonicalWindow.to));

	let body: {
		errors?: Array<{ message?: string }>;
		data?: { user?: { contributionsCollection?: { contributionCalendar?: unknown } } | null } | null;
	};
	try {
		const res = await fetch(GRAPHQL_ENDPOINT, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				accept: "application/json",
				"x-github-api-version": "2022-11-28",
			},
			body: JSON.stringify({
				query: QUERY,
				variables: { owner, from: `${canonicalWindow.from}T00:00:00Z`, to: `${canonicalWindow.to}T23:59:59Z` },
			}),
		});

		const remaining = res.headers.get("x-ratelimit-remaining") ?? "未知";
		if (res.status === 401) return fail("token 无效或已撤销（HTTP 401）");
		if (res.status === 403 || res.status === 429)
			return fail(`被限流或权限不足（HTTP ${res.status}，x-ratelimit-remaining=${remaining}）`);
		if (!res.ok) return fail(`HTTP ${res.status}`);

		body = (await res.json()) as typeof body;
	} catch (error) {
		return fail(`请求失败：${error instanceof Error ? error.message : String(error)}`);
	}

	const err = body.errors?.[0];
	if (err) return fail(`查询被拒（${String(err.message ?? "未知原因").slice(0, 160)}）`);
	if (body.data?.user === null) return fail(`GitHub 上没有 ${owner} 这个用户`);

	const calendar = body.data?.user?.contributionsCollection?.contributionCalendar as
		| { totalContributions?: number; weeks?: Array<{ contributionDays?: Array<{ date: string; contributionCount: number }> }> }
		| undefined;
	if (!calendar) return fail("返回空结构");

	const daily: Record<string, number> = {};
	for (const week of calendar.weeks ?? []) {
		for (const day of week.contributionDays ?? []) {
			// 只统计窗口内的日子，避免 GitHub 多给的整周边界污染窗口
			if (!daySet.has(day.date)) continue;
			if (day.contributionCount > 0) daily[day.date] = day.contributionCount;
		}
	}

	// 分级口径取自合约，保证与 KV 路径同源（产物里不带 level 字段，这里只为观测）
	const thresholds = computeLevelThresholds(daily);
	const maxLevel = Math.max(...Object.values(daily).map((count) => levelFor(count, thresholds)), 0);
	console.log(
		`live calendar owner=${owner} schema=${SCHEMA_VERSION} days=${Object.keys(daily).length} ` +
			`thresholds=[${thresholds.join(",")}] maxLevel=${maxLevel}`,
	);

	return { available: true, total: calendar.totalContributions ?? 0, daily, warnings: [] };
}
