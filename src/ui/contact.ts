import type { ContactStatus, RateEstimate } from '../core/metrics';
import { colors } from './theme';

export interface ContactMessage {
  title: string;
  note: string;
  color: string;
  /** Worth flagging on the trace itself, not just in the tile. */
  alert: boolean;
}

/** What the electrode check means for the person at the bench, and what to do about it. */
export function contactMessage(contact: ContactStatus, heart: RateEstimate): ContactMessage {
  switch (contact) {
    case 'no-data':
      return { title: 'No data', note: 'Connect a board to check contact', color: colors.faint, alert: false };
    case 'collecting':
      return { title: 'Checking…', note: 'Needs a few seconds of signal', color: colors.muted, alert: false };
    case 'off':
      return {
        title: 'Not in contact',
        note: 'Respiration input saturated: attach the electrodes or press them onto skin',
        color: colors.danger,
        alert: true,
      };
    case 'movement':
      return {
        title: 'Movement',
        note: 'Swings far larger than a heartbeat: keep still and let the leads hang freely',
        color: colors.warn,
        alert: true,
      };
    case 'ecg-clipped':
      return { title: 'ECG clipped', note: 'Input beyond the ADC range: check the lead wiring', color: colors.danger, alert: true };
    default:
      if (contact !== 'stable') return { title: 'Unknown', note: '', color: colors.faint, alert: false };
      if (heart.value !== null) {
        return { title: 'Good', note: 'Steady signal with clear heartbeats', color: colors.ok, alert: false };
      }
      if (heart.reason === 'collecting' || heart.reason === 'movement artefact') {
        return { title: 'Settling…', note: 'Waiting for 8 s of steady signal', color: colors.muted, alert: false };
      }
      return {
        title: 'No clear heartbeat',
        note: 'Signal is steady but shows no beats: check electrode placement',
        color: colors.warn,
        alert: false,
      };
  }
}
