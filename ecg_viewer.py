"""Live, zoomable bench viewer for the ADS1292R serial sketches."""

from __future__ import annotations

import argparse
from collections import deque
import csv
from datetime import datetime
from pathlib import Path
import queue
import re
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "_deps"))

import matplotlib

matplotlib.use("TkAgg")
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg, NavigationToolbar2Tk
from matplotlib.figure import Figure
from matplotlib.ticker import AutoLocator, FuncFormatter, MultipleLocator, NullLocator, ScalarFormatter
import numpy as np
import serial

from signal_metrics import (
    SAMPLE_RATE, counts_to_nominal_mv, ecg_signal_status, estimate_bpm,
    estimate_breaths_per_minute, filter_ecg_for_display, filter_resp_for_display,
)

ECG_PATTERN = re.compile(r"(?:^|\s)ECG:([+-]?\d+)(?=\s|$)")
RESP_PATTERN = re.compile(r"(?:^|\s)RESP:([+-]?\d+)(?=\s|$)")
MAX_SAMPLES = int(120 * SAMPLE_RATE)
RECORD_SAMPLES = int(120 * SAMPLE_RATE)
CONTINUOUS_CHUNK_SAMPLES = int(600 * SAMPLE_RATE)
PAPER_WIDTH_MM = 250.0  # Virtual width only; physical screen mm are not calibrated.
PAPER_HEIGHT_MM = 50.0
REFRESH_INTERVAL_MS = 50


def parse_sample(line: str) -> tuple[int, int | None] | None:
    ecg_match = ECG_PATTERN.search(line)
    if not ecg_match:
        return None
    resp_match = RESP_PATTERN.search(line)
    return int(ecg_match.group(1)), int(resp_match.group(1)) if resp_match else None


def write_recording(path: Path, values: list[tuple[int, int | None]]) -> None:
    """Save one local recording without names or external transmission."""
    with path.open("w", newline="", encoding="utf-8") as output:
        write_recording_rows(output, values)


def write_recording_rows(output, values: list[tuple[int, int | None]]) -> None:
    writer = csv.writer(output)
    writer.writerow(("time_s", "ecg_adc_counts", "resp_adc_counts"))
    for index, (ecg, resp) in enumerate(values):
        writer.writerow((f"{index / SAMPLE_RATE:.3f}", ecg, "" if resp is None else resp))


class ContinuousRecorder:
    """Write every incoming sample to rotating local CSV files until app exit."""

    def __init__(self, recordings_root: Path, demo: bool = False):
        prefix = "simulated" if demo else "session"
        self.session = recordings_root / f"{prefix}_{datetime.now():%Y%m%d_%H%M%S}"
        self.total_samples = 0
        self.part_number = 0
        self.part_samples = 0
        self.output = None
        self.writer = None

    def append(self, ecg: int, resp: int | None) -> None:
        if self.output is None or self.part_samples >= CONTINUOUS_CHUNK_SAMPLES:
            self.close()
            self.session.mkdir(parents=True, exist_ok=True)
            self.part_number += 1
            self.part_samples = 0
            path = self.session / f"part_{self.part_number:04d}.csv"
            self.output = path.open("w", newline="", encoding="utf-8")
            self.writer = csv.writer(self.output)
            self.writer.writerow(("time_s", "ecg_adc_counts", "resp_adc_counts"))
        self.writer.writerow((f"{self.total_samples / SAMPLE_RATE:.3f}", ecg, "" if resp is None else resp))
        self.total_samples += 1
        self.part_samples += 1
        if self.total_samples % int(SAMPLE_RATE) == 0:
            self.output.flush()

    def close(self) -> None:
        if self.output is not None:
            self.output.flush()
            self.output.close()
            self.output = None
            self.writer = None


class SerialReader(threading.Thread):
    def __init__(self, port: str, events: queue.Queue, stop_event: threading.Event):
        super().__init__(daemon=True)
        self.port = port
        self.events = events
        self.stop_event = stop_event

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                with serial.Serial(self.port, 115200, timeout=0.2) as connection:
                    self.events.put(("status", f"Connected to {self.port}; waiting for samples"))
                    while not self.stop_event.is_set():
                        line = connection.readline().decode("ascii", errors="replace").strip()
                        sample = parse_sample(line)
                        if sample is not None:
                            self.events.put(("sample", sample))
                        elif line.startswith("ERROR_"):
                            self.events.put(("status", line))
                        elif line.startswith("READY_"):
                            self.events.put(("status", line))
            except (serial.SerialException, OSError) as exc:
                self.events.put(("status", f"{self.port} unavailable: {exc}; retrying"))
                self.stop_event.wait(2)


class DemoReader(threading.Thread):
    """Generate clearly labelled synthetic ECG for interface checks, never respiration."""

    def __init__(self, events: queue.Queue, stop_event: threading.Event):
        super().__init__(daemon=True)
        self.events = events
        self.stop_event = stop_event

    def run(self) -> None:
        self.events.put(("status", "SIMULATED ECG; no hardware connected"))
        index = 0
        samples_per_batch = int(SAMPLE_RATE / 10)
        while not self.stop_event.is_set():
            tick = time.monotonic()
            for _ in range(samples_per_batch):
                t = index / SAMPLE_RATE
                phase = (t % 0.8) - 0.4
                ecg = (
                    1500 * np.exp(-0.5 * ((phase + 0.20) / 0.035) ** 2)
                    - 2500 * np.exp(-0.5 * ((phase + 0.018) / 0.010) ** 2)
                    + 12500 * np.exp(-0.5 * (phase / 0.012) ** 2)
                    - 4000 * np.exp(-0.5 * ((phase - 0.022) / 0.012) ** 2)
                    + 3500 * np.exp(-0.5 * ((phase - 0.20) / 0.060) ** 2)
                    + 200 * np.sin(2 * np.pi * 0.2 * t)
                )
                self.events.put(("sample", (round(ecg), None)))
                index += 1
            self.stop_event.wait(max(0, 0.1 - (time.monotonic() - tick)))


class Viewer:
    def __init__(self, port: str, demo: bool = False):
        self.root = tk.Tk()
        self.root.title("ADS1292R bench signal viewer")
        self.root.geometry("1100x760")
        self.events: queue.Queue = queue.Queue()
        self.port = port
        self.demo = demo
        self.stop_event = threading.Event()
        self.samples = deque(maxlen=MAX_SAMPLES)
        self.resp_samples = deque(maxlen=MAX_SAMPLES)
        self.sample_count = 0
        self.last_metrics_count = 0
        self.last_scale_count = -int(SAMPLE_RATE)
        self.plot_background = None
        self.background_signature = None
        self.paused = False
        self.paused_anchor = 0.0
        self.recording = False
        self.recorded: list[tuple[int, int | None]] = []
        self.replay = False
        self.replay_dirty = False
        self.history_mode = False
        self.history_dirty = False
        self.history_anchor = 0.0
        self.history_offset = tk.DoubleVar(value=0)
        self.replay_position = tk.DoubleVar(value=0)
        self.record_status = tk.StringVar(value="No recording saved")
        self.continuous_status = tk.StringVar(value="Continuous logging: waiting for samples")
        self.continuous_recorder = ContinuousRecorder(Path(__file__).resolve().parent / "recordings", demo=demo)
        self.continuous_failed = False
        self.window_seconds = tk.IntVar(value=10)
        self.filter_mode = tk.StringVar(value="Raw")
        self.resp_filter_mode = tk.StringVar(value="Fast low-pass 2 Hz")
        self.resp_window_seconds = tk.IntVar(value=30)
        self.paper_mode = tk.BooleanVar(value=False)
        self.paper_speed = tk.StringVar(value="25")
        self.paper_gain = tk.StringVar(value="10")
        self.display_dirty = False
        self.status = tk.StringVar(value="Opening serial port…")
        self.bpm = tk.StringVar(value="BPM: —")
        self.breathing = tk.StringVar(value="Breathing: unavailable (ECG-only firmware)")
        self.quality = tk.StringVar(value="Signal: collecting; electrode contact unknown")

        controls = ttk.Frame(self.root, padding=8)
        controls.pack(fill="x")
        ttk.Label(controls, text="Show last").pack(side="left")
        window_selector = ttk.Combobox(
            controls, textvariable=self.window_seconds, values=(2, 5, 10, 30, 60),
            width=5, state="readonly"
        )
        window_selector.pack(side="left", padx=5)
        window_selector.bind("<<ComboboxSelected>>", self.redraw_display)
        ttk.Label(controls, text="seconds").pack(side="left")
        ttk.Label(controls, text="ECG view").pack(side="left", padx=(12, 2))
        filter_selector = ttk.Combobox(
            controls, textvariable=self.filter_mode,
            values=("Raw", "Low-pass 40 Hz", "Rhythm 0.5–40 Hz"),
            width=19, state="readonly",
        )
        filter_selector.pack(side="left", padx=2)
        filter_selector.bind("<<ComboboxSelected>>", self.redraw_display)
        self.pause_button = ttk.Button(controls, text="Pause / zoom", command=self.toggle_pause)
        self.pause_button.pack(side="left", padx=16)
        self.record_button = ttk.Button(controls, text="Record 2 min", command=self.toggle_recording)
        self.record_button.pack(side="left", padx=4)
        ttk.Label(controls, textvariable=self.bpm).pack(side="left", padx=8)
        ttk.Label(controls, textvariable=self.breathing).pack(side="left", padx=8)

        paper_controls = ttk.Frame(self.root, padding=(8, 0))
        paper_controls.pack(fill="x")
        ttk.Checkbutton(
            paper_controls, text="Virtual ECG paper", variable=self.paper_mode,
            command=self.redraw_display,
        ).pack(side="left")
        ttk.Label(paper_controls, text="Speed (mm/s)").pack(side="left", padx=(12, 2))
        speed_selector = ttk.Combobox(
            paper_controls, textvariable=self.paper_speed, values=("12.5", "25", "50"),
            width=5, state="readonly",
        )
        speed_selector.pack(side="left")
        speed_selector.bind("<<ComboboxSelected>>", self.redraw_display)
        ttk.Label(paper_controls, text="Gain (mm/mV)").pack(side="left", padx=(12, 2))
        gain_selector = ttk.Combobox(
            paper_controls, textvariable=self.paper_gain, values=("5", "10", "20"),
            width=4, state="readonly",
        )
        gain_selector.pack(side="left")
        gain_selector.bind("<<ComboboxSelected>>", self.redraw_display)
        ttk.Label(
            paper_controls,
            text="Nominal mV only; screen millimetres and board reference are not calibrated",
        ).pack(side="left", padx=12)
        ttk.Label(paper_controls, textvariable=self.quality).pack(side="right", padx=8)

        resp_controls = ttk.Frame(self.root, padding=(8, 4))
        resp_controls.pack(fill="x")
        ttk.Label(resp_controls, text="Resp view").pack(side="left")
        resp_filter_selector = ttk.Combobox(
            resp_controls, textvariable=self.resp_filter_mode,
            values=("Fast low-pass 2 Hz", "Raw", "Low-pass 2 Hz", "Slow 0.07–0.7 Hz"),
            width=20, state="readonly",
        )
        resp_filter_selector.pack(side="left", padx=5)
        resp_filter_selector.bind("<<ComboboxSelected>>", self.redraw_display)
        ttk.Label(resp_controls, text="Show last").pack(side="left", padx=(12, 2))
        resp_window_selector = ttk.Combobox(
            resp_controls, textvariable=self.resp_window_seconds,
            values=(10, 30, 60, 120), width=5, state="readonly",
        )
        resp_window_selector.pack(side="left", padx=5)
        resp_window_selector.bind("<<ComboboxSelected>>", self.redraw_display)
        ttk.Label(resp_controls, text="seconds · Fast: ~0.11 s filter delay; source unverified").pack(side="left")

        self.figure = Figure(figsize=(10, 6), dpi=100)
        self.ecg_axis = self.figure.add_subplot(211)
        self.resp_axis = self.figure.add_subplot(212)
        self.ecg_line, = self.ecg_axis.plot([], [], lw=0.8, animated=True)
        self.resp_line, = self.resp_axis.plot([], [], lw=1.0, animated=True)
        self.ecg_axis.set_ylabel("ECG (ADC counts)")
        self.resp_axis.set_ylabel("Resp (ADC counts)")
        self.resp_axis.set_xlabel("Time (s, approximate)")
        self.ecg_axis.grid(alpha=0.25)
        self.resp_axis.grid(alpha=0.25)
        self.resp_axis.text(
            0.5, 0.5, "No respiration channel in current firmware",
            transform=self.resp_axis.transAxes, ha="center", va="center",
        )
        self.figure.tight_layout()
        self.canvas = FigureCanvasTkAgg(self.figure, master=self.root)
        self.canvas.mpl_connect("draw_event", self.cache_plot_background)
        self.canvas.get_tk_widget().pack(fill="both", expand=True)
        toolbar = NavigationToolbar2Tk(self.canvas, self.root, pack_toolbar=False)
        toolbar.update()
        toolbar.pack(fill="x")
        history_row = ttk.Frame(self.root, padding=(8, 2))
        history_row.pack(fill="x")
        ttk.Label(history_row, text="Live rewind").pack(side="left")
        self.history_scale = ttk.Scale(
            history_row, from_=0, to=120, variable=self.history_offset,
            orient="horizontal", command=self.seek_history,
        )
        self.history_scale.pack(side="left", fill="x", expand=True, padx=8)
        self.history_label = ttk.Label(history_row, text="Live")
        self.history_label.pack(side="left")
        replay_row = ttk.Frame(self.root, padding=(8, 2))
        replay_row.pack(fill="x")
        ttk.Label(replay_row, text="Saved clip position").pack(side="left")
        self.replay_scale = ttk.Scale(
            replay_row, from_=0, to=120, variable=self.replay_position,
            orient="horizontal", command=self.seek_recording, state="disabled",
        )
        self.replay_scale.pack(side="left", fill="x", expand=True, padx=8)
        self.replay_label = ttk.Label(replay_row, text="— / 120 s")
        self.replay_label.pack(side="left")
        ttk.Label(self.root, textvariable=self.continuous_status, padding=(8, 2)).pack(fill="x")
        ttk.Label(self.root, textvariable=self.record_status, padding=(8, 2)).pack(fill="x")
        ttk.Label(self.root, textvariable=self.status, padding=8).pack(fill="x")
        ttk.Label(
            self.root,
            text="Experimental bench display only. Estimates are not diagnostic; do not attach a USB-connected prototype to a person.",
            padding=(8, 0, 8, 8),
        ).pack(fill="x")

        self.reader = DemoReader(self.events, self.stop_event) if demo else SerialReader(port, self.events, self.stop_event)
        self.reader.start()
        self.root.after(REFRESH_INTERVAL_MS, self.refresh)
        self.root.protocol("WM_DELETE_WINDOW", self.close)

    def toggle_pause(self) -> None:
        if self.replay:
            self.replay = False
            self.replay_dirty = False
            self.paused = False
            self.pause_button.configure(text="Pause / zoom")
            return
        if self.history_mode:
            self.history_mode = False
            self.history_dirty = False
            self.history_offset.set(0)
            self.history_label.configure(text="Live")
            self.pause_button.configure(text="Pause / zoom")
            return
        self.paused = not self.paused
        if self.paused and self.samples:
            self.paused_anchor = self.samples[-1][0]
        self.pause_button.configure(text="Resume live" if self.paused else "Pause / zoom")

    def redraw_display(self, _event=None) -> None:
        self.display_dirty = True

    def plot_signature(self) -> tuple:
        """Redraw axes only when their visible content actually changes."""
        return (
            tuple(self.canvas.get_width_height()),
            tuple(self.ecg_axis.get_xlim()), tuple(self.ecg_axis.get_ylim()),
            tuple(self.resp_axis.get_xlim()), tuple(self.resp_axis.get_ylim()),
            self.ecg_axis.get_ylabel(), self.ecg_axis.get_title(),
            self.resp_axis.get_ylabel(), self.resp_axis.get_title(),
            self.resp_axis.get_xlabel(), self.resp_axis.texts[0].get_visible(),
            self.paper_mode.get(), self.paper_speed.get(), self.paper_gain.get(),
        )

    def draw_traces(self) -> None:
        self.ecg_axis.draw_artist(self.ecg_line)
        self.resp_axis.draw_artist(self.resp_line)
        self.canvas.blit(self.figure.bbox)

    def cache_plot_background(self, _event=None) -> None:
        self.plot_background = self.canvas.copy_from_bbox(self.figure.bbox)
        self.background_signature = self.plot_signature()
        self.draw_traces()

    def render_plot(self) -> None:
        if self.plot_background is None or self.background_signature != self.plot_signature():
            self.canvas.draw_idle()
        else:
            self.canvas.restore_region(self.plot_background)
            self.draw_traces()

    def display_seconds(self) -> float:
        if self.paper_mode.get():
            return PAPER_WIDTH_MM / float(self.paper_speed.get())
        return float(self.window_seconds.get())

    def configure_ecg_grid(self, start: float, end: float, values: np.ndarray) -> None:
        if not self.paper_mode.get():
            self.ecg_axis.set_title("")
            self.ecg_axis.set_ylabel("ECG (ADC counts)")
            self.ecg_axis.xaxis.set_major_locator(AutoLocator())
            self.ecg_axis.xaxis.set_major_formatter(ScalarFormatter())
            self.ecg_axis.xaxis.set_minor_locator(NullLocator())
            self.ecg_axis.yaxis.set_major_locator(AutoLocator())
            self.ecg_axis.yaxis.set_minor_locator(NullLocator())
            self.ecg_axis.grid(False, which="minor")
            self.ecg_axis.grid(True, which="major", alpha=0.25)
            self._scale_y(self.ecg_axis, values)
            return

        speed = float(self.paper_speed.get())
        gain = float(self.paper_gain.get())
        self.ecg_axis.set_ylabel("ECG (nominal mV)")
        self.ecg_axis.xaxis.set_major_locator(MultipleLocator(5 / speed))
        self.ecg_axis.xaxis.set_major_formatter(FuncFormatter(
            lambda value, _position: f"{value:g}" if abs(value * speed / 25 - round(value * speed / 25)) < 1e-6 else ""
        ))
        self.ecg_axis.xaxis.set_minor_locator(MultipleLocator(1 / speed))
        self.ecg_axis.yaxis.set_major_locator(MultipleLocator(5 / gain))
        self.ecg_axis.yaxis.set_minor_locator(MultipleLocator(1 / gain))
        center = float(np.median(values)) if len(values) else 0.0
        self.ecg_axis.set_ylim(center - PAPER_HEIGHT_MM / (2 * gain), center + PAPER_HEIGHT_MM / (2 * gain))
        self.ecg_axis.grid(True, which="minor", color="#f8d5d5", linewidth=0.5)
        self.ecg_axis.grid(True, which="major", color="#dc9696", linewidth=0.8)
        self.ecg_axis.set_title(
            f"Virtual paper: {speed:g} mm/s · {gain:g} mm/mV · {self.filter_mode.get()} (non-diagnostic)",
            fontsize=9,
        )

    def seek_history(self, value: str) -> None:
        if not self.samples:
            return
        offset = float(value)
        if offset < 0.25:
            self.history_mode = False
            self.history_label.configure(text="Live")
            self.pause_button.configure(text="Pause / zoom")
            return
        if not self.history_mode:
            self.history_anchor = self.samples[-1][0]
        self.history_mode = True
        self.history_dirty = True
        self.replay = False
        self.paused = False
        self.history_label.configure(text=f"−{offset:.1f} s")
        self.pause_button.configure(text="Return live")

    def toggle_recording(self) -> None:
        if self.recording:
            self.finish_recording()
            return
        self.recorded = []
        self.recording = True
        self.replay = False
        self.history_mode = False
        self.history_offset.set(0)
        self.history_label.configure(text="Live")
        self.paused = False
        self.record_button.configure(text="Stop & save")
        self.pause_button.configure(text="Pause / zoom")
        self.replay_scale.configure(state="disabled")
        self.record_status.set("Recording: 0 / 120 s")

    def finish_recording(self) -> None:
        if not self.recording:
            return
        self.recording = False
        self.record_button.configure(text="Record 2 min")
        if not self.recorded:
            self.record_status.set("No samples recorded")
            return
        folder = Path(__file__).resolve().parent / "recordings"
        folder.mkdir(exist_ok=True)
        prefix = "simulated" if self.demo else "ecg"
        path = folder / f"{prefix}_{datetime.now():%Y%m%d_%H%M%S}.csv"
        write_recording(path, self.recorded)
        duration = len(self.recorded) / SAMPLE_RATE
        self.record_status.set(f"Saved {duration:.1f} s locally: recordings/{path.name}")
        self.replay_scale.configure(to=duration, state="normal")
        self.replay_position.set(duration)
        self.replay_label.configure(text=f"{duration:.1f} / {duration:.1f} s")
        self.replay = True
        self.history_mode = False
        self.replay_dirty = True
        self.pause_button.configure(text="Return live")

    def seek_recording(self, value: str) -> None:
        if not self.recorded:
            return
        if not self.replay:
            self.replay = True
            self.pause_button.configure(text="Return live")
        duration = len(self.recorded) / SAMPLE_RATE
        self.replay_label.configure(text=f"{float(value):.1f} / {duration:.1f} s")
        self.replay_dirty = True

    def refresh(self) -> None:
        received = 0
        while received < 2000:
            try:
                kind, payload = self.events.get_nowait()
            except queue.Empty:
                break
            if kind == "status":
                self.status.set(payload)
            else:
                ecg, resp = payload
                t = self.sample_count / SAMPLE_RATE
                self.sample_count += 1
                self.samples.append((t, ecg))
                self.resp_samples.append((t, resp))
                if not self.continuous_failed:
                    try:
                        self.continuous_recorder.append(ecg, resp)
                    except OSError as exc:
                        self.continuous_failed = True
                        self.continuous_recorder.close()
                        self.continuous_status.set(f"Continuous logging stopped: {exc}")
                if self.recording:
                    self.recorded.append((ecg, resp))
                    if len(self.recorded) >= RECORD_SAMPLES:
                        self.finish_recording()
                received += 1

        if self.recording:
            self.record_status.set(f"Recording: {len(self.recorded) / SAMPLE_RATE:.1f} / 120 s")

        should_draw = (
            (self.replay and self.replay_dirty)
            or (self.history_mode and self.history_dirty)
            or (not self.replay and not self.history_mode and not self.paused and bool(self.samples))
            or (self.display_dirty and (self.replay or bool(self.samples)))
        )
        if should_draw:
            if self.replay:
                end = min(self.replay_position.get(), len(self.recorded) / SAMPLE_RATE)
                start = max(0, end - self.display_seconds())
                first = max(0, int(start * SAMPLE_RATE))
                last = min(len(self.recorded), int(end * SAMPLE_RATE))
                times = np.arange(first, last, dtype=float) / SAMPLE_RATE
                ecg = np.fromiter((v[0] for v in self.recorded[first:last]), dtype=float)
                resp_history = [(i / SAMPLE_RATE, v[1]) for i, v in enumerate(self.recorded[:last])]
                metric_ecg = np.fromiter((v[0] for v in self.recorded[:last]), dtype=float)
                metric_resp = np.fromiter((v[1] for v in self.recorded[:last] if v[1] is not None), dtype=float)
            elif self.history_mode:
                end = max(0, self.history_anchor - self.history_offset.get())
                start = max(0, end - self.display_seconds())
                visible = [(t, v) for t, v in self.samples if start <= t <= end]
                times = np.fromiter((p[0] for p in visible), dtype=float)
                ecg = np.fromiter((p[1] for p in visible), dtype=float)
                resp_history = [(t, v) for t, v in self.resp_samples if t <= end]
                metric_ecg = np.fromiter((v for t, v in self.samples if t <= end), dtype=float)
                metric_resp = np.fromiter((v for t, v in self.resp_samples if t <= end and v is not None), dtype=float)
            else:
                end = self.paused_anchor if self.paused else self.samples[-1][0]
                start = max(0, end - self.display_seconds())
                visible = [(t, v) for t, v in self.samples if start <= t <= end]
                times = np.fromiter((p[0] for p in visible), dtype=float)
                ecg = np.fromiter((p[1] for p in visible), dtype=float)
                resp_history = [(t, v) for t, v in self.resp_samples if t <= end]
                metric_ecg = np.empty(0)
                metric_resp = np.empty(0)
            live_view = not (self.replay or self.history_mode or self.paused)
            rescale = (
                self.display_dirty or not live_view
                or self.sample_count - self.last_scale_count >= SAMPLE_RATE
            )
            shown_ecg = filter_ecg_for_display(ecg, self.filter_mode.get())
            chart_ecg = counts_to_nominal_mv(shown_ecg) if self.paper_mode.get() else shown_ecg
            # Fixed relative-time axes let us blit traces without redrawing the
            # entire grid each frame. Rewind and saved clips keep absolute time.
            self.ecg_line.set_data(times - end if live_view else times, chart_ecg)
            self.ecg_axis.set_xlim(-self.display_seconds(), 0) if live_view else self.ecg_axis.set_xlim(start, max(end, start + 1))
            if rescale:
                self.configure_ecg_grid(start, end, chart_ecg)

            resp_times = np.fromiter((t for t, _ in resp_history), dtype=float)
            resp_raw = np.fromiter((np.nan if v is None else v for _, v in resp_history), dtype=float)
            resp_start = max(0, end - self.resp_window_seconds.get())
            resp_mask = (resp_times >= resp_start) & (resp_times <= end)
            self.resp_axis.set_xlim(-self.resp_window_seconds.get(), 0) if live_view else self.resp_axis.set_xlim(resp_start, max(end, resp_start + 1))
            self.resp_axis.set_xlabel("Seconds before newest sample (0 = now)" if live_view else "Time (s, approximate)")
            if np.any(np.isfinite(resp_raw[resp_mask])):
                resp = filter_resp_for_display(resp_raw, self.resp_filter_mode.get())[resp_mask]
                self.resp_line.set_data(resp_times[resp_mask] - end if live_view else resp_times[resp_mask], resp)
                self.resp_axis.texts[0].set_visible(False)
                raw_mode = self.resp_filter_mode.get() == "Raw"
                self.resp_axis.set_ylabel("CH1 (ADC counts)" if raw_mode else "CH1 change (counts)")
                self.resp_axis.set_title(f"{self.resp_filter_mode.get()} · {self.resp_window_seconds.get()} s · not calibrated impedance", fontsize=9)
                if rescale:
                    self._scale_y(self.resp_axis, resp)
                if self.replay or self.history_mode or self.sample_count - self.last_metrics_count >= 250:
                    all_resp = metric_resp if (self.replay or self.history_mode) else np.fromiter((v for _, v in self.resp_samples if v is not None), dtype=float)
                    if np.mean(np.abs(all_resp[-int(5 * SAMPLE_RATE):]) >= 8388000) > 0.01:
                        self.breathing.set("Breathing: CH1 clipped; no valid rate")
                    elif len(all_resp) < 25 * SAMPLE_RATE:
                        self.breathing.set("Breathing: collecting 25 s; source unverified")
                    else:
                        rate = estimate_breaths_per_minute(all_resp)
                        self.breathing.set(f"Breathing: {rate if rate is not None else '—'} /min (experimental)")
            else:
                self.resp_line.set_data([], [])
                self.resp_axis.texts[0].set_visible(True)
                self.breathing.set("Breathing: unavailable (ECG-only firmware)")

            if self.replay or self.history_mode or self.sample_count - self.last_metrics_count >= 250:
                all_ecg = metric_ecg if (self.replay or self.history_mode) else np.fromiter((v for _, v in self.samples), dtype=float)
                condition = ecg_signal_status(all_ecg)
                self.quality.set(f"Signal: {condition}; lead-off status unavailable")
                bpm = None if condition in ("ADC clipped", "Flat / no variation") else estimate_bpm(all_ecg)
                self.bpm.set(f"BPM: {bpm if bpm is not None else '—'} (experimental)")
                if not self.replay and not self.history_mode:
                    self.last_metrics_count = self.sample_count
            if rescale and live_view:
                self.last_scale_count = self.sample_count
            self.render_plot()
            self.replay_dirty = False
            self.history_dirty = False
            self.display_dirty = False
        if received:
            source = "SIMULATED (no hardware)" if self.demo else self.port
            queued = self.events.qsize()
            self.status.set(
                f"{source}: {self.sample_count:,} samples received; {SAMPLE_RATE:.0f} samples/s expected"
                f" · queued: {queued} (~{queued / SAMPLE_RATE:.2f} s at nominal rate)"
            )
            if not self.continuous_failed and self.sample_count % int(SAMPLE_RATE) < received:
                self.continuous_status.set(
                    f"Continuous logging: {self.continuous_recorder.total_samples / SAMPLE_RATE:.1f} s "
                    f"in recordings/{self.continuous_recorder.session.name}/"
                )
        self.root.after(REFRESH_INTERVAL_MS, self.refresh)

    @staticmethod
    def _scale_y(axis, values: np.ndarray) -> None:
        values = values[np.isfinite(values)]
        if len(values) == 0:
            return
        low, high = np.percentile(values, [1, 99])
        pad = max((high - low) * 0.15, 1)
        axis.set_ylim(low - pad, high + pad)

    def close(self) -> None:
        if self.recording:
            self.finish_recording()
        self.continuous_recorder.close()
        self.stop_event.set()
        self.root.destroy()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="COM4", help="ESP32 serial port (default: COM4)")
    parser.add_argument("--demo", action="store_true", help="Show simulated ECG without hardware")
    args = parser.parse_args()
    viewer = Viewer(args.port, demo=args.demo)
    viewer.root.mainloop()


if __name__ == "__main__":
    main()
