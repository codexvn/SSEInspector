import { RecorderUiEvent } from './protocol';

export class RecorderUiEventBuffer {
  private readonly structuralEvents: RecorderUiEvent[] = [];
  private readonly snapshots = new Map<string, RecorderUiEvent>();

  push(event: RecorderUiEvent): void {
    if (event.structural) {
      this.snapshots.delete(event.recordId);
      this.structuralEvents.push(event);
      return;
    }
    this.snapshots.set(event.recordId, event);
  }

  shift(): RecorderUiEvent | undefined {
    const structural = this.structuralEvents.shift();
    if (structural) return structural;
    const first = this.snapshots.entries().next().value as [string, RecorderUiEvent] | undefined;
    if (!first) return undefined;
    this.snapshots.delete(first[0]);
    return first[1];
  }

  get empty(): boolean {
    return this.structuralEvents.length === 0 && this.snapshots.size === 0;
  }
}
