/**
 * HeatmapPayload → 组件 props 的纯函数映射。
 *
 * 关键约定：
 *   - `level` 不自己分级，一律走 shared/schema2.ts 的 computeLevelThresholds + levelFor，
 *     保证 KV 路径与 live 兜底路径颜色口径一致。
 *   - **周列必须周日起头**（见 alignToSunday）。组件 toWeeks() 是盲目每 7 个切一列，
 *     toMonthLabels() 又拿"每列第一天的月份"当月轴，两者都假定首格是周日；组件里唯一
 *     做这件事的代码在 fetchCalendar()，而我们靠传 props 绕过了它 —— 所以对齐必须自己做。
 *   - 每个真实存在的日期都要产出一个格子（用 schema2 的 eachDay 补齐），
 *     只是补齐之后的序列要先对齐、再整周截断。
 *   - repos 只透传 {name, count, href}，logo 留空 —— 组件 Avatar 会自己回落成首字母。
 */

import {
	computeLevelThresholds,
	eachDay,
	levelFor,
	type HeatmapPayload,
	type RepoCommitRow,
} from "../../shared/schema2.ts";
import type { Contribution, RepoContribution } from "../components/github-activity.tsx";

export type AlignmentInfo = {
	/** 对齐后真正渲染的日期序列 */
	days: string[];
	/** 为了凑到周日而丢掉的开头天数 */
	droppedLeading: number;
	/** 对齐后不足整周、被丢掉的结尾天数 */
	droppedTrailing: number;
};

/**
 * 把日期序列对齐到"首格是周日、长度是 7 的整数倍"。
 *
 * 恒等式：`输入长度 === droppedLeading + droppedTrailing + days.length`，
 * 所以丢了多少天永远算得出来，不会静默丢数据。
 *
 * 对齐逻辑与组件 fetchCalendar() 里 `getUTCDay() === 0` 那句一致，
 * 只不过这里还多做一步"整周截断" —— 组件 toWeeks() 虽然能吃残列，
 * 但残列会让最后一周只有半天，月轴标签也跟着算错。
 */
export function alignToSunday(dates: readonly string[]): AlignmentInfo {
	const leading = dates.findIndex((date) => isSunday(date));
	if (leading < 0) {
		return { days: [], droppedLeading: dates.length, droppedTrailing: 0 };
	}

	const start = dates.slice(leading);
	const wholeWeeks = start.length - (start.length % 7);
	const days = wholeWeeks > 0 ? start.slice(0, wholeWeeks) : [];

	return {
		days,
		droppedLeading: leading,
		droppedTrailing: start.length - days.length,
	};
}

const isSunday = (date: string): boolean =>
	new Date(`${date}T00:00:00Z`).getUTCDay() === 0;

/** 把 daily 里的一天收成非负整数，非法值一律当 0，不抛。 */
const countFor = (daily: Record<string, number>, date: string): number => {
	const raw = daily[date];
	return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
};

export type WidgetMeta = {
	owner: string;
	source: "kv" | "live";
	generatedAt: string;
	/** calendar.available === false 时前端走"只展开提交栏"的降级形态 */
	available: boolean;
	/** 对齐后真正渲染的格子数（正常窗口 371 天 → 371 或 364） */
	cells: number;
	/** 渲染的周数 = cells / 7 */
	weeks: number;
	/** 窗口原始天数（from..to 含端点，对齐前） */
	windowDays: number;
	/** 对齐周列丢掉的开头天数；非 0 说明后端给的窗口起点不是周日 */
	droppedLeadingDays: number;
	/** 对齐后不足整周、丢掉的结尾天数 */
	droppedTrailingDays: number;
	/**
	 * **渲染格子里的 count 之和**，不是后端给的 calendar.total。
	 * 组件的标题数字也是这么算的（contributions.reduce），两边同源，
	 * 所以"标题显示 N"和"格子里加起来是 N"永远一致。
	 */
	total: number;
	/** 后端给的原始 total，仅供对照（可能包含被对齐丢掉的那些天） */
	reportedTotal: number;
	/** 本次分级用的四分位阈值，仅用于调试 */
	thresholds: number[];
};

export type MappedWidget = {
	contributions: Contribution[];
	repos: RepoContribution[];
	meta: WidgetMeta;
};

/** 把仓库行收成组件需要的最小形态；缺字段时静默丢弃而不是抛。 */
export function mapRepos(rows: readonly RepoCommitRow[] | undefined | null): RepoContribution[] {
	if (!Array.isArray(rows)) return [];
	return rows
		.filter(
			(row): row is RepoCommitRow =>
				!!row && typeof row.name === "string" && row.name.length > 0,
		)
		.map((row) => ({
			name: row.name,
			count: Number.isFinite(row.count) && row.count > 0 ? row.count : 0,
			href: typeof row.href === "string" && row.href.length > 0 ? row.href : undefined,
		}))
		.sort((a, b) => b.count - a.count);
}

/**
 * 主映射：daily → 对齐后的 Contribution[]。
 *
 * 分级阈值只从"真正渲染出来的格子"算，和 total 同源 —— 这样"颜色最深的那一级"
 * 和"标题上的总数"描述的是同一批数据，不会因为对齐丢掉几天而自相矛盾。
 */
export function mapToWidgetProps(payload: HeatmapPayload): MappedWidget {
	const windowFrom = payload.window?.from;
	const windowTo = payload.window?.to;
	const daily = payload.calendar?.daily ?? {};

	const windowDays =
		typeof windowFrom === "string" && typeof windowTo === "string"
			? eachDay(windowFrom, windowTo)
			: [];

	const aligned = alignToSunday(windowDays);
	const days = aligned.days;

	const renderedDaily: Record<string, number> = {};
	for (const date of days) renderedDaily[date] = countFor(daily, date);
	const thresholds = computeLevelThresholds(renderedDaily);

	const contributions: Contribution[] = days.map((date) => {
		const count = renderedDaily[date];
		return { date, count, level: levelFor(count, thresholds) };
	});

	const meta: WidgetMeta = {
		owner: typeof payload.owner === "string" ? payload.owner : "",
		source: payload.source ?? "kv",
		generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : "",
		available: payload.calendar?.available === true,
		cells: days.length,
		weeks: Math.floor(days.length / 7),
		windowDays: windowDays.length,
		droppedLeadingDays: aligned.droppedLeading,
		droppedTrailingDays: aligned.droppedTrailing,
		total: contributions.reduce((sum, day) => sum + day.count, 0),
		reportedTotal:
			typeof payload.calendar?.total === "number" && Number.isFinite(payload.calendar.total)
				? payload.calendar.total
				: 0,
		thresholds,
	};

	return { contributions, repos: mapRepos(payload.commits?.repos), meta };
}
