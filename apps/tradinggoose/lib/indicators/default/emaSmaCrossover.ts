import { createDefaultIndicator } from '../create-default-indicator'

const emaSmaCrossover = createDefaultIndicator({
  id: 'EMASMA_CROSS',
  name: 'EMA/SMA Crossover',
  pineCode: `
indicator('EMA/SMA Crossover', { overlay: true });

const emaLength = input.int(12, 'EMA Length');
const smaLength = input.int(26, 'SMA Length');
const showCrossMarkers = input.bool(true, 'Show Cross Markers');

const ema = ta.ema(close, emaLength);
const sma = ta.sma(close, smaLength);

const bullishCross = ta.crossover(ema, sma);
const bearishCross = ta.crossunder(ema, sma);

trigger('ema_sma_cross_long', {
  condition: bullishCross,
  input: 'EMA crossed above SMA',
  signal: 'long',
  position: 'belowBar',
  color: '#22c55e',
});

trigger('ema_sma_cross_short', {
  condition: bearishCross,
  input: 'EMA crossed below SMA',
  signal: 'short',
  position: 'aboveBar',
  color: '#ef4444',
});

plot(ema, 'EMA');
plot(sma, 'SMA');

plotshape(showCrossMarkers ? bullishCross : na, {
  title: 'Bullish Cross',
  style: shape.triangleup,
  location: location.belowbar,
  color: '#22c55e',
  size: size.small,
});

plotshape(showCrossMarkers ? bearishCross : na, {
  title: 'Bearish Cross',
  style: shape.triangledown,
  location: location.abovebar,
  color: '#ef4444',
  size: size.small,
});`,
})

export default emaSmaCrossover
