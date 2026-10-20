import { describe, expect, it } from 'vitest';
import { sizeText } from './sizeText.js';

describe('sizeText', () => {
  it('writes whole bytes below a kilobyte and one decimal from there', () => {
    expect(sizeText(0)).toBe('0 B');
    expect(sizeText(1023)).toBe('1023 B');
    expect(sizeText(1024)).toBe('1.0 KB');
    expect(sizeText(2048)).toBe('2.0 KB');
    expect(sizeText(1536)).toBe('1.5 KB');
    expect(sizeText(3 * 1024 ** 2)).toBe('3.0 MB');
    expect(sizeText(2 * 1024 ** 3)).toBe('2.0 GB');
    expect(sizeText(5 * 1024 ** 4)).toBe('5.0 TB');
    expect(sizeText(5000 * 1024 ** 4)).toBe('5000.0 TB');
  });
});
