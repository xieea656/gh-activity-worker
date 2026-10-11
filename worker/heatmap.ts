/**
 * `/api/heatmap` 的核心逻辑。
 *
 * 顺序：owner 白名单 → KV 读 + 合约校验 →（失败或为空）1 个 GraphQL 请求兜底 → 全失败给空态。
 * **任何情况都返回 200**：前端不白屏是这个接口的设计目标，500 只会变成博客首页的一片空白。
 *
 * 响应头写死：
 *   Content-Type: application/json; charset=utf-8
 *   Cache-Control: public, max-age=21600, stale-while-revalidate=86400
 *   X-Content-Type-Options: nosniff
 * 刻意**不设置** Access-Control-Allow-Origin：Worker 与展示站同源，跨域放开只会白送一个代理面。
 */
import { SCHEMA_VERSION, kvKey, weekAnchoredWindow, parseHeatmapPayload, type HeatmapPayload } from "../shared/schema2.ts";
import { fetchLiveCalendar } from "./github.ts";

/** 从 ExportedHandler 反推 fetch 的真实入参类型，避免手写 Request<...> 时抄错泛型 */
type FetchArgs = Parameters<NonNullable<ExportedHandler<Env>["fetch"]>>;
type HeatmapRequest = FetchArgs[0];
type HeatmapEnv = FetchArgs[1];

type HeatmapWindow = { from: string; to: string; days: number };

const RESPONSE_HEADERS: Record<string, string> = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "public, max-age=21600, stale-while-revalidate=86400",
	"x-content-type-options": "nosniff",
};

/**
 * 窗口锚点：唯一实现在合约 shared/schema2.ts 的 weekAnchoredWindow()。
 *   to   = 今天所在那一周的周六（可能落在未来 —— 尾部未来日 count=0 是可接受的诚实空值）
 *   from = to - 370 天（必然周日）
 *
 * 必须锚在完整周上：GitHub 贡献日历以周日为列首，展示组件的 toWeeks() 是盲目
 * `i += 7` 切列、toMonthLabels() 取 `weeks[index][0].date` 的月份。窗口起点若不是周日，
 * 整条月份轴与星期轴会整体错位一天。
 *
 * 这里只是薄封装，与 worker/collect.ts 调用同一个合约函数 —— 采集端与 live 兜底
 * 共用一份实现，两条路径的窗口不可能分叉。
 * new Date() 生成的 ISO 日期恒为合法输入，所以此处不会抛；handleHeatmap 也不会因窗口
 * 计算而返回 500。
 */
export function computeWindow(): HeatmapWindow {
	return weekAnchoredWindow(new Date().toISOString().slice(0, 10));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * parseHeatmapPayload 没覆盖到、但前端强依赖的两处：calendar.daily 与 commits.daily 必须是对象。
 * 合约把校验留到这里补，宁可多降级一次，也不把坏结构透传给前端。
 */
function hasDailyMaps(payload: HeatmapPayload): boolean {
	return isPlainObject(payload.calendar.daily) && isPlainObject(payload.commits.daily);
}

function skeleton(owner: string, window: HeatmapWindow, source: HeatmapPayload["source"]): HeatmapPayload {
	return {
		schema: SCHEMA_VERSION,
		generatedAt: new Date().toISOString(),
		owner,
		source,
		window,
		calendar: { available: false, total: 0, daily: {} },
		commits: { total: 0, repos: [], daily: {} },
		warnings: [],
	};
}

/** 空态占位：结构合法、内容全空，前端据此渲染空态 */
export function emptyPayload(owner: string, window: HeatmapWindow, reason: string): HeatmapPayload {
	const payload = skeleton(owner, window, "kv");
	payload.warnings = [reason];
	return payload;
}

/** 统一出口：状态码 200 + 上面那三个响应头 */
export function respond(payload: HeatmapPayload): Response {
	return new Response(JSON.stringify(payload), { status: 200, headers: RESPONSE_HEADERS });
}

export async function handleHeatmap(request: HeatmapRequest, env: HeatmapEnv): Promise<Response> {
	const window = computeWindow();
	const allowed = (env.HEATMAP_OWNER ?? "").trim().toLowerCase();
	const param = (new URL(request.url).searchParams.get("owner") ?? "").trim();

	// ---- owner 白名单 ----
	// 未配置 HEATMAP_OWNER 时无法确定服务对象，直接给空态
	if (!allowed) return respond(emptyPayload("unknown", window, "Worker 未配置 HEATMAP_OWNER，无法确定服务哪个 owner"));
	// 不带 owner 参数时按配置的默认值处理（单用户部署，展示站自己写死了 owner）
	const owner = (param || allowed).toLowerCase();
	if (owner !== allowed) {
		// 白名单外：不读 KV、不发任何请求，只回一个不可用占位。
		// 占位里的 owner 用配置值而不是回显请求值，避免响应里出现未校验的输入
		return respond(emptyPayload(allowed, window, "请求的 owner 不在白名单内，返回不可用占位（不含任何真实数据）"));
	}

	// ---- 1) KV ----
	let cached: HeatmapPayload | undefined;
	try {
		const raw = await env.HEATMAP_KV.get(kvKey(owner));
		if (raw) {
			const checked = parseHeatmapPayload(JSON.parse(raw));
			if (checked.ok) {
				// owner 必须与 key 对应，防止 KV 里被塞进别人的数据
				if (checked.payload.owner.toLowerCase() === owner && hasDailyMaps(checked.payload)) {
					cached = checked.payload;
				} else {
					console.warn(`KV 数据与 ${kvKey(owner)} 不匹配或结构缺 daily，改用实时兜底`);
				}
			} else {
				console.warn(`KV 数据未通过合约校验：${checked.errors.join("；")}`);
			}
		} else {
			console.log(`KV 为空：${kvKey(owner)}，改用实时兜底`);
		}
	} catch (error) {
		console.warn(`读 KV 失败：${error instanceof Error ? error.message : String(error)}`);
	}

	if (cached) {
		// 强制 source，避免 KV 里手工写入过别的值
		return respond({ ...cached, source: "kv" });
	}

	// ---- 2) 实时兜底（恰好 1 个 GraphQL 请求；失败也不抛）----
	const live = await fetchLiveCalendar(owner, env, window);
	const payload = skeleton(owner, window, "live");
	payload.calendar = { available: live.available, total: live.total, daily: live.daily };
	payload.warnings = [
		...live.warnings,
		"仓库提交数据不可用：实时兜底只拉贡献墙，完整数据要等下一次定时采集写入 KV",
	];
	return respond(payload);
}
