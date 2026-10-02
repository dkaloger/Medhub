import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Path, Rect, Text as SvgText } from 'react-native-svg';
import type { SampleSeries } from '../core/series';
import { colors, mono } from './theme';
import {
  autoRange,
  centre,
  columnsPath,
  decimate,
  formatTime,
  formatValue,
  gridPath,
  niceTicks,
  samplesPath,
  type Frame,
  type Units,
} from './traceGeometry';

export interface PaperSettings {
  /** mm per second */
  speed: number;
  /** mm per mV */
  gain: number;
}

interface Props {
  series: SampleSeries;
  fs: number;
  /** Follow the newest sample, redrawing continuously. */
  live: boolean;
  /** Right edge (sample index) when not live. */
  endIndex: number;
  windowSeconds: number;
  height: number;
  color: string;
  units: Units;
  /** Virtual ECG paper: fixed mm/s and mm/mV scaling on a 1 mm / 5 mm grid. */
  paper?: PaperSettings | null;
  emptyText?: string;
  /** Called while dragging a paused or recorded trace. */
  onPan?: (deltaSeconds: number) => void;
}

const MARGIN = { left: 70, right: 10, top: 8, bottom: 22 };
const FRAME_MS = 33;
const RESCALE_MS = 500;

const positiveMod = (a: number, m: number) => ((a % m) + m) % m;

/** Pixel squares stay square: 1 virtual mm is the same number of pixels on both axes. */
function paperScale(width: number, windowSeconds: number, paper: PaperSettings) {
  const pxPerMm = width / (windowSeconds * paper.speed);
  return { pxPerMm, mvPerPx: 1 / (paper.gain * pxPerMm) };
}

export function TraceView(props: Props) {
  const { series, fs, live, endIndex, windowSeconds, height, color, units, paper, emptyText, onPan } = props;
  const [width, setWidth] = useState(0);
  const [, setFrame] = useState(0);
  const range = useRef<{ at: number; key: string; yMin: number; yMax: number } | null>(null);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setFrame((n) => n + 1), FRAME_MS);
    return () => clearInterval(timer);
  }, [live]);

  const panHandlers = useMemo(() => {
    let lastDx = 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => !!onPan,
      onMoveShouldSetPanResponder: (_e, g) => !!onPan && Math.abs(g.dx) > 3,
      onPanResponderGrant: () => {
        lastDx = 0;
      },
      onPanResponderMove: (_e, g) => {
        const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
        onPan?.(-((g.dx - lastDx) / plotWidth) * windowSeconds);
        lastDx = g.dx;
      },
    }).panHandlers;
  }, [onPan, width, windowSeconds]);

  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.floor(e.nativeEvent.layout.width));

  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const count = Math.round(windowSeconds * fs);
  const end = live ? series.end : endIndex;
  const start = end - count;
  const columns = Math.max(1, Math.floor(plotW));
  const cols = width > 0 ? decimate(series, start, count, columns, units) : null;
  const hasData = !!cols && cols.min.some(Number.isFinite);

  // Y scaling is re-evaluated at most twice a second while live so the trace doesn't jitter.
  const now = Date.now();
  const scaleKey = `${units}|${paper ? `${paper.speed}/${paper.gain}` : 'auto'}|${windowSeconds}|${width}|${height}`;
  const stale = !range.current || range.current.key !== scaleKey || !live || now - range.current.at > RESCALE_MS;
  if (cols && hasData && stale) {
    if (paper) {
      const { mvPerPx } = paperScale(plotW, windowSeconds, paper);
      const mid = centre(cols) ?? 0;
      range.current = { at: now, key: scaleKey, yMin: mid - (plotH / 2) * mvPerPx, yMax: mid + (plotH / 2) * mvPerPx };
    } else {
      const r = autoRange(cols);
      if (r) range.current = { at: now, key: scaleKey, yMin: r[0], yMax: r[1] };
    }
  }

  const frame: Frame | null =
    range.current && width > 0
      ? { x: MARGIN.left, y: MARGIN.top, width: plotW, height: plotH, yMin: range.current.yMin, yMax: range.current.yMax }
      : null;

  const trace =
    frame && cols && hasData
      ? cols.samplesPerColumn > 1.5
        ? columnsPath(cols, frame)
        : samplesPath(series, start, count, frame, units)
      : '';

  const secondsStart = start / fs;
  const secondsEnd = end / fs;
  const xOf = (s: number) => MARGIN.left + ((s - secondsStart) / windowSeconds) * plotW;
  const yOf = (v: number) => (frame ? frame.y + frame.height * (1 - (v - frame.yMin) / (frame.yMax - frame.yMin)) : 0);

  let gridMinor = '';
  let gridMajor = '';
  let xTicks: number[] = [];
  let yTicks: number[] = [];
  if (frame && paper) {
    // Grid lines sit on whole millimetres of the virtual paper: t·speed and v·gain.
    const { pxPerMm } = paperScale(plotW, windowSeconds, paper);
    const leftMm = secondsStart * paper.speed;
    const topMm = frame.yMax * paper.gain;
    const offset = (mm: number, step: number) => positiveMod(mm, step) * pxPerMm;
    gridMinor = gridPath(frame, pxPerMm, pxPerMm, offset(-leftMm, 1), offset(topMm, 1));
    gridMajor = gridPath(frame, 5 * pxPerMm, 5 * pxPerMm, offset(-leftMm, 5), offset(topMm, 5));
    xTicks = niceTicks(secondsStart, secondsEnd, Math.max(2, Math.round(windowSeconds)));
    yTicks = niceTicks(frame.yMin, frame.yMax, 4);
  } else if (frame) {
    xTicks = niceTicks(secondsStart, secondsEnd, Math.max(2, Math.floor(plotW / 110)));
    yTicks = niceTicks(frame.yMin, frame.yMax, Math.max(2, Math.floor(plotH / 45)));
    gridMajor =
      xTicks.map((t) => `M${xOf(t).toFixed(1)} ${frame.y}V${frame.y + frame.height}`).join('') +
      yTicks.map((v) => `M${frame.x} ${yOf(v).toFixed(1)}H${frame.x + frame.width}`).join('');
  }

  const bg = paper ? colors.paperBg : colors.panel;
  const label = paper ? colors.paperText : colors.faint;

  return (
    <View style={{ height }} onLayout={onLayout} {...panHandlers}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          <Rect x={MARGIN.left} y={MARGIN.top} width={plotW} height={plotH} fill={bg} />
          {gridMinor ? <Path d={gridMinor} stroke={colors.paperMinor} strokeWidth={0.5} /> : null}
          {gridMajor ? (
            <Path d={gridMajor} stroke={paper ? colors.paperMajor : colors.gridMajor} strokeWidth={paper ? 0.9 : 1} />
          ) : null}
          {trace ? (
            <Path
              d={trace}
              stroke={paper ? colors.paperTrace : color}
              strokeWidth={paper ? 1.2 : 1.4}
              fill="none"
              strokeLinejoin="round"
            />
          ) : null}
          {xTicks.map((t) => (
            <SvgText key={`x${t}`} x={xOf(t)} y={height - 6} fill={label} fontSize={10} fontFamily={mono} textAnchor="middle">
              {formatTime(t, windowSeconds)}
            </SvgText>
          ))}
          {yTicks.map((v) => (
            <SvgText key={`y${v}`} x={MARGIN.left - 6} y={yOf(v) + 3} fill={label} fontSize={10} fontFamily={mono} textAnchor="end">
              {formatValue(v, units, yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1)}
            </SvgText>
          ))}
        </Svg>
      ) : null}
      {width > 0 && !hasData ? (
        <View style={[StyleSheet.absoluteFill, styles.empty]} pointerEvents="none">
          <Text style={styles.emptyText}>{emptyText ?? 'No data'}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', justifyContent: 'center', paddingLeft: MARGIN.left },
  emptyText: { color: colors.muted, fontSize: 13 },
});
