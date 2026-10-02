import React from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { SAMPLE_RATE_HZ } from '../core/device';
import { ECG_FILTERS, MAINS_NOTCH, RESP_FILTERS, type EcgFilterId, type NotchId, type RespFilterId } from '../core/filters';
import type { SampleSeries } from '../core/series';
import { Segmented, Toggle, type Option } from './controls';
import { Panel } from './panels';
import { colors, space } from './theme';
import { TraceView } from './TraceView';

export interface DisplaySettings {
  ecgWindow: number;
  ecgFilter: EcgFilterId;
  notch: NotchId;
  paper: boolean;
  /** mm/s */
  speed: number;
  /** mm/mV */
  gain: number;
  respWindow: number;
  respFilter: RespFilterId;
}

export const DEFAULT_SETTINGS: DisplaySettings = {
  ecgWindow: 10,
  ecgFilter: 'monitor',
  notch: 'off',
  paper: false,
  speed: 25,
  gain: 10,
  respWindow: 30,
  respFilter: 'lowpass2',
};

const options = <T extends string>(table: Record<T, { label: string }>): Option<T>[] =>
  (Object.keys(table) as T[]).map((id) => ({ id, label: table[id].label }));

const ECG_WINDOWS: Option<number>[] = [2, 5, 10, 30].map((s) => ({ id: s, label: `${s} s` }));
const RESP_WINDOWS: Option<number>[] = [10, 30, 60, 120].map((s) => ({ id: s, label: `${s} s` }));
const SPEEDS: Option<number>[] = [12.5, 25, 50].map((s) => ({ id: s, label: `${s}` }));
const GAINS: Option<number>[] = [5, 10, 20].map((g) => ({ id: g, label: `${g}` }));

export function SignalPanels({
  settings,
  onChange,
  ecg,
  resp,
  live,
  endIndex,
  onPan,
  respEmptyText,
}: {
  settings: DisplaySettings;
  onChange: (settings: DisplaySettings) => void;
  ecg: SampleSeries;
  resp: SampleSeries;
  live: boolean;
  endIndex: number;
  onPan?: (deltaSeconds: number) => void;
  respEmptyText: string;
}) {
  const { height } = useWindowDimensions();
  const ecgHeight = Math.round(Math.min(440, Math.max(200, height * 0.36)));
  const respHeight = Math.round(Math.min(300, Math.max(150, height * 0.22)));
  const set = (patch: Partial<DisplaySettings>) => onChange({ ...settings, ...patch });

  return (
    <View style={styles.stack}>
      <Panel
        title="ECG"
        accent={colors.ecg}
        right={
          <>
            <Segmented options={ECG_WINDOWS} value={settings.ecgWindow} onChange={(ecgWindow) => set({ ecgWindow })} />
            <Segmented options={options(ECG_FILTERS)} value={settings.ecgFilter} onChange={(ecgFilter) => set({ ecgFilter })} />
            <Segmented options={options(MAINS_NOTCH)} value={settings.notch} onChange={(notch) => set({ notch })} />
            <Toggle label="ECG paper" value={settings.paper} onChange={(paper) => set({ paper })} />
            {settings.paper ? (
              <>
                <Segmented label="mm/s" options={SPEEDS} value={settings.speed} onChange={(speed) => set({ speed })} />
                <Segmented label="mm/mV" options={GAINS} value={settings.gain} onChange={(gain) => set({ gain })} />
              </>
            ) : null}
          </>
        }>
        <TraceView
          series={ecg}
          fs={SAMPLE_RATE_HZ}
          live={live}
          endIndex={endIndex}
          windowSeconds={settings.ecgWindow}
          height={ecgHeight}
          color={colors.ecg}
          units={settings.paper ? 'mV' : 'counts'}
          paper={settings.paper ? { speed: settings.speed, gain: settings.gain } : null}
          emptyText="Waiting for ECG samples"
          onPan={onPan}
        />
      </Panel>
      <Panel
        title="Respiration"
        accent={colors.resp}
        right={
          <>
            <Segmented options={RESP_WINDOWS} value={settings.respWindow} onChange={(respWindow) => set({ respWindow })} />
            <Segmented options={options(RESP_FILTERS)} value={settings.respFilter} onChange={(respFilter) => set({ respFilter })} />
          </>
        }>
        <TraceView
          series={resp}
          fs={SAMPLE_RATE_HZ}
          live={live}
          endIndex={endIndex}
          windowSeconds={settings.respWindow}
          height={respHeight}
          color={colors.resp}
          units="counts"
          emptyText={respEmptyText}
          onPan={onPan}
        />
      </Panel>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
});
