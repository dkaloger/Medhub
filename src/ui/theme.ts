import { Platform } from 'react-native';

/** Dark, monitor-style palette; virtual ECG paper uses its own light colours. */
export const colors = {
  bg: '#0b0f14',
  panel: '#121821',
  panelBorder: '#1f2a36',
  raised: '#1a2330',
  raisedActive: '#2b3a4d',
  text: '#e6edf3',
  muted: '#8b98a5',
  faint: '#5c6b7a',
  ecg: '#3ddc84',
  resp: '#4fc3f7',
  ok: '#3ddc84',
  warn: '#f0b429',
  danger: '#ff6b6b',
  simulated: '#c792ea',
  grid: '#18212c',
  gridMajor: '#243140',
  paperBg: '#fff7f3',
  paperMinor: '#f6d3d3',
  paperMajor: '#e3a0a0',
  paperTrace: '#1b1b1b',
  paperText: '#8a5a5a',
};

export const mono = Platform.select({ macos: 'Menlo', windows: 'Consolas', default: 'monospace' });

export const space = { xs: 4, sm: 8, md: 12, lg: 16 };
