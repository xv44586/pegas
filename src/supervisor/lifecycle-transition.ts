export class LifecycleTransitionBarrier {
  #transition: Promise<void> | undefined

  begin(action: () => Promise<void>): Promise<void> {
    if (this.#transition) {
      return Promise.reject(
        new Error('A lifecycle transition is already in progress'),
      )
    }

    const transition = Promise.resolve().then(action)
    this.#transition = transition
    const clear = () => {
      if (this.#transition === transition) this.#transition = undefined
    }
    void transition.then(clear, clear)
    return transition
  }

  async wait(): Promise<void> {
    const transition = this.#transition
    if (!transition) return
    try {
      await transition
    } catch {
      // The recovery request receives the failure. The active release remains.
    }
  }
}
