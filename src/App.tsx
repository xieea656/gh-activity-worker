import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { GitHubActivity } from './components/github-activity.tsx'
import { fetchHeatmap, fixturePayload } from './lib/api.ts'
import { mapToWidgetProps, type MappedWidget } from './lib/map-to-props.ts'
import { accentFor, getConfig, subscribeTheme, themeVersion } from './lib/theme.ts'

import type { HeatmapPayload } from '../shared/schema2.ts'

/**
 * 展示层外壳：拉 /api/heatmap → 映射成组件 props → 渲染。
 *
 * 三种数据形态都不白屏：
 *   1. source:"kv" 正常
 *   2. calendar.available === false → 组件照常渲染空网格，提交栏默认展开，下面补一行小字
 *   3. 整段坏 JSON / 网络失败 → ErrorCard
 *
 * 组件本身一行不改：contributions 与 repos 从 props 传满，它内部
 * `needsFetch = !contributionsProp.length || !reposProp.length` 为 false，
 * 两条外部 fetch 一条都不会执行（唯一能触发它们的 prop 我们没有传）。
 */

const DEFAULT_CELL_SIZE = 11
const DEFAULT_MONTHS = 12
const DEFAULT_LABEL = 'Top contributions in:'

const OWNER_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i

type DisplayConfig = {
	owner: string
	cellSize: number
	months: number
	showMonths: boolean
	label: string
}

type LoadState =
	| { status: 'loading' }
	| { status: 'error'; errors: string[] }
	| { status: 'ready'; payload: HeatmapPayload }

/**
 * 把 label / months / cellSize 这些 prop 通过 URL 参数暴露，方便以后调。
 * 全部做边界收敛，非法值回落默认。
 */
const readDisplay = (search: string): DisplayConfig => {
	const q = new URLSearchParams(search)
	const num = (raw: string | null, fallback: number, min: number, max: number): number => {
		if (raw === null) return fallback
		const n = Number(raw)
		return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
	}
	const ownerRaw = q.get('owner')
	return {
		// 空串 = 不传 owner 参数，Worker 按自己配置里的 HEATMAP_OWNER 走
		owner: ownerRaw !== null && OWNER_RE.test(ownerRaw) ? ownerRaw.toLowerCase() : '',
		cellSize: num(q.get('cellSize'), DEFAULT_CELL_SIZE, 8, 20),
		months: num(q.get('months'), DEFAULT_MONTHS, 1, 12),
		showMonths: q.get('showMonths') !== '0',
		label: (q.get('label') ?? DEFAULT_LABEL).slice(0, 40),
	}
}

export default function App() {
	// 父页 postMessage 改主题时会 bump 版本号，这里跟着重算 accent
	const themeVer = useSyncExternalStore(subscribeTheme, themeVersion)
	const cfg = getConfig()
	const [display] = useState(() => readDisplay(window.location.search))
	const [state, setState] = useState<LoadState>({ status: 'loading' })
	const [attempt, setAttempt] = useState(0)

	useEffect(() => {
		let cancelled = false
		const run = async () => {
			setState({ status: 'loading' })
			if (cfg.fixture) {
				setState({ status: 'ready', payload: fixturePayload() })
				return
			}
			const result = await fetchHeatmap(display.owner)
			if (!cancelled) {
				setState(
					result.ok
						? { status: 'ready', payload: result.payload }
						: { status: 'error', errors: result.errors },
				)
			}
		}
		void run()
		return () => {
			cancelled = true
		}
	}, [attempt, cfg.fixture, display.owner])

	// accent 只由 dark/hue/accent 决定；themeVer 保证 postMessage 改值时重算
	const accent = useMemo(
		() => accentFor(getConfig()),
		[themeVer, cfg.dark, cfg.hue, cfg.accent],
	)

	const mapped = useMemo(
		() => (state.status === 'ready' ? mapToWidgetProps(state.payload) : null),
		[state],
	)

	// 后端给的窗口起点不是周日时，前端会替它补位并丢掉几天。
	// 丢数据这件事不留痕就没法查，所以丢过就打到 console（?debug=1 时还会画在页面上）。
	useEffect(() => {
		if (!mapped) return
		const { meta } = mapped
		const dropped = meta.droppedLeadingDays + meta.droppedTrailingDays
		if (dropped === 0) return
		console.info(
			`[gh-heatmap] 窗口已对齐到周日起列：丢 ${meta.droppedLeadingDays} 天开头 + ` +
				`${meta.droppedTrailingDays} 天结尾，渲染 ${meta.cells}/${meta.windowDays} 格 ` +
				`(${meta.weeks} 周) —— 后端给的窗口起点不是周日`,
		)
	}, [mapped])

	if (state.status === 'loading') return <WidgetSkeleton />

	if (state.status === 'error') {
		return <ErrorCard errors={state.errors} onRetry={() => setAttempt((a) => a + 1)} />
	}

	const { payload } = state
	const widget = mapped!
	const calendarAvailable = widget.meta.available
	// 贡献墙拿不到时给一行说明；文案要看提交数据在不在，别承诺一个空栏
	const note = calendarAvailable
		? null
		: widget.repos.length > 0
			? '贡献数据未启用 —— 只显示仓库提交统计'
			: '贡献数据暂不可用，等下一次采集后再来'

	return (
		<div>
			<GitHubActivity
				// 卡片底色跟随主题：组件写死了 bg-white/dark:bg-black，
				// 内联 style 优先级高于 class，不用改组件就能换。
				style={{ backgroundColor: 'var(--hm-card)' }}
				contributions={widget.contributions}
				repos={widget.repos}
				accent={accent}
				cellSize={display.cellSize}
				months={display.months}
				showMonths={display.showMonths}
				label={display.label}
				// 贡献数据拿不到时，默认展开提交栏，避免只剩一个空网格
				defaultOpen={!calendarAvailable}
			/>

			{note && <p className="hm-note">{note}</p>}

			{/*
				署名：组件来自 Rare UI（MIT + Commons Clause + Attribution），必须放可见链接。
				独立打开（不带 ?embed=1）时自动显示在这里；嵌进博客时由博客自己的页脚承载。
			*/}
			{!cfg.embed && (
				<p className="hm-credit">
					UI by <a href="https://rareui.com" target="_blank" rel="noreferrer">Rare UI</a>
				</p>
			)}

			{cfg.debug && (
				<DebugPanel payload={payload} widget={widget} display={display} />
			)}
		</div>
	)
}

/**
 * 加载中骨架：形状对齐真实卡片，不用 spinner 也不高频闪烁。
 */
function WidgetSkeleton() {
	return (
		<div className="hm-skeleton" role="status" aria-label="加载中">
			<div className="hm-sk-bar" />
			<div className="hm-sk-grid">
				{Array.from({ length: 371 }, (_, i) => (
					<span key={i} />
				))}
			</div>
			<div className="hm-sk-foot">
				<span />
				<span />
			</div>
		</div>
	)
}

/**
 * 整段坏 JSON / 网络失败：克制的错误卡，不白屏、不红色告警。
 */
function ErrorCard({ errors, onRetry }: { errors: string[]; onRetry: () => void }) {
	return (
		<div className="hm-error" role="alert">
			<div className="hm-error-title">暂时取不到活动数据</div>
			<p className="hm-error-text">
				卡片本身的样式都在，只是 /api/heatmap 没给到可用数据。
			</p>
			{errors.length > 0 && <p className="hm-error-detail">{errors.join('\n')}</p>}
			<button type="button" className="hm-error-retry" onClick={onRetry}>
				重试
			</button>
		</div>
	)
}

/**
 * ?debug=1 才显示。数据来自 /api/heatmap 的 warnings 字段与本次映射的中间量。
 */
/**
 * ?debug=1 才显示。数据来自 /api/heatmap 的 warnings 字段与本次映射的中间量。
 *
 * 对齐那行是专门留给验收用的：`droppedLeading > 0` 就代表后端给的窗口起点不是周日，
 * 前端已经替它补过位了 —— 丢了多少天写在这里，不静默。
 */
function DebugPanel({
	payload,
	widget,
	display,
}: {
	payload: HeatmapPayload
	widget: MappedWidget
	display: DisplayConfig
}) {
	const meta = widget.meta
	const first = widget.contributions[0]
	const dropped = meta.droppedLeadingDays + meta.droppedTrailingDays
	const lines = [
		`source=${payload.source}  owner=${payload.owner}  generatedAt=${payload.generatedAt}`,
		`window=${payload.window.from} → ${payload.window.to}  窗口天数=${meta.windowDays}`,
		`对齐: 首格=${first ? first.date : '(空)'}  渲染 ${meta.cells} 格 / ${meta.weeks} 周` +
			(dropped > 0
				? `  ← 丢 ${meta.droppedLeadingDays} 开头 + ${meta.droppedTrailingDays} 结尾`
				: ''),
		`calendar.available=${meta.available}  渲染 total=${meta.total}` +
			(meta.reportedTotal !== meta.total
				? `  （后端 total=${meta.reportedTotal}，差额是被对齐丢掉的天）`
				: '') +
			`  分级阈值=${meta.thresholds.join('/')}`,
		`commits.total=${payload.commits.total}  repos=${payload.commits.repos.length}`,
		`展示: cellSize=${display.cellSize}  months=${display.months}  label="${display.label}"`,
		payload.warnings.length > 0
			? `warnings:\n${payload.warnings.map((w) => `  - ${w}`).join('\n')}`
			: 'warnings: (无)',
	]
	return <pre className="hm-debug">{lines.join('\n')}</pre>
}
