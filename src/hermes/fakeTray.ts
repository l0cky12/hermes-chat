import { act } from "@testing-library/react";
import type { TrayStatus, TrayWiring } from "./tauriTray";

export class FakeTray implements TrayWiring {
  stored: TrayStatus;
  counts: number[] = [];
  failWrite?: string;
  constructor(stored: TrayStatus = { closeToTray: false, tray: "shown" }) {
    this.stored = stored;
  }
  private fns = { status: new Set<(s: TrayStatus) => void>(), newChat: new Set<() => void>(), inbox: new Set<() => void>() };
  status = async () => ({ ...this.stored });
  setCloseToTray = async (on: boolean) => {
    if (this.failWrite) throw new Error(this.failWrite);
    this.stored = { ...this.stored, closeToTray: on };
    return { ...this.stored };
  };
  onStatus = (fn: (s: TrayStatus) => void) => this.on(this.fns.status, fn);
  onNewChat = (fn: () => void) => this.on(this.fns.newChat, fn);
  onOpenInbox = (fn: () => void) => this.on(this.fns.inbox, fn);
  reportInbox = (n: number) => void this.counts.push(n);
  pick(item: "newChat" | "inbox") {
    act(() => this.fns[item].forEach((f) => f()));
  }
  change(s: Partial<TrayStatus>) {
    this.stored = { ...this.stored, ...s };
    act(() => this.fns.status.forEach((f) => f({ ...this.stored })));
  }
  private on<F>(set: Set<F>, fn: F) {
    set.add(fn);
    return () => void set.delete(fn);
  }
}
