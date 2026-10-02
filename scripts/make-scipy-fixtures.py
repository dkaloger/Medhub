"""Regenerate tests/fixtures/scipy.json, the reference outputs the TypeScript DSP is checked against.

    python3 scripts/make-scipy-fixtures.py   (needs numpy + scipy)
"""
import json
from pathlib import Path

import numpy as np
from scipy.signal import butter, find_peaks, iirnotch, sosfilt, sosfilt_zi, sosfiltfilt, tf2sos

FS = 250.0
rng = np.random.default_rng(7)
t = np.arange(1000) / FS
signal = -700000 + 3000 * np.sin(2 * np.pi * 1.3 * t) + 800 * np.sin(2 * np.pi * 50 * t) + 200 * rng.standard_normal(t.size)

def sos_list(sos):
    return [[s[0], s[1], s[2], s[4], s[5]] for s in sos]

low40 = butter(2, 40, "low", fs=FS, output="sos")
high05 = butter(2, 0.5, "high", fs=FS, output="sos")
notch50 = tf2sos(*iirnotch(50, 30, fs=FS))
band = np.vstack([high05, low40])

noisy = rng.standard_normal(600).cumsum()
peaks, props = find_peaks(noisy, height=np.percentile(noisy, 40), distance=12, prominence=1.5)

fixtures = {
    "signal": signal.tolist(),
    "lowpass40": sos_list(low40),
    "highpass05": sos_list(high05),
    "notch50": sos_list(notch50),
    "bandSosfilt": sosfilt(band, signal, zi=sosfilt_zi(band) * signal[0])[0].tolist(),
    "bandFiltfilt": sosfiltfilt(band, signal).tolist(),
    "notchFiltfilt": sosfiltfilt(notch50, signal).tolist(),
    "peaksInput": noisy.tolist(),
    "peaks": peaks.tolist(),
    "prominences": props["prominences"].tolist(),
}
out = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "scipy.json"
out.write_text(json.dumps(fixtures))
print(f"wrote {out}")
