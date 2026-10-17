#!/usr/bin/env node
/**
 * GitHub 活动采集器 —— gh-widgets 数据层的"重活"那一半。
 *
 * 为什么放在 GitHub Actions 而不是 Worker：Cloudflare 免费版**单次调用**上限是
 * 50 个外部子请求 + 10ms CPU，而"仓库提交"一栏要遍历最多 40 个仓库 × 分页（约 200 请求）
 * → 超 4 倍，只能离线做。Worker 只负责 KV 读 + 1 个 GraphQL 兜底。
 * 见 docs/superpowers/specs/2026-10-10-github-activity-widget-design.md 第 3 节。
 *
 * 数据合约：shared/schema2.ts 是唯一真相。本脚本直接 import 它的
 * SCHEMA_VERSION / WINDOW_DAYS / weekAnchoredWindow / kvKey / eachDay /
 * computeLevelThresholds / levelFor / parseHeatmapPayload，
 * 不另写一份分级算法、校验逻辑或窗口锚点（防止 KV 路径与 live 兜底路径口径分叉）。
 *
 * 用法（需要 Node 22.6+；--experimental-strip-types 让 .mjs 能 import .ts）：
 *   node --experimental-strip-types scripts/collect.mjs \
 *     --owner YOUR_USERNAME --token "$GH_TOKEN" --strict
 *
 * 参数：
 *   --owner <login>    目标 GitHub 用户。默认 $GITHUB_OWNER，再默认 YOUR_USERNAME
 *   --token <token>    GitHub token。默认 $GITHUB_TOKEN，再默认 $GH_TOKEN；
 *                      留空也能跑，但贡献墙标记为不可用（公开仓库提交仍可取）
 *   --api-base <url>   REST 与 GraphQL 共用的基址。默认 https://api.github.com，
 *                      可指向 GitHub Enterprise（https://ghe.example.com/api/v3）或代理
 *   --strict           任何非预期失败直接非零退出（CI 用）；默认失败只告警不炸
 *   --out <path>       写文件（原子替换）；省略则把 JSON 打到 stdout
 *
 * 输出约定：stdout 恒为纯 JSON（可安全管道），所有人类可读的日志/告警走 stderr。
 * 产物里不含 token；token 只从参数/环境变量读，只写进请求头。
 *
 * 环境变量（都是可选的兜底）：GITHUB_OWNER / GITHUB_TOKEN / GH_TOKEN /
 *   GITHUB_API_BASE / MAX_REPOS / MAX_PAGES_PER_REPO / INCLUDE_PRIVATE=1
 *
 * INCLUDE_PRIVATE=1 会把私有仓库提交也计入 —— 产物会暴露你在私有仓库的活动节奏，
 * 只适合本地看，别提交进公开仓库。默认关。
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	SCHEMA_VERSION,
	WINDOW_DAYS,
	weekAnchoredWindow,
	kvKey,
	eachDay,
	computeLevelThresholds,
	levelFor,
	parseHeatmapPayload,
} from "../shared/schema2.ts";

const UA = "gh-widgets-collector/1.0";

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const getArg = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};

const OWNER = (getArg("--owner") ?? process.env.GITHUB_OWNER ?? "YOUR_USERNAME").toLowerCase().trim();
const TOKEN = (getArg("--token") ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "").trim();
const API = (getArg("--api-base") ?? process.env.GITHUB_API_BASE ?? "https://api.github.com").replace(/\/+$/, "");
const STRICT = argv.includes("--strict");
const OUT_FILE = getArg("--out");
const MAX_REPOS = Number(process.env.MAX_REPOS ?? 40);
const MAX_PAGES_PER_REPO = Number(process.env.MAX_PAGES_PER_REPO ?? 5); // 每仓最多 500 条
const INCLUDE_PRIVATE = process.env.INCLUDE_PRIVATE === "1";

/** GitHub Enterprise 的 /api/v3 后缀去掉就是仓库主页；github.com 走 api.* → * 的映射 */
const WEB = API.replace(/^https?:\/\/api\.github\.com$/i, "https://github.com").replace(/\/api\/v3$/i, "");

// ---------- 时间窗口（UTC，与 shared/schema2.ts 的 eachDay 同一套口径）----------
// 窗口锚点：唯一实现在合约 shared/schema2.ts 的 weekAnchoredWindow()。
//   终点 to = 今天所在那一周的周六（可能落在未来 —— 尾部未来日 count=0 是可接受的诚实空值，
//              与 GitHub 自己的贡献图行为一致，且不会藏掉今天的活动）
//   起点 from = to - 370 天（必然周日）
// 必须直接 import 而不是自己写日期算术：采集端与 Worker live 兜底若各算一份，
// 两条路径的窗口会分叉，KV 里的数据与实时兜底就对不上了。
// 仅用于 stderr 日志可读性，不参与窗口计算
const DOW_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const weekdayOf = (dateStr) => DOW_NAMES[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];

const WINDOW = weekAnchoredWindow(new Date().toISOString().slice(0, 10));
const START = WINDOW.from;
const END = WINDOW.to;

/** 窗口内合法日期 key 的全集。用来校验 GitHub 返回的日期都落在窗口内 */
const DAY_KEYS = eachDay(START, END);
if (DAY_KEYS.length !== WINDOW_DAYS) {
	console.error(`窗口计算异常：期望 ${WINDOW_DAYS} 天，实际 ${DAY_KEYS.length} 天（${START}..${END}）`);
	process.exit(1);
}
// 锚点自检：起点必须是周日、终点必须是周六，否则展示层整条月份轴会错位一天。
// 宁可本地失败，也不让错位的数据进 KV 再到生产
if (weekdayOf(START) !== "周日" || weekdayOf(END) !== "周六") {
	console.error(`窗口锚点异常：${START} 是${weekdayOf(START)}（应为周日）、${END} 是${weekdayOf(END)}（应为周六），拒绝产出`);
	process.exit(1);
}
const DAY_SET = new Set(DAY_KEYS);

/** 分级口径直接取自合约。这里只用于 stderr 诊断（产物不加 level 字段，见报告说明） */
function logLevelDiagnostics(daily) {
	const thresholds = computeLevelThresholds(daily);
	const dist = [0, 0, 0, 0, 0];
	for (const k of DAY_KEYS) dist[levelFor(daily[k] ?? 0, thresholds)] += 1;
	return `分级阈值 [≥${thresholds[0]}, ≥${thresholds[1]}, ≥${thresholds[2]}] → level 1-4；各级天数 L0=${dist[0]} L1=${dist[1]} L2=${dist[2]} L3=${dist[3]} L4=${dist[4]}`;
}

// ---------- HTTP 封装 ----------
/**
 * GhError：带 status 与限流头的失败。
 * 限流信息（x-ratelimit-remaining / x-ratelimit-reset）必须出现在报错里，
 * 这样 CI 日志能直接看出是"额度用尽"还是"权限不足"。
 */
class GhError extends Error {
	constructor(message, { status, remaining, reset } = {}) {
		super(message);
		this.status = status;
		this.remaining = remaining;
		this.reset = reset;
		this.rateLimited = status === 429 || (status === 403 && remaining === "0");
	}
}

const baseHeaders = {
	accept: "application/vnd.github+json",
	"x-github-api-version": "2022-11-28",
	"user-agent": UA,
};

async function gh(url, { method = "GET", body, authed = false } = {}, label = "请求") {
	const headers = { ...baseHeaders };
	if (authed && TOKEN) headers.authorization = `Bearer ${TOKEN}`;
	if (body !== undefined) headers["content-type"] = "application/json";

	let res;
	try {
		res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	} catch (error) {
		// 网络层失败（DNS / 连接被重置）。URL 里不含 token，直接报出去是安全的
		throw new GhError(`${label} 网络失败：${error?.message ?? error}`);
	}

	const remaining = res.headers.get("x-ratelimit-remaining");
	const reset = res.headers.get("x-ratelimit-reset");
	const when = reset ? new Date(Number(reset) * 1000).toISOString() : null;

	if (res.status === 401 || res.status === 403 || res.status === 429) {
		const why =
			remaining === "0"
				? "主限流已用尽"
				: res.status === 401
					? "token 无效或已撤销"
					: res.status === 429
						? "触发二级限流（secondary rate limit）"
						: "权限不足或 token 类型不对";
		throw new GhError(
			`${label} 被拒（HTTP ${res.status}）：${why}；x-ratelimit-remaining=${remaining ?? "未知"}${when ? `，重置于 ${when}` : ""}`,
			{ status: res.status, remaining, reset },
		);
	}
	if (!res.ok) {
		const detail = (await res.text()).slice(0, 160);
		throw new GhError(`${label} 失败（HTTP ${res.status}）：${detail}`, { status: res.status, remaining, reset });
	}
	return res.json();
}

const problems = [];
const note = (message) => problems.push(message);

// ---------- 1. 贡献墙（GraphQL，1 个请求；读不到就降级，绝不抛错）----------
async function fetchCalendar() {
	const unavailable = (message) => ({ available: false, total: 0, daily: {}, warnings: [message] });

	if (!TOKEN) return unavailable("未配置 GitHub token，贡献墙标记为不可用（只有仓库提交数据）");

	const query = `query ($owner: String!, $from: DateTime!, $to: DateTime!) {
		user(login: $owner) {
			contributionsCollection(from: $from, to: $to) {
				contributionCalendar {
					totalContributions
					weeks { contributionDays { date contributionCount } }
				}
			}
		}
	}`;

	let body;
	try {
		body = await gh(
			`${API}/graphql`,
			{ method: "POST", authed: true, body: { query, variables: { owner: OWNER, from: `${START}T00:00:00Z`, to: `${END}T23:59:59Z` } } },
			"贡献墙查询",
		);
	} catch (error) {
		// token 权限不足是可预期的降级路径，不是采集失败
	// gh() 抛出的消息已经带了调用标签（"贡献墙查询 被拒（HTTP 401）…"），
	// 这里剥掉重复前缀，不然日志里会出现"贡献墙查询失败（贡献墙查询 被拒…）"
		return unavailable(`贡献墙查询失败：${String(error.message).replace(/^贡献墙查询\s+/, "")}，仅更新仓库提交数据`);
	}

	const err = body?.errors?.[0];
	if (err) return unavailable(`贡献墙查询被拒（${String(err.message ?? "未知原因").slice(0, 160)}），仅更新仓库提交数据`);

	if (body?.data?.user === null) return unavailable(`GitHub 上没有 ${OWNER} 这个用户，贡献墙不可用`);

	const calendar = body?.data?.user?.contributionsCollection?.contributionCalendar;
	if (!calendar) return unavailable("贡献墙返回空结构，仅更新仓库提交数据");

	const daily = {};
	for (const week of calendar.weeks ?? []) {
		for (const day of week.contributionDays ?? []) {
			if (!DAY_SET.has(day.date)) continue; // 只统计窗口内的日子
			if (day.contributionCount > 0) daily[day.date] = day.contributionCount;
		}
	}
	return { available: true, total: calendar.totalContributions ?? 0, daily, warnings: [] };
}

// ---------- 2. 仓库列表与提交（REST，分页；失败要往上抛）----------
async function listRepos() {
	const collected = new Map();
	const sources = [`${API}/users/${OWNER}/repos?per_page=100&type=owner`];
	if (INCLUDE_PRIVATE) {
		if (TOKEN) sources.push(`${API}/user/repos?affiliation=owner&visibility=all&per_page=100`);
		else note("INCLUDE_PRIVATE=1 需要 token 才能取到私有仓库，本次按公开口径继续");
	}
	for (const base of sources) {
		for (let page = 1; page <= 5; page++) {
			const batch = await gh(base.includes("?") ? `${base}&page=${page}` : `${base}?page=${page}`, { authed: Boolean(TOKEN) }, "仓库列表");
			if (!Array.isArray(batch) || !batch.length) break;
			for (const repo of batch) {
				if (repo.owner?.login?.toLowerCase() !== OWNER) continue;
				collected.set(repo.name, { name: repo.name, pushedAt: repo.pushed_at ?? "", archived: Boolean(repo.archived) });
			}
			if (batch.length < 100) break;
		}
	}
	return [...collected.values()].sort((a, b) => (a.pushedAt < b.pushedAt ? 1 : -1)).slice(0, MAX_REPOS);
}

async function fetchCommits(repos) {
	const daily = {};
	const summary = [];
	for (const repo of repos) {
		// 窗口内没推过的仓库直接跳过，省请求（pushed_at 一定 >= 最新提交时间）
		if (repo.pushedAt && repo.pushedAt.slice(0, 10) < START) continue;

		let count = 0;
		let page = 1;
		const active = new Set();

		while (page <= MAX_PAGES_PER_REPO) {
			let batch;
			try {
				batch = await gh(
					`${API}/repos/${OWNER}/${repo.name}/commits?since=${START}T00:00:00Z&per_page=100&page=${page}`,
					{ authed: Boolean(TOKEN) },
					`提交记录 ${repo.name}`,
				);
			} catch (error) {
				// 空仓库 409、重命名/删仓 404 都不算异常；限流与授权类必须往上抛
				if (error.status === 404 || error.status === 409) {
					note(`${repo.name}: ${error.message}`);
					batch = [];
				} else throw error;
			}
			if (!Array.isArray(batch) || !batch.length) break;

			for (const commit of batch) {
				const day = commit?.commit?.author?.date?.slice(0, 10);
				if (!day || !DAY_SET.has(day)) continue;
				count++;
				active.add(day);
				const slot = (daily[day] ??= { count: 0, repos: {} });
				slot.count++;
				slot.repos[repo.name] = (slot.repos[repo.name] ?? 0) + 1;
			}
			if (batch.length < 100) break;
			page++;
		}

		if (count > 0) {
			summary.push({ name: repo.name, count, activeDays: active.size, href: `${WEB}/${OWNER}/${repo.name}` });
		}
	}

	summary.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
	return {
		total: summary.reduce((sum, repo) => sum + repo.count, 0),
		repos: summary,
		daily,
	};
}

// ---------- 主流程 ----------
try {
	const [calendar, commits] = await Promise.all([fetchCalendar(), listRepos().then(fetchCommits)]);
	const warnings = [...problems, ...calendar.warnings];
	if (INCLUDE_PRIVATE) warnings.push("INCLUDE_PRIVATE=1：本产物含私有仓库活动，不要提交到公开仓库");

	const payload = {
		schema: SCHEMA_VERSION,
		generatedAt: new Date().toISOString(),
		owner: OWNER,
		source: "kv",
		window: { from: START, to: END, days: WINDOW_DAYS },
		calendar: { available: calendar.available, total: calendar.total, daily: calendar.daily },
		commits,
		warnings,
	};

	// 自己产出也必须过合约校验：宁可本地失败，也不要让坏结构进 KV
	const checked = parseHeatmapPayload(payload);
	if (!checked.ok) {
		console.error(`产物未通过合约校验：${checked.errors.join("；")}`);
		process.exit(1);
	}

	const json = `${JSON.stringify(payload, null, 2)}\n`;

	if (OUT_FILE) {
		const target = path.resolve(process.cwd(), OUT_FILE);
		await mkdir(path.dirname(target), { recursive: true });
		const tmp = `${target}.tmp`;
		await writeFile(tmp, json, "utf8");
		await rename(tmp, target);
	} else {
		process.stdout.write(json);
	}

	// ---- stderr 摘要（stdout 保持纯 JSON）----
	const activeDays = Object.keys(calendar.daily).length;
	const commitDays = Object.keys(commits.daily).length;
	console.error(`owner=${OWNER}  窗口=${START}（${weekdayOf(START)}）..${END}（${weekdayOf(END)}）（${WINDOW_DAYS} 天）  KV key=${kvKey(OWNER)}`);
	console.error(
		`贡献墙：${calendar.available ? `${calendar.total} 次 / ${activeDays} 天有活动` : `不可用（${calendar.warnings[0] ?? "未知原因"}）`}`,
	);
	console.error(`仓库提交：${commits.total} 次 / ${commitDays} 天 / ${commits.repos.length} 个仓库`);
	if (commits.repos.length) console.error(`  ${commits.repos.map((r) => `${r.name} ${r.count}`).join(" · ")}`);
	console.error(`  ${logLevelDiagnostics(calendar.daily)}`);
	for (const warning of warnings) console.error(`  ! ${warning}`);
} catch (error) {
	if (STRICT) {
		console.error(`取数失败：${error.message}`);
		for (const warning of problems) console.error(`  ! ${warning}`);
		process.exit(1);
	}
	console.error(`取数失败（--strict 可让这里非零退出）：${error.message}`);
	for (const warning of problems) console.error(`  ! ${warning}`);
}
