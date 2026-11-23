if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {
      return undefined
    }
    unobserve(): void {
      return undefined
    }
    disconnect(): void {
      return undefined
    }
  }
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    const list: MediaQueryList = {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject | null,
      ) => {
        if (typeof listener === 'function') listeners.add(listener)
      },
      removeEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject | null,
      ) => {
        if (typeof listener === 'function') listeners.delete(listener)
      },
      dispatchEvent: event => {
        if (!(event instanceof Event)) return false
        const changeEvent = event as MediaQueryListEvent
        for (const listener of listeners) listener(changeEvent)
        return true
      },
    } as MediaQueryList
    return list
  }
}

if (
  typeof Element !== 'undefined' &&
  typeof Element.prototype.scrollIntoView !== 'function'
) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    return undefined
  }
}

export {}
