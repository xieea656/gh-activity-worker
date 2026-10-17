#!/usr/bin/env node
/**
 * 合约自检：证明 shared/schema2.ts 的纯函数与运行时校验按预期工作，
 * 并且本仓库采集端的产物形状与合约一致。
 *
 * 用法（需要 Node 22.6+，--experimental-strip-types 用来 import .ts）：
 *   node --experimental-strip-types scripts/check-contract.mjs
 *   node --experimental-strip-types scripts/check-contract.mjs --payload <collect.mjs 的产物>
 *
 * 最后一条断言（可选）用真实产物再跑一遍 parseHeatmapPayload，
 * 这样 CI 里就能发现"合约改了三边没跟上"这类漂移。
 * 退出码非 0 = 有断言失败。
 */
import { readFile } from "node:fs/promises";
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

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
	if (condition) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
	}
}

const SECTION = (title) => console.log(`\n— ${title}`);

// ---------- 窗口锚点校验 ----------
// 窗口必须锚在完整周上：GitHub 贡献日历以周日为列首，展示组件 toWeeks() 是盲目
// i += 7 切列、toMonthLabels() 取 weeks[index][0].date 的月份。起点若不是周日，
// 整条月份轴与星期轴会错位一天。这三条断言是「窗口形状」的硬约束。
const DOW_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const dowOf = (dateStr) => DOW_NAMES[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
function assertAnchoredWindow(title, window) {
	check(`${title}：起点是周日`, dowOf(window.from) === "周日", `${window.from} 是${dowOf(window.from)}`);
	check(`${title}：终点是周六`, dowOf(window.to) === "周六", `${window.to} 是${dowOf(window.to)}`);
	check(`${title}：终点减起点恰好 370 天`, (Date.parse(`${window.to}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`)) / DAY === 370);
	check(`${title}：days === 371`, window.days === 371, `实际 ${window.days}`);
}

// ---------- 窗口锚点：weekAnchoredWindow 是本仓库唯一的窗口算法 ----------
SECTION("窗口锚点：weekAnchoredWindow 语义");
{
	check("WINDOW_DAYS === 371（53 个整周）", WINDOW_DAYS === 371, `实际 ${WINDOW_DAYS}`);
	for (const [today, from, to] of [
		["2026-10-11", "2025-10-12", "2026-10-17"],
		["2026-10-12", "2025-10-12", "2026-10-17"],
		["2026-10-17", "2025-10-12", "2026-10-17"],
		["2025-10-06", "2024-10-06", "2025-10-11"],
	]) {
		check(`今天 ${today}（${dowOf(today)}）→ ${from}..${to}`, JSON.stringify(weekAnchoredWindow(today)) === JSON.stringify({ from, to, days: 371 }), JSON.stringify(weekAnchoredWindow(today)));
	}
	// 今天落在周一到周六时，终点必须停在「本周一周的周六」，而不是下一个周六 ——
	// 这是与「取已完成的周六」的区别所在
	check("今天周五时终点是同一周的周六", weekAnchoredWindow("2026-10-16").to === "2026-10-17");
	// 允许终点落在未来；未来日 count=0 是诚实空值
	const fut = weekAnchoredWindow("2026-10-11");
	check("终点允许落在未来", fut.to > "2026-10-11");
	// 穷举未来 84 天，窗口形状必须始终是周日..周六、跨度 370、共 371
	let bad = [];
	for (let i = 0; i < 84; i++) {
		const t = new Date(Date.parse("2026-01-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
		const w = weekAnchoredWindow(t);
		if (dowOf(w.from) !== "周日" || dowOf(w.to) !== "周六" || (Date.parse(`${w.to}T00:00:00Z`) - Date.parse(`${w.from}T00:00:00Z`)) / 86_400_000 !== 370 || w.days !== 371) bad.push(t);
	}
	check("穷举 84 天窗口形状恒为周日..周六 / 跨度 370 / 371 天", bad.length === 0, bad.slice(0, 5).join(","));
	// 非法日期必须抛错（live 兜底路径据此拒绝坏窗口，而不是静默产出错位数据）
	let threw = false;
	try {
		weekAnchoredWindow("不是日期");
	} catch {
		threw = true;
	}
	check("非法日期抛错", threw);
}

// ---------- 夹具：一份能通过校验的完整载荷 ----------
const DAY = 86_400_000;
const anchor = Date.parse("2026-10-10T00:00:00Z");
const from = new Date(anchor - 370 * DAY).toISOString().slice(0, 10);
const to = "2026-10-10";

function makeValidPayload(overrides = {}) {
	const daily = {};
	for (let i = 0; i < 371; i++) {
		const key = new Date(anchor - (370 - i) * DAY).toISOString().slice(0, 10);
		daily[key] = i === 0 ? 0 : i % 3;
	}
	const calendarTotal = Object.values(daily).reduce((a, b) => a + b, 0);
	const commitsDaily = {};
	for (let i = 0; i < 27; i++) {
		const key = new Date(anchor - (26 - i) * DAY).toISOString().slice(0, 10);
		commitsDaily[key] = { count: 4, repos: { fuwari: 3, homeweb: 1 } };
	}
	const commitsTotal = Object.values(commitsDaily).reduce((a, s) => a + s.count, 0);
	return {
		schema: SCHEMA_VERSION,
		generatedAt: "2026-10-10T15:31:02.113Z",
		owner: "YOUR_USERNAME",
		source: "kv",
		window: { from, to, days: 371 },
		calendar: { available: true, total: calendarTotal, daily },
		commits: {
			total: commitsTotal,
			repos: [
				{name: "fuwari", count: 81, activeDays: 20, href: "https://github.com/YOUR_USERNAME/fuwari"},
				{name: "homeweb", count: 31, activeDays: 7, href: "https://github.com/YOUR_USERNAME/homeweb"},
			],
			daily: commitsDaily,
		},
		warnings: [],
		...overrides,
	};
}

SECTION(`1. parseHeatmapPayload：完整载荷（schema ${SCHEMA_VERSION}）`);
{
	const good = makeValidPayload();
	const res = parseHeatmapPayload(good);
	check("完整载荷 ok === true", res.ok === true, res.ok ? "" : JSON.stringify(res.errors));
	if (res.ok) {
		check("回读出的对象与输入同一引用", res.payload === good);
		check("回读出的 owner 一致", res.payload.owner === "YOUR_USERNAME");
		check("回读出的 daily 有 371 个 key", Object.keys(res.payload.calendar.daily).length === 371);
	}
}

SECTION("2. parseHeatmapPayload：截断 / 缺字段 / schema 错误");
{
	const truncated = JSON.stringify(makeValidPayload()).slice(0, 60);
	let parsed;
	try {
		parsed = JSON.parse(truncated);
	} catch {
		parsed = truncated; // 保持字符串，模拟"KV 里存了半截 JSON"
	}
	const res = parseHeatmapPayload(parsed);
	check("半截 JSON（不是对象）ok === false", res.ok === false);
	if (!res.ok) check("错误信息指名道姓", res.errors.length >= 1 && String(res.errors[0]).includes("不是对象"), JSON.stringify(res.errors));

	const cases = [
		{ name: "schema 是字符串 '2'", patch: { schema: "2" }, want: "schema" },
		{ name: "schema 缺字段", patch: { schema: undefined }, want: "schema" },
		{ name: "owner 是空串", patch: { owner: "" }, want: "owner" },
		{ name: "generatedAt 不是合法时间", patch: { generatedAt: "yesterday" }, want: "generatedAt" },
		{ name: "window 只有 from", patch: { window: { from } }, want: "window" },
		{ name: "calendar 没有 available", patch: { calendar: { total: 3, daily: {} } }, want: "calendar.available" },
		{ name: "calendar.available 不是布尔", patch: { calendar: { available: "yes" } }, want: "calendar.available" },
		{ name: "commits.repos 不是数组", patch: { commits: { total: 1, repos: {}, daily: {} } }, want: "commits.repos" },
		{ name: "warnings 不是数组", patch: { warnings: "没事" }, want: "warnings" },
	];
	for (const c of cases) {
		const res2 = parseHeatmapPayload({ ...makeValidPayload(), ...c.patch });
		check(`${c.name} → ok === false`, res2.ok === false);
		if (!res2.ok) {
			check(`${c.name} → 报错点名 "${c.want}"`, res2.errors.some((e) => e.includes(c.want)), JSON.stringify(res2.errors));
		}
	}
	const res3 = parseHeatmapPayload(null);
	check("null 载荷 ok === false", res3.ok === false);
	check("null 载荷报错非空", !res3.ok && res3.errors.length === 1, JSON.stringify(res3));
}

SECTION("3. kvKey：大小写归一");
{
	check('kvKey("XieEa656") === "heatmap:YOUR_USERNAME"', kvKey("XieEa656") === "heatmap:YOUR_USERNAME", kvKey("XieEa656"));
	check("kvKey 前后端一致（两端都 import 这一份）", kvKey("YOUR_USERNAME") === "heatmap:YOUR_USERNAME");
	// kvKey 是"加前缀"而不是"幂等归一"：已带前缀的 key 会被再加一次前缀。
	// 这不影响两端一致（两端都只喂裸 owner），但调用方不能拿它当幂等函数用。
	check("kvKey 非幂等（重复调用会叠加前缀，已知行为）", kvKey(kvKey("YOUR_USERNAME")) === "heatmap:heatmap:YOUR_USERNAME", kvKey(kvKey("YOUR_USERNAME")));
}

SECTION("4. eachDay：371 天窗口");
{
	const days = eachDay(from, to);
	check(`返回 ${days.length} 个 key（期望 371）`, days.length === 371, `实际 ${days.length}`);
	check("首日 === 窗口起点", days[0] === from, days[0]);
	check("末日 === 窗口终点", days[days.length - 1] === to, days[days.length - 1]);
	check("都是 YYYY-MM-DD 且合法 UTC 日期", days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`))));
	check("按升序、无重复", new Set(days).size === 371 && days.every((d, i) => i === 0 || d > days[i - 1]));
	check("端点相邻（首尾相隔 370 天）", (Date.parse(`${days.at(-1)}T00:00:00Z`) - Date.parse(`${days[0]}T00:00:00Z`)) / DAY === 370);
	check("单日窗口返回 1 个", eachDay(to, to).length === 1);
	check("空窗口（from > to）返回 0 个", eachDay(to, from).length === 0);
}

SECTION("5. 分级函数：全零 / 单点非零 / 极端分布");
{
	const dayList = eachDay(from, to);
	const allZero = Object.fromEntries(dayList.map((d) => [d, 0]));
	const t0 = computeLevelThresholds(allZero);
	// 注意：全零分支返回的是 4 个阈值 [1,2,3,4]，非空分支返回 3 个。
	// levelFor 只读 thresholds[0..2]，所以多出来的第 4 个被忽略——不影响正确性，
	// 但两种分支的返回形状不一致，已记进报告。
	check("全零不崩且至少返回 3 个阈值", Array.isArray(t0) && t0.length >= 3, JSON.stringify(t0));
	check("全零时阈值严格递增", t0.slice(0, 3).every((v, i, a) => i === 0 || v > a[i - 1]), JSON.stringify(t0));
	check("全零时最小编号是 1（≥1）", t0[0] >= 1, JSON.stringify(t0));
	check("全零时 levelFor 恒为 0", dayList.every((d) => levelFor(allZero[d], t0) === 0));
	check("levelFor(0) 也是 0", levelFor(0, t0) === 0);
	check("levelFor 负数按 0 处理（不崩）", levelFor(-5, t0) === 0);

	const one = { ...allZero, [to]: 7 };
	const t1 = computeLevelThresholds(one);
	check("单点非零不崩且返回 3 个阈值", Array.isArray(t1) && t1.length === 3, JSON.stringify(t1));
	check("单点非零时阈值严格递增", t1.every((v, i, a) => i === 0 || v > a[i - 1]), JSON.stringify(t1));
	check("单点非零时该天被染成非零级（1-4）", [1, 2, 3, 4].includes(levelFor(7, t1)), `level=${levelFor(7, t1)} 阈值=${JSON.stringify(t1)}`);
	check("单点非零时其余天 level === 0", dayList.filter((d) => d !== to).every((d) => levelFor(0, t1) === 0));
	// 退化分布的已知代价：只有 1 个非零值时，三个分位都等于该值本身，
	// "严格递增"修正会把阈值抬到值之上 → 最大值只能到 level 2，3/4 永远到不了。
	check("单点非零时最大值只能到 level 2（退化分布的已知代价，不崩）", levelFor(7, t1) === 2, JSON.stringify(t1));

	const uniform = Object.fromEntries(dayList.map((d) => [d, 5]));
	const tu = computeLevelThresholds(uniform);
	check("全部同值（四分位退化）后仍严格递增", tu.every((v, i, a) => i === 0 || v > a[i - 1]), JSON.stringify(tu));
	check("退化情形下不崩", typeof levelFor(5, tu) === "number" && levelFor(5, tu) <= 4, JSON.stringify(tu));

	const flat = { "2026-10-01": 1, "2026-10-02": 100 };
	const tf = computeLevelThresholds(flat);
	check("两点分布不崩", Array.isArray(tf) && tf.length === 3, JSON.stringify(tf));
	check("两点分布严格递增", tf.every((v, i, a) => i === 0 || v > a[i - 1]), JSON.stringify(tf));
	check("最小值 level === 1", levelFor(1, tf) === 1, `阈值=${JSON.stringify(tf)}`);
	check("最大值 level === 4", levelFor(100, tf) === 4, `阈值=${JSON.stringify(tf)}`);

	// 真实数据形态（23 个非零天、值有跨度）：level 4 必须可达，否则网格会缺一档
	const spread = {
		...allZero,
		"2026-10-01": 1, "2026-10-02": 1, "2026-10-03": 1, "2026-10-04": 2,
		"2026-10-05": 2, "2026-10-06": 3, "2026-10-07": 4, "2026-10-08": 5,
		"2026-10-09": 8, "2026-10-10": 12,
	};
	const ts = computeLevelThresholds(spread);
	check("有跨度的分布严格递增", ts.every((v, i, a) => i === 0 || v > a[i - 1]), JSON.stringify(ts));
	check("有跨度的分布里最大值能到 level 4", levelFor(12, ts) === 4, `阈值=${JSON.stringify(ts)}`);
	check("levelFor 返回值域始终是 0-4", dayList.every((d) => [0, 1, 2, 3, 4].includes(levelFor(Math.floor(Math.random() * 200), [1, 2, 3]))));
}

SECTION("6. 采集端产物形状 ↔ 合约（用夹具模拟 collect.mjs 的输出）");
{
	const p = makeValidPayload();
	const levels = Object.values(p.calendar.daily);
	check("calendar.daily 的值都是非负整数", levels.every((v) => Number.isInteger(v) && v >= 0));
	check("calendar.total === 各日之和（与 GitHub 口径一致）", p.calendar.total === Object.values(p.calendar.daily).reduce((a, b) => a + b, 0));
	check("commits.daily 每个槽位都有 count 与 repos", Object.values(p.commits.daily).every((s) => typeof s.count === "number" && typeof s.repos === "object" && s.repos !== null));
	check("commits.total === 各日 count 之和", p.commits.total === Object.values(p.commits.daily).reduce((a, s) => a + s.count, 0));
	check("commits.repos 每行都有 name/count/activeDays/href", p.commits.repos.every((r) => typeof r.name === "string" && Number.isInteger(r.count) && Number.isInteger(r.activeDays) && r.href.startsWith("https://")));
	check("window.days === 371", p.window.days === 371);
	assertAnchoredWindow("夹具窗口", p.window);
	check("window 覆盖的每一天都在 daily 里出现过 key", eachDay(p.window.from, p.window.to).every((d) => Object.prototype.hasOwnProperty.call(p.calendar.daily, d)));
}

// ---------- 可选：校验真实产物 ----------
const payloadFlag = process.argv.indexOf("--payload");
const payloadPath = payloadFlag >= 0 ? process.argv[payloadFlag + 1] : undefined;
if (payloadPath) {
	SECTION(`7. 真实产物 ${payloadPath}`);
	const res4 = parseHeatmapPayload(JSON.parse((await readFile(payloadPath, "utf8")).trim()));
	check("parseHeatmapPayload 通过", res4.ok === true, res4.ok ? "" : JSON.stringify(res4.errors));
	if (res4.ok) {
		const p = res4.payload;
		check("schema === 合约版本", p.schema === SCHEMA_VERSION, `实际 ${p.schema}`);
		check("window.days === 371", p.window.days === 371, `实际 ${p.window.days}`);
		check("source 是 kv 或 live", p.source === "kv" || p.source === "live", p.source);
		check("KV key 与 owner 对应", kvKey(p.owner) === `heatmap:${p.owner.toLowerCase()}`, kvKey(p.owner));
		check("窗口端点是合法 UTC 日期", !Number.isNaN(Date.parse(`${p.window.from}T00:00:00Z`)) && !Number.isNaN(Date.parse(`${p.window.to}T00:00:00Z`)));
		check("窗口内 eachDay 恰好 371 天", eachDay(p.window.from, p.window.to).length === 371, `实际 ${eachDay(p.window.from, p.window.to).length}`);
		assertAnchoredWindow("真实产物窗口", p.window);
		check("calendar.daily 没有窗口外的 key", Object.keys(p.calendar.daily).every((k) => !Number.isNaN(Date.parse(`${k}T00:00:00Z`)) && Date.parse(`${k}T00:00:00Z`) >= Date.parse(`${p.window.from}T00:00:00Z`) && Date.parse(`${k}T00:00:00Z`) <= Date.parse(`${p.window.to}T00:00:00Z`)));
		check("calendar 可用时 total === 各日之和", !p.calendar.available || p.calendar.total === Object.values(p.calendar.daily).reduce((a, b) => a + b, 0));
		check("commits.total === 各日 count 之和", p.commits.total === Object.values(p.commits.daily).reduce((a, s) => a + s.count, 0));
		check("warnings 是字符串数组", p.warnings.every((w) => typeof w === "string"));
		const thresholds = computeLevelThresholds(p.calendar.daily);
		check("真实数据的分级阈值严格递增", thresholds.every((v, i, a) => i === 0 || v > a[i - 1]), JSON.stringify(thresholds));
	}
}

SECTION("结果");
console.log(`${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
