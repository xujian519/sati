import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(import.meta.dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

function makeSeries(episodes, fn) {
  return Array.from({ length: episodes }, (_, i) => +fn(i, episodes).toFixed(4));
}

function smooth(arr, w = 20) {
  return arr.map((_, i) => {
    const start = Math.max(0, i - w + 1);
    const slice = arr.slice(start, i + 1);
    return +(slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(4);
  });
}

function genRun(algorithm, env, seed) {
  const episodes = env === 'Humanoid' ? 500 : env === 'CartPole' ? 300 : 400;
  const rng = (n) => {
    let s = seed * 1000 + n;
    return () => {
      s = (s * 16807 + 0) % 2147483647;
      return (s % 1000) / 1000;
    };
  };
  const r = rng(algorithm.length + env.length);

  const base =
    env === 'Humanoid'
      ? 200 + seed * 2
      : env === 'CartPole'
        ? 50 + seed
        : 80 + seed * 0.5;
  const algoBoost = { PPO: 1, SAC: 1.05, TD3: 0.95, DDPG: 0.9, A2C: 0.85 }[algorithm] ?? 1;

  const ep_reward = makeSeries(episodes, (i) => {
    const progress = i / episodes;
    const noise = (r() - 0.5) * (env === 'Humanoid' ? 40 : 15);
    return base * algoBoost * (0.3 + 0.7 * progress) + noise;
  });

  const loss = makeSeries(episodes, (i) => {
    const decay = Math.exp(-i / (episodes * 0.4));
    return (2 + r()) * decay + 0.02;
  });

  const fps = makeSeries(episodes, () => 800 + r() * 400 + (algorithm === 'SAC' ? -100 : 0));

  return {
    algorithm,
    env,
    seed,
    ep_reward,
    ep_reward_mean: smooth(ep_reward),
    loss,
    value_loss: loss.map((v) => +(v * 0.6).toFixed(4)),
    policy_loss: loss.map((v) => +(v * 0.35).toFixed(4)),
    entropy: makeSeries(episodes, (i) => 0.5 * Math.exp(-i / episodes) + 0.05 + r() * 0.02),
    success_rate: makeSeries(episodes, (i) => Math.min(1, (i / episodes) * 0.9 + r() * 0.1)),
    learning_rate: makeSeries(episodes, (i) => 3e-4 * Math.pow(0.995, Math.floor(i / 10))),
    fps,
  };
}

const files = [
  ['PPO', 'Humanoid', [42, 123, 456]],
  ['SAC', 'Humanoid', [42, 123, 456]],
  ['PPO', 'CartPole', [42, 123, 456]],
  ['SAC', 'CartPole', [42, 123, 456]],
  ['TD3', 'CartPole', [42, 123, 456]],
  ['PPO', 'Pendulum', [42, 123]],
  ['SAC', 'Pendulum', [42, 123]],
  ['DDPG', 'CartPole', [42, 123]],
  ['A2C', 'CartPole', [42]],
];

for (const [algo, env, seeds] of files) {
  for (const seed of seeds) {
    const name = `${algo}_${env}_${seed}.json`;
    writeFileSync(join(DATA_DIR, name), JSON.stringify(genRun(algo, env, seed), null, 2));
  }
}
