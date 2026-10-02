/** Facts about the ADS1292R + ESP32 bench board and the serial stream it emits. */

export const SAMPLE_RATE_HZ = 250;
export const BAUD_RATE = 115_200;

/** 24-bit two's-complement ADC range. */
export const ADC_MIN = -(2 ** 23);
export const ADC_MAX = 2 ** 23 - 1;
/** Samples within this many counts of either rail are treated as clipped. */
export const CLIP_MARGIN = 607;

/** Firmware configuration: 2.42 V internal reference, ECG channel PGA gain 4. */
export const VREF_V = 2.42;
export const ECG_PGA_GAIN = 4;
const MV_PER_COUNT = (1000 * VREF_V) / (ECG_PGA_GAIN * ADC_MAX);

/** Nominal input-referred millivolts from datasheet scaling, not a measured calibration. */
export function countsToMv(counts: number): number {
  return counts * MV_PER_COUNT;
}

export function isClipped(counts: number): boolean {
  return counts >= ADC_MAX - CLIP_MARGIN || counts <= ADC_MIN + CLIP_MARGIN;
}

/** USB-serial bridges found on common ESP32 boards. */
export const KNOWN_USB_SERIAL: readonly { vendorId: number; productId: number; name: string }[] = [
  { vendorId: 0x10c4, productId: 0xea60, name: 'Silicon Labs CP210x' },
  { vendorId: 0x1a86, productId: 0x7523, name: 'WCH CH340' },
  { vendorId: 0x1a86, productId: 0x55d4, name: 'WCH CH9102' },
  { vendorId: 0x0403, productId: 0x6001, name: 'FTDI FT232' },
  { vendorId: 0x303a, productId: 0x1001, name: 'Espressif USB serial' },
];

export function knownBridgeName(vendorId?: number, productId?: number): string | null {
  const match = KNOWN_USB_SERIAL.find((d) => d.vendorId === vendorId && d.productId === productId);
  return match ? match.name : null;
}
