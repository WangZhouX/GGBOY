import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VaultHistorySnapshot } from '../../features/vault/api/listVaultSnapshots';
import type { VaultListItem } from '../../features/vault/api/listVaults';
import { calculateVaultNavPerShareRaw, formatVaultAmount } from '../../features/vault/vaultAmounts';
import './styles/vault-nav-chart.css';

/** 有效观测的详情数据。 Data displayed for a valid observation. */
interface PlotPoint {
  /** 快照的观测 slot，使用十进制整数字符串。 Snapshot observation slot as a decimal integer string. */
  slot: string;
  /** 保留后端 ISO UTC 文本和其中的小数秒。 Original API ISO UTC text including fractional seconds. */
  observedAt: string;
  /** 按图表标签小数位数缩放后的每份净值。 NAV per share in the chart's label scale. */
  raw: bigint;
}

/** 为落在同一绘图位置的观测提供一个可点选标记。 One selectable marker for observations sharing a plot coordinate. */
interface PlotMarker {
  /** 横坐标为图宽的百分比。 Horizontal position as a percentage of plot width. */
  x: number;
  /** 纵坐标为图高的百分比。 Vertical position as a percentage of plot height. */
  y: number;
  /** 此位置的观测，按时间和数值 slot 正序。 Observations at this position in ascending time and numeric slot order. */
  points: PlotPoint[];
}

/** 横轴端点的可计算时间和精确原始时间。 Computable time and exact source time for an axis endpoint. */
interface TimeTick {
  /** Unix 时间，单位为纳秒。 Unix time in nanoseconds. */
  time: bigint;
  /** ISO UTC 文本，用于显示秒以下的差异。 ISO UTC text for displaying subsecond differences. */
  observedAt: string;
}

/** 图表所需的路径、时间轴和刻度。 Chart path, time domain, and axis ticks. */
interface ChartModel {
  /** 按首条观测顺序排列的独立标记。 Selectable markers ordered by their first observation. */
  markers: PlotMarker[];
  /** 最后一条可估值观测所在的标记。 Marker containing the last valued observation. */
  latestMarker: PlotMarker;
  /** SVG 路径，缺少估值时用新的 M 命令重新起线。 SVG path with a new M after missing valuations. */
  path: string;
  /** 横轴首尾时间，同一时刻只有一个端点。 Time axis endpoints, with one tick for a single instant. */
  timeTicks: TimeTick[];
  /** 从顶部到底部的纵轴刻度值和位置。 Vertical axis values and positions from top to bottom. */
  valueTicks: { raw: bigint; y: number }[];
  /** 纵轴和点详情共用的定点小数位数。 Fixed-point decimal places shared by tick labels and point details. */
  labelDecimals: number;
}

/** 历史快照及从金库目录读取的 Mint 精度。 Historical snapshots with mint metadata from the vault registry. */
interface VaultNavChartProps {
  /** 已加载的历史快照，接口按 slot 倒序返回。 Loaded history snapshots, returned by the API in descending slot order. */
  snapshots: VaultHistorySnapshot[];
  /** 当前金库目录条目，提供计价和份额 Mint 的精度及简称。 Selected vault with quote and share mint precisions and tickers. */
  vault: VaultListItem;
}

/** 与金库概况一致的每份净值常规展示精度。 Standard NAV per share display precision shared with the overview. */
const displayDecimals = 6;
/** Unix 时间的毫秒和纳秒之间的比例。 Scale between Unix milliseconds and nanoseconds. */
const nanosPerMillisecond = 1_000_000n;

/** 相差不到一分钟时，时间轴会显示秒。 Show seconds when endpoints span less than one minute. */
const minuteInNanos = 60_000n * nanosPerMillisecond;

/**
 * 解析后端 UTC 时间并保留毫秒以下精度，让同毫秒的观测仍可排序。
 * Parse a backend UTC timestamp while preserving submillisecond ordering.
 * @param isoTime 后端返回的 ISO 8601 UTC 观测时间。 ISO 8601 UTC observation timestamp from the API.
 */
function parseObservationTime(isoTime: string): bigint | null {
  /** 浏览器日期解析提供完整毫秒，余下的小数位从原文读取。 Date parsing gives complete milliseconds; read remaining digits from the input. */
  const milliseconds = Date.parse(isoTime);
  if (!Number.isFinite(milliseconds)) return null;
  /** 第一至第三小数位已计入毫秒，第四至第九位补足纳秒。 Milliseconds already cover the first three fractional digits; add digits four through nine. */
  const fraction = /\.(\d{4,9})Z$/.exec(isoTime)?.[1];
  const nanos = fraction ? BigInt(fraction.padEnd(9, '0').slice(3)) : 0n;
  return BigInt(milliseconds) * nanosPerMillisecond + nanos;
}

/**
 * 保持整数精度直到生成绘图百分比；单点或平线置中。
 * Keep exact arithmetic until converting to a plot percentage; center a single time or a flat range.
 * @param offset 相对当前轴起点的距离。 Distance from the axis start.
 * @param range 同单位的坐标轴范围。 Axis span in the same units.
 */
function toPercentage(offset: bigint, range: bigint): number {
  return range === 0n ? 50 : Number(offset * 1_000_000n / range) / 10_000;
}

/**
 * 为时间轴生成紧凑的 UTC 标签，秒内发生冲突时保留原始小数秒。
 * Format compact UTC axis labels, retaining source fractional seconds when second-level labels collide.
 * @param ticks 最早和最晚的观测时间，或仅一个时间。 Earliest and latest observation times, or a single time.
 * @param locale 用户选择的界面语言。 Selected UI language.
 */
function formatTimeTicks(ticks: TimeTick[], locale: string): string[] {
  /** Intl 处理普通日期刻度，完整 ISO 时间另外保留在快照详情。 Intl formats ordinary date ticks while point details retain full ISO time. */
  const dates = ticks.map(({ time }) => new Date(Number(time / nanosPerMillisecond)));
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    second: ticks.length === 1 || ticks[1].time - ticks[0].time < minuteInNanos ? '2-digit' : undefined,
    year: dates[0].getUTCFullYear() === dates[dates.length - 1].getUTCFullYear() ? undefined : 'numeric',
  });
  const labels = dates.map((date) => formatter.format(date));
  if (labels.length === 2 && labels[0] === labels[1]) {
    // 同一秒里的两个端点需要源字符串精度，浏览器 Date 最多保留毫秒。
    // Endpoints within a second need source precision because browser Date retains only milliseconds.
    return ticks.map(({ observedAt }) => observedAt.split('T')[1]?.replace(/Z$/, '') ?? observedAt);
  }
  return labels;
}

/**
 * 选择能区分相邻净值的小数位数，同时保留小额正值和零值的区别。
 * Choose enough decimal places to distinguish neighboring valuations and preserve small positives versus zero.
 * @param values 已按升序排列的定点净值。 Fixed-point valuations sorted in ascending order.
 * @param valueDecimals 净值定点整数的小数位数。 Decimal places of the fixed-point valuations.
 */
function chooseLabelDecimals(values: bigint[], valueDecimals: number): number {
  /** 最小的非零净值或相邻价差，决定需要多少小数位。 Smallest nonzero valuation or adjacent difference that sets the required scale. */
  let smallest = values.find((value) => value > 0n) ?? 0n;
  for (let index = 1; index < values.length; index++) {
    /** 比较相邻不同值，重复值无需额外的小数位。 Compare neighbors; duplicate valuations require no extra decimal places. */
    const difference = values[index] - values[index - 1];
    if (difference > 0n && difference < smallest) smallest = difference;
  }

  // 多留一位用于区分纵轴中间刻度与上下界；格式化时会省略末尾的零。
  // Keep one extra digit for middle ticks; formatting removes trailing zeros.
  return Math.min(valueDecimals, Math.max(displayDecimals, valueDecimals - smallest.toString().length + 2));
}

/**
 * 按观测时间生成趋势路径，并从实际数据决定两轴范围。
 * Build a chronological trend path and derive both axes from the loaded data.
 * @param snapshots 当前已加载的历史页合并结果。 Merged snapshots from the loaded history pages.
 * @param vault 提供计价和份额 Mint 精度。 Vault containing the quote and share mint precisions.
 */
function buildChartModel(snapshots: VaultHistorySnapshot[], vault: VaultListItem): ChartModel | null {
  /** 最大份额整数位数，用于保留两个快照分母相乘后的最小可能价格差。 Largest share integer length, enough to preserve differences over the product of two snapshot denominators. */
  const shareDigits = snapshots.reduce((max, { totalSharesRaw }) => Math.max(max, totalSharesRaw.length), 1);
  /** 统一的每份净值定点精度，转换为像素位置前保留价格差。 Common NAV per share precision that preserves price differences until pixel projection. */
  const valueDecimals = Math.max(displayDecimals, 2 * shareDigits + vault.quoteAsset.decimals - vault.shareAsset.decimals);

  /** 按观测时间与数值 slot 排序的快照，保留缺失估值的间隔。 Observations ordered by time and numeric slot, retaining missing valuation gaps. */
  const observations = snapshots.flatMap((snapshot) => {
    /** 观测 Unix 时间（纳秒）。 Unix observation time in nanoseconds. */
    const time = parseObservationTime(snapshot.observedAt);
    if (time === null) return [];
    /** 估值为空或流通份额为零时无法计算每份净值；NAV 为零仍是有效观测。 Missing NAV or zero shares have no per-share value, while NAV of zero is valid. */
    const value = snapshot.navRaw === null || BigInt(snapshot.totalSharesRaw) === 0n
      ? null
      : calculateVaultNavPerShareRaw(snapshot.navRaw, snapshot.totalSharesRaw, vault.quoteAsset.decimals, vault.shareAsset.decimals, valueDecimals);
    return [{ snapshot, time, value }];
  }).sort((left, right) => {
    if (left.time !== right.time) return left.time < right.time ? -1 : 1;
    /** 同一观测时刻用数值 slot 决定次序。 Use numeric slot to break ties at equal observation times. */
    const slotDifference = BigInt(left.snapshot.slot) - BigInt(right.snapshot.slot);
    return slotDifference < 0n ? -1 : slotDifference > 0n ? 1 : 0;
  });

  /** 只用有效估值，并按数值排序以确定范围和标签精度。 Sort valid values to determine the vertical range and label scale. */
  const values = observations.flatMap(({ value }) => value === null ? [] : [value])
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (!values.length) return null;

  /** 有效值的上下界和范围，单位为统一定点最小单位。 Valuation bounds and span in the common fixed-point base units. */
  const highest = values[values.length - 1];
  const lowest = values[0];
  const valueSpan = highest - lowest;
  /** 刻度和详情使用同一可读精度，绘制坐标继续使用完整定点值。 Share label precision while computing coordinates at full fixed-point scale. */
  const labelDecimals = chooseLabelDecimals(values, valueDecimals);
  const labelDivisor = 10n ** BigInt(valueDecimals - labelDecimals);
  /** 时间轴覆盖全部观测，包含首尾的缺失估值。 Time domain covers all observations, including missing values at either end. */
  const first = observations[0];
  const last = observations[observations.length - 1];
  const timeSpan = last.time - first.time;

  /** 路径保留每次观测的坐标，重合坐标只放一个按钮。 Keep every observation in the path while sharing a button at identical coordinates. */
  const markers = new Map<string, PlotMarker>();
  let latestMarker: PlotMarker | undefined;
  const commands: string[] = [];
  let startsSegment = true;
  for (const { snapshot, time, value } of observations) {
    if (value === null || snapshot.navRaw === null) {
      // 断开连续线段，避免暗示缺失观测时仍有价格。
      // Break the line so missing observations do not imply an observed price.
      startsSegment = true;
      continue;
    }
    /** 图表横轴按真实时间间距分配，纵轴的高值在顶部。 Space x by true time intervals and place higher valuations toward the top. */
    const x = toPercentage(time - first.time, timeSpan);
    const y = toPercentage(highest - value, valueSpan);
    /** 在同一坐标的按钮下保留独立记录，显示时可逐条切换。 Preserve each observation under the shared marker for individual inspection. */
    const coordinate = `${x},${y}`;
    const marker = markers.get(coordinate) ?? { x, y, points: [] };
    marker.points.push({ slot: snapshot.slot, observedAt: snapshot.observedAt, raw: value / labelDivisor });
    markers.set(coordinate, marker);
    latestMarker = marker;
    commands.push(`${startsSegment ? 'M' : 'L'}${x},${y}`);
    startsSegment = false;
  }

  if (!latestMarker) return null;

  /** 平线只画一个纵轴刻度，其他范围按可表示的跨度画上下界和中点。 Use a single tick for a flat series and bounds plus a midpoint when the span allows it. */
  const tickValues = valueSpan > 1n ? [highest, lowest + valueSpan / 2n, lowest] : valueSpan === 1n ? [highest, lowest] : [highest];

  return {
    markers: [...markers.values()],
    latestMarker,
    path: commands.join(' '),
    timeTicks: (timeSpan === 0n ? [first] : [first, last]).map(({ time, snapshot }) => ({ time, observedAt: snapshot.observedAt })),
    valueTicks: tickValues.map((value) => ({ raw: value / labelDivisor, y: toPercentage(highest - value, valueSpan) })),
    labelDecimals,
  };
}

/**
 * 绘制每份净值历史，鼠标、键盘或触屏均可检查观测时间和数值。
 * Plot historical NAV per share with inspection by mouse, keyboard, or touch.
 * @param props 已加载的快照与选定金库的 Mint 信息。 Loaded snapshots and mint metadata for the selected vault.
 */
export function VaultNavChart({ snapshots, vault }: VaultNavChartProps) {
  /** 当前语言和翻译。 Current language and translations. */
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  /** 快照或金库变更时重新计算走势图。 Recompute the chart when its snapshots or vault change. */
  const chart = useMemo(() => buildChartModel(snapshots, vault), [snapshots, vault]);
  /** 用户最近查看的观测 slot；默认选中最后的有效观测。 Most recently inspected slot, defaulting to the latest valid observation. */
  const [inspectedSlot, setInspectedSlot] = useState<string | null>(null);
  if (!chart) return <p className="vault-nav-chart__empty" role="status">{t('vaultHistory.noValuation')}</p>;

  /** 横轴优先显示简短 UTC 时间，必要时保留小数秒。 Display compact UTC labels with fractional seconds when needed. */
  const timeLabels = formatTimeTicks(chart.timeTicks, locale);
  /** 纵轴和观测详情使用相同的小数位数。 Decimal places shared by the vertical axis and observation details. */
  const { labelDecimals } = chart;
  /** 选中的记录仍存在时继续查看它，否则回到最新的有效观测。 Keep an existing selection; otherwise fall back to the latest valued observation. */
  const inspectedMarker = chart.markers.find(({ points }) => points.some(({ slot }) => slot === inspectedSlot)) ?? chart.latestMarker;
  const selectedIndex = inspectedMarker.points.findIndex(({ slot }) => slot === inspectedSlot);
  const inspectedIndex = selectedIndex < 0 ? inspectedMarker.points.length - 1 : selectedIndex;
  const inspected = inspectedMarker.points[inspectedIndex];

  /**
   * 用与纵轴相同的精度显示净值，并提供完整观测时间和 slot。
   * Show NAV at the vertical axis precision, with the complete observation time and slot.
   * @param point 图标下的一条观测记录。 An observation represented by a chart marker.
   */
  function describePoint(point: PlotPoint): string[] {
    /** 使用图表的标签精度格式化每份净值。 Format NAV per share at the chart's label precision. */
    const value = formatVaultAmount(point.raw.toString(), labelDecimals, locale);
    return [
      t('vaultHistory.pointValue', { value }),
      t('vaultHistory.pointTime', { time: point.observedAt }),
      t('vaultHistory.pointSlot', { slot: point.slot }),
    ];
  }

  /**
   * 在同一绘图位置循环查看前一条或后一条观测，保留当前按钮焦点。
   * Cycle to the previous or next observation at this coordinate while keeping button focus.
   * @param direction 值为 -1 时查看前一条，为 1 时查看后一条。 Use -1 for the previous observation and 1 for the next.
   */
  function stepObservation(direction: -1 | 1) {
    /** 对组内长度取余，使第一条和最后一条可以互相切换。 Wrap between the first and last observations within the group. */
    const count = inspectedMarker.points.length;
    const index = (inspectedIndex + direction + count) % count;
    setInspectedSlot(inspectedMarker.points[index].slot);
  }

  return (
    <figure className="vault-nav-chart">
      <figcaption className="vault-nav-chart__unit">
        {t('vaultHistory.chartUnit', {
          quote: vault.quoteAsset.symbol ?? t('vaultHistory.unknownQuoteUnit'),
          share: vault.shareAsset.symbol ?? t('vaultHistory.unknownShareUnit'),
        })}
      </figcaption>
      <div className="vault-nav-chart__grid">
        <div className="vault-nav-chart__y-axis" aria-hidden="true">
          {chart.valueTicks.map(({ raw, y }) => {
            /** 纵轴标签在剩余宽度不足时仍可通过标题查看完整值。 Retain full tick values via titles if labels must truncate. */
            const label = formatVaultAmount(raw.toString(), labelDecimals, locale);
            return <span className="vault-nav-chart__y-label" key={y} style={{ top: `${y}%` }} title={label}>{label}</span>;
          })}
        </div>
        <div className="vault-nav-chart__plot" role="group" aria-label={t('vaultHistory.chartLabel')}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {chart.valueTicks.map(({ y }) => <line className="vault-nav-chart__guide" key={y} x1="0" x2="100" y1={y} y2={y} />)}
            <path className="vault-nav-chart__series" d={chart.path} />
          </svg>
          {chart.markers.map((marker) => {
            /** 标记初次选中时显示这一位置最新的观测，已选中的组保留当前记录。 Inspect the newest observation on first selection and preserve the active record afterward. */
            const selected = marker === inspectedMarker;
            const newest = marker.points[marker.points.length - 1];
            const labels = describePoint(selected ? inspected : newest);
            if (marker.points.length > 1) labels.push(t('vaultHistory.overlappingPoints', { count: marker.points.length }));
            const label = labels.join(' · ');

            /** 聚焦或点击时选中这个位置，组内切换由详情按钮处理。 Select this marker on focus or click and leave group navigation to the detail controls. */
            function inspect() {
              if (!selected) setInspectedSlot(newest.slot);
            }

            return (
              <button
                className="vault-nav-chart__point"
                key={marker.points[0].slot}
                type="button"
                style={{ left: `${marker.x}%`, top: `${marker.y}%` }}
                aria-label={label}
                aria-pressed={selected}
                data-overlap={marker.points.length > 1}
                title={label}
                onFocus={inspect}
                onPointerEnter={marker.points.length === 1 && inspectedMarker.points.length === 1 ? inspect : undefined}
                onClick={inspect}
              />
            );
          })}
        </div>
        <div className="vault-nav-chart__x-axis" aria-hidden="true">
          <div className="vault-nav-chart__x-labels">
            {timeLabels.map((label, index) => <span className="vault-nav-chart__x-label" key={index}>{label}</span>)}
          </div>
          <p className="vault-nav-chart__time-axis">{t('vaultHistory.timeAxis')}</p>
        </div>
      </div>
      <div className="vault-nav-chart__detail" aria-live="polite">
        {describePoint(inspected).map((detail) => <span key={detail}>{detail}</span>)}
      </div>
      {inspectedMarker.points.length > 1 && (
        <div className="vault-nav-chart__observation-nav" role="group" aria-label={t('vaultHistory.overlapNavigation')}>
          <button type="button" onClick={() => stepObservation(-1)}>{t('vaultHistory.previousObservation')}</button>
          <span aria-live="polite">
            {t('vaultHistory.observationIndex', { current: inspectedIndex + 1, total: inspectedMarker.points.length })}
          </span>
          <button type="button" onClick={() => stepObservation(1)}>{t('vaultHistory.nextObservation')}</button>
        </div>
      )}
    </figure>
  );
}
