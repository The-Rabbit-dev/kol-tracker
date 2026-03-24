'use strict';

/**
 * Simple Moving Average over the last `period` values of `data`.
 * @param {number[]} data
 * @param {number} period
 * @returns {number[]}  length = data.length - period + 1
 */
function sma(data, period) {
  if (data.length < period) return [];
  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

/**
 * Exponential Moving Average.
 * @param {number[]} data
 * @param {number} period
 * @returns {number[]}
 */
function ema(data, period) {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  // seed with SMA of first `period` values
  let prev = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(prev);
  for (let i = period; i < data.length; i++) {
    prev = data[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

/**
 * Clamp a number between min and max.
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Round to `decimals` decimal places.
 */
function round(value, decimals = 2) {
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
}

/**
 * Wilder's smoothing (used by ADX and ATR).
 * First value = sum of first `period` values, then running: sum - sum/period + next.
 * @param {number[]} arr
 * @param {number} period
 * @returns {number[]}
 */
function wilderSmooth(arr, period) {
  if (arr.length < period) return [];
  const result = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += arr[i];
  result.push(sum);
  for (let i = period; i < arr.length; i++) {
    sum = sum - (sum / period) + arr[i];
    result.push(sum);
  }
  return result;
}

/**
 * True Range for each bar starting at index 1.
 * TR = max(H-L, |H-prevC|, |L-prevC|)
 * @param {object[]} candles — normalized OHLCV, oldest first
 * @returns {number[]} — length = candles.length - 1
 */
function trueRange(candles) {
  const result = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    result.push(Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low  - prev.close)
    ));
  }
  return result;
}

module.exports = { sma, ema, clamp, round, wilderSmooth, trueRange };
