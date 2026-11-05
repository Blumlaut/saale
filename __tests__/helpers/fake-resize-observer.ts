/**
 * jsdom has no layout, so a component that watches its own size is driven by
 * hand: the test fires the callback the browser would send after layout.
 */
export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  active = true;
  target: Element | null = null;

  constructor(private readonly cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element) {
    this.target = target;
  }

  disconnect() {
    this.active = false;
  }

  /** Report a resize, the way the browser does after layout. */
  fire() {
    if (this.active) this.cb();
  }
}

/**
 * Report a resize to the observers watching the transcript: its content, whose
 * growth is a message or a block unfolding, or its box, which the keyboard and
 * the composer resize.
 */
export function fireTranscriptResize(area: "content" | "box") {
  for (const observer of FakeResizeObserver.instances) {
    const watchesBox = observer.target?.matches(".overflow-y-auto") ?? false;
    if (watchesBox === (area === "box")) observer.fire();
  }
}
