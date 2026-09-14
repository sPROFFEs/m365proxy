// Synthetic transport used ONLY by worker lifecycle tests. Not a Copilot backend.
export class ModelSession {
  constructor(options) { this.options = options; this.turn = 0; }
  async run(prompt) {
    await this.options.getToken();
    if (this.options.useAgent !== false) throw new Error('Studio must be disabled.');
    this.turn++;
    if (prompt === 'prime_background') setTimeout(() => { this.backgroundToken = this.options.getToken(); this.backgroundToken.catch(() => {}); }, 20);
    if (prompt === 'wait_background') await this.backgroundToken;
    if (prompt === 'exit_later') setTimeout(() => process.exit(0), 20);
    if (prompt === 'never') await new Promise(() => {});
    if (prompt === 'spin') { for (;;) { /* Deliberately non-cooperative worker. */ } }
    if (prompt === 'raw_error') throw new Error('wss://example.invalid/?access_token=DO_NOT_LEAK');
    if (prompt === 'log') { console.log('DO_NOT_LEAK_STDOUT'); console.error('DO_NOT_LEAK_STDERR'); }
    if (prompt === 'gap') return { async *[Symbol.asyncIterator]() { yield 'first'; await new Promise(() => {}); } };
    const text = prompt === 'large' ? 'x'.repeat(2048) : `turn-${this.turn}`;
    return { fullText: text, messageType: 'Chat', throttle: { current: this.turn, max: 100 },
      async *[Symbol.asyncIterator]() { yield text; } };
  }
}
