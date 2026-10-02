"""Experimental, non-diagnostic rate estimates from ADS1292R sample streams."""

from __future__ import annotations

import numpy as np
from scipy.signal import butter, find_peaks, sosfilt, sosfilt_zi, sosfiltfilt

SAMPLE_RATE = 250.0
ADC_POSITIVE_FULL_SCALE = (1 << 23) - 1
NOMINAL_REFERENCE_V = 2.42
ECG_PGA_GAIN = 4


def counts_to_nominal_mv(values: np.ndarray) -> np.ndarray:
    """Input-referred mV assuming the firmware's 2.42 V reference and gain 4.

    This is a datasheet-derived estimate, not a measured system calibration.
    """
    return np.asarray(values, dtype=float) * (
        1000.0 * NOMINAL_REFERENCE_V / (ECG_PGA_GAIN * ADC_POSITIVE_FULL_SCALE)
    )


def ecg_signal_status(values: np.ndarray) -> str:
    """Flag obvious ADC failures; this does not determine electrode contact."""
    signal = np.asarray(values, dtype=float)
    if len(signal) < 2 * SAMPLE_RATE:
        return "Collecting data"
    recent = signal[-int(5 * SAMPLE_RATE):]
    if np.mean(np.abs(recent) >= ADC_POSITIVE_FULL_SCALE - 607) > 0.01:
        return "ADC clipped"
    if np.ptp(recent) < 40:
        return "Flat / no variation"
    return "No obvious clipping (contact unverified)"


def _filtered(values: np.ndarray, low_hz: float, high_hz: float) -> np.ndarray:
    centered = values - np.median(values)
    sos = butter(2, [low_hz, high_hz], btype="bandpass", fs=SAMPLE_RATE, output="sos")
    return sosfiltfilt(sos, centered)


def filter_ecg_for_display(values: np.ndarray, mode: str = "Rhythm 0.5–40 Hz") -> np.ndarray:
    """Apply a viewing-only filter; raw samples are always retained for CSV."""
    signal = np.asarray(values, dtype=float)
    if mode == "Raw":
        return signal
    if len(signal) == 0:
        return signal
    if len(signal) < SAMPLE_RATE:
        return signal - np.median(signal)
    if mode == "Low-pass 40 Hz":
        sos = butter(2, 40.0, btype="lowpass", fs=SAMPLE_RATE, output="sos")
        return sosfiltfilt(sos, signal)
    if mode == "Rhythm 0.5–40 Hz":
        return _filtered(signal, 0.5, 40.0)
    raise ValueError(f"Unknown ECG display filter: {mode}")


def estimate_bpm(values: np.ndarray) -> int | None:
    """Return a tentative pulse rate, or None when beats are not convincing."""
    signal = np.asarray(values, dtype=float)
    if len(signal) < 8 * SAMPLE_RATE or np.ptp(signal) < 40:
        return None
    recent = signal[-int(15 * SAMPLE_RATE):]
    band = _filtered(recent, 5.0, 25.0)
    derivative = np.diff(band, prepend=band[0])
    energy = np.convolve(derivative * derivative, np.ones(25) / 25, mode="same")
    if not np.isfinite(energy).all() or np.max(energy) <= 0:
        return None
    prominence = max(np.percentile(energy, 85) * 0.7, np.max(energy) * 0.08)
    peaks, properties = find_peaks(energy, distance=int(0.35 * SAMPLE_RATE), prominence=prominence)
    if len(peaks) < 4:
        return None
    # Reject isolated noise spikes; keep only peaks comparable with the median.
    strengths = properties["prominences"]
    peaks = peaks[strengths >= np.median(strengths) * 0.45]
    intervals = np.diff(peaks) / SAMPLE_RATE
    intervals = intervals[(intervals >= 0.4) & (intervals <= 1.5)]
    if len(intervals) < 3 or np.std(intervals) / np.mean(intervals) > 0.3:
        return None
    bpm = 60.0 / np.median(intervals)
    return round(bpm) if 40 <= bpm <= 150 else None


def filter_resp_for_display(values: np.ndarray, mode: str = "Fast low-pass 2 Hz") -> np.ndarray:
    """Viewing-only causal filter: lag is expected; never interpolate missing data.

    Pass buffered history, not just the visible slice, to retain filter context.
    Each finite segment starts at steady state to suppress DC startup transients.
    """
    signal = np.asarray(values, dtype=float)
    if mode == "Raw":
        return signal.copy()
    if mode == "Slow 0.07–0.7 Hz":
        sos = butter(2, [0.07, 0.7], btype="bandpass", fs=SAMPLE_RATE, output="sos")
    elif mode == "Fast low-pass 2 Hz":
        # About 0.11 s group delay at 0.1–0.5 Hz; retains baseline drift.
        sos = butter(2, 2.0, btype="lowpass", fs=SAMPLE_RATE, output="sos")
    elif mode == "Low-pass 2 Hz":
        sos = butter(4, 2.0, btype="lowpass", fs=SAMPLE_RATE, output="sos")
    else:
        raise ValueError(f"Unknown respiration display filter: {mode}")
    output = np.full(signal.shape, np.nan)
    finite = np.isfinite(signal)
    edges = np.diff(np.r_[False, finite, False].astype(int))
    for start, end in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
        segment = signal[start:end] - signal[start]
        output[start:end], _ = sosfilt(sos, segment, zi=sosfilt_zi(sos) * segment[0])
    return output


def estimate_breaths_per_minute(values: np.ndarray) -> int | None:
    """Estimate respiration rate only from actual ADS1292R CH1 respiration data."""
    signal = np.asarray(values, dtype=float)
    if len(signal) < 25 * SAMPLE_RATE or np.ptp(signal) < 20:
        return None
    recent = signal[-int(60 * SAMPLE_RATE):]
    band = _filtered(recent, 0.07, 0.7)
    amplitude = np.percentile(band, 90) - np.percentile(band, 10)
    if amplitude < 5:
        return None
    peaks, _ = find_peaks(
        band,
        distance=int(1.5 * SAMPLE_RATE),
        prominence=0.35 * amplitude,
    )
    if len(peaks) < 4:
        return None
    intervals = np.diff(peaks) / SAMPLE_RATE
    intervals = intervals[(intervals >= 1.5) & (intervals <= 10.0)]
    if len(intervals) < 3 or np.std(intervals) / np.mean(intervals) > 0.35:
        return None
    rate = 60.0 / np.median(intervals)
    return round(rate) if 6 <= rate <= 40 else None
