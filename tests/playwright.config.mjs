export default {
  testDir: '.',
  testMatch: /(extension|approval)\.test\.mjs/,
  timeout: 90_000,
  // Each test boots its own Chrome with a fresh profile; running those in
  // parallel fights over the wasm compile and the CPU more than it saves.
  workers: 2,
  reporter: [['list']],

};
