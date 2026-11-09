import { describe, expect, it } from 'vitest';
import { fromHalalas, groupDigits, isZero, share, subtract, sum, toHalalas } from './money';

describe('money stays exact', () => {
  it('reads amounts as whole halalas', () => {
    expect(toHalalas('3450.00')).toBe(345000n);
    expect(toHalalas('1280.5')).toBe(128050n);
    expect(toHalalas('0')).toBe(0n);
    expect(toHalalas('-12.30')).toBe(-1230n);
    expect(() => toHalalas('12.345')).toThrow();
    expect(() => toHalalas('1e3')).toThrow();
    expect(fromHalalas(128050n)).toBe('1280.50');
  });

  it('adds and subtracts without rounding errors', () => {
    // 0.1 + 0.2 in floating point is 0.30000000000000004
    expect(sum(['0.10', '0.20'])).toBe('0.30');
    expect(sum(['3450.00', '1280.50', '2100.00', null])).toBe('6830.50');
    expect(subtract('2500.00', '1500.00')).toBe('1000.00');
    expect(isZero('0.00')).toBe(true);
    expect(isZero(null)).toBe(true);
  });

  it('gives shares with one decimal, rounded half up', () => {
    expect(share('4700.00', '10830.50')).toBe('43.4');
    expect(share('1', '3')).toBe('33.3');
    expect(share('2', '3')).toBe('66.7');
    expect(share('5', '0')).toBeNull();
    expect(share('10830.50', '10830.50')).toBe('100.0');
  });

  it('groups digits from the text', () => {
    expect(groupDigits('1234567.80')).toBe('1,234,567.80');
    expect(groupDigits('3450.00')).toBe('3,450');
    expect(groupDigits('3450.00', { decimals: true })).toBe('3,450.00');
    expect(groupDigits('999')).toBe('999');
  });
});
