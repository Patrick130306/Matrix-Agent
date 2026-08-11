/**
 * 计数信号量 —— §8.1 双信号量并发模型的原语。
 * 浏览器并发信号量保护用户机器性能；LLM 并发信号量保护用户自备 API key 的 rate limit。
 */
export class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];
  private max: number;

  constructor(max: number) {
    this.max = max;
    this.available = max;
  }

  setMax(max: number): void {
    const delta = max - this.max;
    this.max = max;
    if (delta > 0) {
      // 容量变大，唤醒等待者
      for (let i = 0; i < delta; i++) {
        const next = this.waiters.shift();
        if (!next) {
          this.available++;
        } else {
          next();
        }
      }
    } else {
      this.available = Math.min(this.available, max);
    }
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available = Math.min(this.available + 1, this.max);
    }
  }

  /** 在信号量保护下执行 fn，确保释放。 */
  async use<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
