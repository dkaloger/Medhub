import React, { useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { SAMPLE_RATE_HZ } from '../core/device';
import { ANALYSIS, REFERENCE, type EcgAnalysis, type Interval, type MedianBeat, type RhythmPattern } from '../core/ecgAnalysis';
import { Pill } from './controls';
import { Panel } from './panels';
import { colors, mono, space } from './theme';

const PATTERN_COLOR: Record<RhythmPattern, string> = {
  insufficient: colors.muted,
  regular: colors.ok,
  irregular: colors.warn,
  'irregularly-irregular': colors.danger,
};

function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  return [width, (e) => setWidth(Math.floor(e.nativeEvent.layout.width))];
}

/** The median beat with the measured wave boundaries marked, so the numbers can be checked. */
function MedianBeatView({ beat }: { beat: MedianBeat }) {
  const [width, onLayout] = useWidth();
  const height = 170;
  const pad = { l: 8, r: 8, t: 22, b: 18 };
  const w = beat.waveform;
  const f = beat.fiducials;
  const lo = Math.min(...w);
  const hi = Math.max(...w);
  const x = (i: number) => pad.l + (i / (w.length - 1)) * (width - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (height - pad.t - pad.b);
  const path = Array.from(w, (v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  const spans: { from: number | null; to: number | null; label: string; color: string; row: number }[] = [
    { from: f.pOnset, to: f.qrsOnset, label: 'PR', color: colors.resp, row: 0 },
    { from: f.qrsOnset, to: f.qrsOffset, label: 'QRS', color: colors.ecg, row: 1 },
    { from: f.qrsOnset, to: f.tEnd, label: 'QT', color: colors.warn, row: 2 },
  ];
  const ms = Math.round((1000 * (w.length - 1)) / SAMPLE_RATE_HZ);
  return (
    <View onLayout={onLayout} style={styles.beatBox}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          <Rect x={pad.l} y={pad.t} width={width - pad.l - pad.r} height={height - pad.t - pad.b} fill={colors.bg} />
          {spans.map((s) =>
            s.from !== null && s.to !== null ? (
              <React.Fragment key={s.label}>
                <Rect x={x(s.from)} y={pad.t} width={x(s.to) - x(s.from)} height={height - pad.t - pad.b} fill={s.color} opacity={0.08} />
                <Line x1={x(s.from)} x2={x(s.to)} y1={4 + s.row * 6} y2={4 + s.row * 6} stroke={s.color} strokeWidth={2} />
              </React.Fragment>
            ) : null,
          )}
          {[f.pOnset, f.qrsOnset, f.qrsOffset, f.tEnd].map((i, k) =>
            i !== null ? <Line key={k} x1={x(i)} x2={x(i)} y1={pad.t} y2={height - pad.b} stroke={colors.faint} strokeDasharray="3 3" /> : null,
          )}
          <Path d={path} stroke={colors.text} strokeWidth={1.6} fill="none" />
          {[
            [f.pPeak, 'P'],
            [f.r, 'R'],
            [f.tPeak, 'T'],
          ].map(([i, label]) =>
            i !== null ? (
              <SvgText key={label as string} x={x(i as number)} y={height - 5} fill={colors.muted} fontSize={10} textAnchor="middle">
                {label}
              </SvgText>
            ) : null,
          )}
        </Svg>
      ) : null}
      <Text style={styles.caption}>
        Median of {beat.beatsAveraged} beats · {ms} ms shown · bars: PR, QRS, QT
      </Text>
    </View>
  );
}

/** RR interval of every beat over the analysis window; colour marks early and late beats. */
function Tachogram({ intervals, windowS }: { intervals: Interval[]; windowS: number }) {
  const [width, onLayout] = useWidth();
  const height = 120;
  const pad = { l: 40, r: 6, t: 6, b: 16 };
  if (intervals.length < 2) return <View onLayout={onLayout} style={{ height }} />;
  const rr = intervals.map((iv) => iv.rr * 1000);
  const lo = Math.min(...rr) - 20;
  const hi = Math.max(...rr) + 20;
  const x = (t: number) => pad.l + (t / windowS) * (width - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (height - pad.t - pad.b);
  const normal = intervals.filter((iv) => iv.kind === 'normal');
  const line = normal.map((iv, i) => `${i ? 'L' : 'M'}${x(iv.t).toFixed(1)} ${y(iv.rr * 1000).toFixed(1)}`).join('');
  return (
    <View onLayout={onLayout}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          <Rect x={pad.l} y={pad.t} width={width - pad.l - pad.r} height={height - pad.t - pad.b} fill={colors.bg} />
          {[lo + 20, (lo + hi) / 2, hi - 20].map((v) => (
            <SvgText key={v} x={pad.l - 4} y={y(v) + 3} fill={colors.faint} fontSize={9} fontFamily={mono} textAnchor="end">
              {Math.round(v)}
            </SvgText>
          ))}
          <Path d={line} stroke={colors.ecg} strokeWidth={1} fill="none" opacity={0.6} />
          {intervals.map((iv, i) => (
            <Circle
              key={i}
              cx={x(iv.t)}
              cy={y(iv.rr * 1000)}
              r={iv.kind === 'normal' ? 1.6 : 3}
              fill={iv.kind === 'normal' ? colors.ecg : iv.kind === 'premature' ? colors.danger : colors.warn}
            />
          ))}
          <SvgText x={pad.l} y={height - 3} fill={colors.faint} fontSize={9}>
            −{Math.round(windowS)} s
          </SvgText>
          <SvgText x={width - pad.r} y={height - 3} fill={colors.faint} fontSize={9} textAnchor="end">
            now
          </SvgText>
        </Svg>
      ) : null}
      <Text style={styles.caption}>RR interval (ms) per beat · red early, amber late</Text>
    </View>
  );
}

function Row({ label, value, unit, range, outside }: { label: string; value: string; unit: string; range?: string; outside?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, outside && { color: colors.warn }]}>
        {value}
        <Text style={styles.rowUnit}> {unit}</Text>
      </Text>
      {range ? <Text style={styles.rowRange}>{range}</Text> : null}
    </View>
  );
}

const fmt = (v: number | null | undefined, digits = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits));
const outside = (v: number | null, [lo, hi]: readonly [number, number]) => v !== null && (v < lo || v > hi);

export function RhythmPanel({ analysis, context }: { analysis: EcgAnalysis | null; context: 'live' | 'review' }) {
  const windowText = context === 'live' ? `last ${ANALYSIS.windowS / 60} min` : `${ANALYSIS.windowS / 60} min before view end`;
  if (!analysis) {
    return (
      <Panel title="Rhythm & intervals" accent={colors.warn}>
        <Text style={styles.empty}>Connect a board to analyse rhythm, intervals and beat variation.</Text>
      </Panel>
    );
  }
  const { rhythm, variation, medianBeat, detection, intervals, windowS } = analysis;
  const iv = medianBeat?.intervals;
  const hr = variation?.meanHR ?? null;
  return (
    <Panel
      title="Rhythm & intervals"
      accent={colors.warn}
      badge={<Pill text="Experimental · not diagnostic" color={colors.faint} />}>
      <View style={styles.grid}>
        <View style={[styles.cell, styles.rhythmCell]}>
          <Text style={styles.cellTitle}>Rhythm</Text>
          <Text style={[styles.summary, { color: PATTERN_COLOR[rhythm.pattern] }]}>{rhythm.summary}</Text>
          {rhythm.findings.map((finding) => (
            <Text key={finding} style={styles.finding}>
              • {finding}
            </Text>
          ))}
          <Text style={styles.caption}>
            {windowText} · {detection.beats.length} beats · {Math.round(detection.analysedS)} of {Math.round(windowS)} s usable
          </Text>
        </View>

        <View style={styles.cell}>
          <Text style={styles.cellTitle}>Median beat</Text>
          {medianBeat ? (
            <MedianBeatView beat={medianBeat} />
          ) : (
            <Text style={styles.empty}>Needs about 10 steady beats.</Text>
          )}
        </View>

        <View style={styles.cell}>
          <Text style={styles.cellTitle}>Intervals</Text>
          <Row label="Heart rate" value={fmt(hr)} unit="bpm" range="60–100" outside={outside(hr, REFERENCE.heartRate)} />
          <Row label="PR" value={fmt(iv?.pr)} unit="ms" range="120–200" outside={outside(iv?.pr ?? null, REFERENCE.pr)} />
          <Row label="QRS" value={fmt(iv?.qrs)} unit="ms" range="70–110" outside={outside(iv?.qrs ?? null, REFERENCE.qrs)} />
          <Row label="QT" value={fmt(iv?.qt)} unit="ms" />
          <Row label="QTc Bazett" value={fmt(iv?.qtcBazett)} unit="ms" range="350–460" outside={outside(iv?.qtcBazett ?? null, REFERENCE.qtc)} />
          <Row label="QTc Fridericia" value={fmt(iv?.qtcFridericia)} unit="ms" range="350–460" outside={outside(iv?.qtcFridericia ?? null, REFERENCE.qtc)} />
          <Text style={styles.caption}>Typical resting adult ranges · — = not measurable in this lead</Text>
        </View>

        <View style={[styles.cell, styles.variationCell]}>
          <Text style={styles.cellTitle}>Beat-to-beat variation</Text>
          <View style={styles.hrvRow}>
            <View style={styles.hrvColumn}>
              <Row label="SDNN" value={fmt(variation?.sdnn)} unit="ms" />
              <Row label="RMSSD" value={fmt(variation?.rmssd)} unit="ms" />
              <Row label="pNN50" value={fmt(variation?.pnn50, 1)} unit="%" />
              <Row label="SD1 / SD2" value={`${fmt(variation?.sd1)} / ${fmt(variation?.sd2)}`} unit="ms" />
              <Row label="HR range" value={variation ? `${fmt(variation.minHR)}–${fmt(variation.maxHR)}` : '—'} unit="bpm" />
            </View>
            <View style={styles.tachogram}>
              <Tachogram intervals={intervals} windowS={windowS} />
            </View>
          </View>
          <Text style={styles.caption}>
            From normal-to-normal beats only. Short windows and movement make these noisy; 5 min at rest is the usual standard.
          </Text>
        </View>
      </View>
    </Panel>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, paddingBottom: space.md, paddingHorizontal: space.xs },
  cell: { flexGrow: 1, flexBasis: 260, minWidth: 240, gap: 4 },
  rhythmCell: { flexBasis: 240 },
  variationCell: { flexBasis: 480 },
  cellTitle: { color: colors.muted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  summary: { fontSize: 17, fontWeight: '700' },
  finding: { color: colors.text, fontSize: 12, lineHeight: 17 },
  caption: { color: colors.faint, fontSize: 11, marginTop: 2 },
  empty: { color: colors.muted, fontSize: 13, padding: space.sm },
  beatBox: { gap: 2 },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm, paddingVertical: 1 },
  rowLabel: { color: colors.muted, fontSize: 12, width: 104 },
  rowValue: { color: colors.text, fontSize: 15, fontFamily: mono, minWidth: 80 },
  rowUnit: { color: colors.faint, fontSize: 11 },
  rowRange: { color: colors.faint, fontSize: 11, fontFamily: mono },
  hrvRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  hrvColumn: { flexBasis: 220, flexGrow: 0 },
  tachogram: { flexGrow: 1, flexBasis: 240 },
});
