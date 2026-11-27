// Example extension for TweenSlop Studio. Load this file from the Plugins panel.
export default {
  id: 'sample-soft-pulse',
  name: 'Мягкий пульс · пример',
  description: 'Небольшое дышащее масштабирование как пример пользовательского эффекта.',
  type: 'effect',
  defaults: { amount: 0.025, speed: 1.4 },
  controls: [
    { key: 'amount', label: 'Амплитуда', type: 'range', min: 0, max: 0.12, step: 0.005, default: 0.025 },
    { key: 'speed', label: 'Скорость', type: 'range', min: 0.3, max: 4, step: 0.1, default: 1.4 },
  ],
  transformScale({ time, settings }) {
    const amount = Math.max(0, Number(settings.amount) || 0);
    const speed = Math.max(0.1, Number(settings.speed) || 1);
    return 1 + amount * Math.sin(time * speed * Math.PI * 2);
  },
};
