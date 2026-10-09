import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { ClipPath, Defs, Path, Rect, Text as SvgText } from 'react-native-svg';
import { isClipped } from '../core/device';
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
  /** Redraw interval while live; slow signals don't need a high frame rate. */
  frameMs?: number;
  /** Called while dragging a paused or recorded trace. */
  onPan?: (deltaSeconds: number) => void;
}

const MARGIN = { left: 70, right: 10, top: 8, bottom: 22 };
const FRAME_MS = 50;
const RESCALE_MS = 500;

const positiveMod = (a: number, m: number) => ((a % m) + m) % m;

/** Pixel squares stay square: 1 virtual mm is the same number of pixels on both axes. */
function paperScale(width: number, windowSeconds: number, paper: PaperSettings) {
  const pxPerMm = width / (windowSeconds * paper.speed);
  return { pxPerMm, mvPerPx: 1 / (paper.gain * pxPerMm) };
}

interface AxesProps {
  width: number;
  height: number;
  yMin: number;
  yMax: number;
  /** Time at the left edge, in seconds; live views use negative "seconds before now". */
  xStart: number;
  windowSeconds: number;
  units: Units;
  paperSpeed: number;
  paperGain: number;
}

/**
 * Background, grid and labels. Memoised on plain numbers so a live trace only redraws its
 * line each frame; the axes change only when the scale or size does.
 */
const Axes = React.memo(function Axes({ width, height, yMin, yMax, xStart, windowSeconds, units, paperSpeed, paperGain }: AxesProps) {
  const frame: Frame = {
    x: MARGIN.left,
    y: MARGIN.top,
    width: width - MARGIN.left - MARGIN.right,
    height: height - MARGIN.top - MARGIN.bottom,
    yMin,
    yMax,
  };
  const paper = paperSpeed > 0;
  const xOf = (s: number) => frame.x + ((s - xStart) / windowSeconds) * frame.width;
  const yOf = (v: number) => frame.y + frame.height * (1 - (v - yMin) / (yMax - yMin));

  let gridMinor = '';
  let gridMajor: string;
  let xTicks: number[];
  let yTicks: number[];
  if (paper) {
    // Grid lines sit on whole millimetres of the virtual paper: t·speed and v·gain.
    const pxPerMm = frame.width / (windowSeconds * paperSpeed);
    const offset = (mm: number, step: number) => positiveMod(mm, step) * pxPerMm;
    const leftMm = xStart * paperSpeed;
    const topMm = yMax * paperGain;
    gridMinor = gridPath(frame, pxPerMm, pxPerMm, offset(-leftMm, 1), offset(topMm, 1));
    gridMajor = gridPath(frame, 5 * pxPerMm, 5 * pxPerMm, offset(-leftMm, 5), offset(topMm, 5));
    xTicks = niceTicks(xStart, xStart + windowSeconds, Math.max(2, Math.round(windowSeconds)));
    yTicks = niceTicks(yMin, yMax, 4);
  } else {
    xTicks = niceTicks(xStart, xStart + windowSeconds, Math.max(2, Math.floor(frame.width / 110)));
    yTicks = niceTicks(yMin, yMax, Math.max(2, Math.floor(frame.height / 45)));
    gridMajor =
      xTicks.map((t) => `M${xOf(t).toFixed(1)} ${frame.y}V${frame.y + frame.height}`).join('') +
      yTicks.map((v) => `M${frame.x} ${yOf(v).toFixed(1)}H${frame.x + frame.width}`).join('');
  }
  const label = paper ? colors.paperText : colors.faint;
  const yStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1;

  return (
    <>
      <Rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} fill={paper ? colors.paperBg : colors.panel} />
      {gridMinor ? <Path d={gridMinor} stroke={colors.paperMinor} strokeWidth={0.5} /> : null}
      {gridMajor ? <Path d={gridMajor} stroke={paper ? colors.paperMajor : colors.gridMajor} strokeWidth={paper ? 0.9 : 1} /> : null}
      {xTicks.map((t) => (
        <SvgText key={`x${t}`} x={xOf(t)} y={height - 6} fill={label} fontSize={10} fontFamily={mono} textAnchor="middle">
          {formatTime(t, windowSeconds)}
        </SvgText>
      ))}
      {yTicks.map((v) => (
        <SvgText key={`y${v}`} x={frame.x - 6} y={yOf(v) + 3} fill={label} fontSize={10} fontFamily={mono} textAnchor="end">
          {formatValue(v, units, yStep)}
        </SvgText>
      ))}
    </>
  );
});

export function TraceView(props: Props) {
  const { series, fs, live, endIndex, windowSeconds, height, color, units, paper, emptyText, onPan, frameMs = FRAME_MS } = props;
  const [width, setWidth] = useState(0);
  const clipId = `plot${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  const [, setFrame] = useState(0);
  const range = useRef<{ at: number; key: string; yMin: number; yMax: number } | null>(null);

  // Redraw only when new samples have arrived.
  useEffect(() => {
    if (!live) return;
    let drawnEnd = -1;
    const timer = setInterval(() => {
      if (series.end === drawnEnd) return;
      drawnEnd = series.end;
      setFrame((n) => n + 1);
    }, frameMs);
    return () => clearInterval(timer);
  }, [live, series, frameMs]);

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
      // Saturated samples carry no signal; scaling to them would flatten everything else.
      const r = autoRange(cols, units === 'counts' ? isClipped : undefined);
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

  return (
    <View style={{ height }} onLayout={onLayout} {...panHandlers}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          <Defs>
            <ClipPath id={clipId}>
              <Rect x={MARGIN.left} y={MARGIN.top} width={plotW} height={plotH} />
            </ClipPath>
          </Defs>
          {frame ? (
            <Axes
              width={width}
              height={height}
              yMin={frame.yMin}
              yMax={frame.yMax}
              xStart={live ? -windowSeconds : start / fs}
              windowSeconds={windowSeconds}
              units={units}
              paperSpeed={paper?.speed ?? 0}
              paperGain={paper?.gain ?? 0}
            />
          ) : (
            <Rect x={MARGIN.left} y={MARGIN.top} width={plotW} height={plotH} fill={paper ? colors.paperBg : colors.panel} />
          )}
          {trace ? (
            <Path
              clipPath={`url(#${clipId})`}
              d={trace}
              stroke={paper ? colors.paperTrace : color}
              strokeWidth={paper ? 1.2 : 1.4}
              fill="none"
            />
          ) : null}
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
