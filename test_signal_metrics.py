import sys
from pathlib import Path
from io import StringIO
import unittest

import numpy as np
from scipy.signal import butter, sosfreqz

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ecg_viewer import ContinuousRecorder, parse_sample, write_recording_rows
from signal_metrics import (
    SAMPLE_RATE, counts_to_nominal_mv, ecg_signal_status, estimate_bpm,
    estimate_breaths_per_minute, filter_ecg_for_display, filter_resp_for_display,
)


class SignalMetricsTests(unittest.TestCase):
    def test_serial_lines(self):
        self.assertEqual(parse_sample("ECG:-217858\tZERO:0"), (-217858, None))
        self.assertEqual(parse_sample("ECG:123\tRESP:-456"), (123, -456))
        self.assertIsNone(parse_sample("READY_ELECTRODE_INPUT"))

    def test_recording_csv(self):
        output = StringIO()
        write_recording_rows(output, [(100, None), (-50, 250)])
        self.assertEqual(
            output.getvalue().splitlines(),
            ["time_s,ecg_adc_counts,resp_adc_counts", "0.000,100,", "0.004,-50,250"],
        )

    def test_flat_signal_has_no_rate(self):
        flat = np.zeros(int(30 * SAMPLE_RATE))
        self.assertIsNone(estimate_bpm(flat))
        self.assertIsNone(estimate_breaths_per_minute(flat))

    def test_synthetic_ecg_roughly_72_bpm(self):
        t = np.arange(20 * int(SAMPLE_RATE)) / SAMPLE_RATE
        signal = np.zeros_like(t)
        for beat in np.arange(0.8, 20, 60 / 72):
            signal += 3000 * np.exp(-0.5 * ((t - beat) / 0.022) ** 2)
        self.assertAlmostEqual(estimate_bpm(signal), 72, delta=3)

    def test_synthetic_respiration_roughly_15_per_minute(self):
        t = np.arange(60 * int(SAMPLE_RATE)) / SAMPLE_RATE
        signal = 1000 * np.sin(2 * np.pi * 0.25 * t)
        self.assertAlmostEqual(estimate_breaths_per_minute(signal), 15, delta=2)

    def test_nominal_voltage_and_quality_flags(self):
        self.assertAlmostEqual(counts_to_nominal_mv(np.array([0, 8388607]))[1], 605.0)
        self.assertEqual(ecg_signal_status(np.full(1500, 8388607)), "ADC clipped")
        self.assertEqual(ecg_signal_status(np.zeros(1500)), "Flat / no variation")
        moving = 3000 * np.sin(2 * np.pi * np.arange(1500) / 100)
        self.assertIn("No obvious clipping", ecg_signal_status(moving))

    def test_display_filters_do_not_change_raw(self):
        values = np.arange(500, dtype=float)
        np.testing.assert_array_equal(filter_ecg_for_display(values, "Raw"), values)
        self.assertEqual(len(filter_ecg_for_display(values, "Low-pass 40 Hz")), len(values))
        self.assertEqual(len(filter_ecg_for_display(values, "Rhythm 0.5–40 Hz")), len(values))
        with self.assertRaises(ValueError):
            filter_ecg_for_display(values, "unknown")

    def test_demo_session_is_clearly_separate(self):
        recorder = ContinuousRecorder(Path("recordings"), demo=True)
        self.assertTrue(recorder.session.name.startswith("simulated_"))

    def test_resp_filter_preserves_raw_and_missing_samples(self):
        values = np.full(2000, 700000.0)
        values[1000:1020] = np.nan
        original = values.copy()
        np.testing.assert_array_equal(filter_resp_for_display(values, "Raw"), values)
        for mode in ("Slow 0.07–0.7 Hz", "Low-pass 2 Hz", "Fast low-pass 2 Hz"):
            filtered = filter_resp_for_display(values, mode)
            np.testing.assert_array_equal(np.isnan(filtered), np.isnan(values))
            np.testing.assert_allclose(filtered[np.isfinite(filtered)], 0, atol=1e-8)
        np.testing.assert_array_equal(values, original)
        self.assertEqual(len(filter_resp_for_display(np.array([]))), 0)
        with self.assertRaises(ValueError):
            filter_resp_for_display(values, "unknown")

    def test_resp_filter_rejects_fast_noise_but_keeps_slow_variation(self):
        t = np.arange(60 * int(SAMPLE_RATE)) / SAMPLE_RATE
        slow = 1000 * np.sin(2 * np.pi * 0.25 * t)
        raw = 700000 + slow + 5000 * np.sin(2 * np.pi * 12 * t)
        filtered = filter_resp_for_display(raw, "Slow 0.07–0.7 Hz")
        recent = filtered[int(30 * SAMPLE_RATE):]
        self.assertGreater(np.std(recent), 500)
        self.assertLess(np.std(recent), 850)

    def test_fast_resp_filter_response_and_delay(self):
        t = np.arange(20 * int(SAMPLE_RATE)) / SAMPLE_RATE
        raw = 700000 + 1000 * np.sin(2 * np.pi * 0.25 * t)
        fast = filter_resp_for_display(raw)
        # Compare against the actual two-pole design, including causal phase.
        sos = butter(2, 2.0, btype="lowpass", fs=SAMPLE_RATE, output="sos")
        f = np.array([0.249, 0.25, 0.251])
        _, response = sosfreqz(sos, worN=f, fs=SAMPLE_RATE)
        delay = -np.diff(np.unwrap(np.angle(response))) / np.diff(2 * np.pi * f)
        self.assertTrue(np.all((delay > 0) & (delay < 0.15)))
        expected = 1000 * abs(response[1]) * np.sin(2 * np.pi * 0.25 * t + np.angle(response[1]))
        np.testing.assert_allclose(fast[int(5 * SAMPLE_RATE):], expected[int(5 * SAMPLE_RATE):], atol=0.01)
        np.testing.assert_array_equal(raw, 700000 + 1000 * np.sin(2 * np.pi * 0.25 * t))


if __name__ == "__main__":
    unittest.main()
