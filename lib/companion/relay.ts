import {
  HELLO_INTERVAL_MS,
  RELAY_FATAL_CLOSE_CODES,
  RELAY_MAX_RECONNECT_ATTEMPTS,
  TRANSCRIPT_EVENTS,
  TRANSCRIPT_KIND,
  WEB_SENDER,
  relayReconnectDelayMs,
  type RelayAuthFrame,
  type RelayJsonEnvelope,
  type TranscriptRelayStatus,
  type VisitTranscriptEvent,
  type VisitTranscriptPayload,
} from "@/lib/companion/protocol";

export type VisitTranscriptRelayCallbacks = {
  onStatus: (status: TranscriptRelayStatus) => void;
  onReady: () => void;
  onFrame: (payload: VisitTranscriptPayload) => void;
  onError?: (message: string) => void;
};

type ConnectOptions = {
  url: string;
  doctorId: string;
  token: string;
  visitId: string;
  callbacks: VisitTranscriptRelayCallbacks;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isVisitTranscriptPayload(value: unknown): value is VisitTranscriptPayload {
  if (!isObject(value)) return false;
  return (
    value.kind === TRANSCRIPT_KIND &&
    typeof value.visitId === "string" &&
    typeof value.event === "string" &&
    typeof value.sender === "string" &&
    isObject(value.data)
  );
}

export class VisitTranscriptRelay {
  private socket: WebSocket | null = null;
  private outbox: unknown[] = [];
  private authenticated = false;
  private disposed = false;
  private fatal = false;
  private reconnectAttempt = 0;
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private options: ConnectOptions;

  constructor(options: ConnectOptions) {
    this.options = options;
  }

  connect() {
    if (this.disposed || this.fatal) return;
    this.clearReconnectTimer();
    this.closeSocket();
    this.authenticated = false;
    this.setStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open relay";
      this.options.callbacks.onError?.(message);
      this.scheduleReconnect();
      return;
    }

    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket || this.disposed) return;
      this.setStatus("authenticating");
      const auth: RelayAuthFrame = {
        type: "auth",
        role: "listener",
        doctor_id: this.options.doctorId,
        token: this.options.token,
        session: this.options.visitId,
      };
      socket.send(JSON.stringify(auth));
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket || this.disposed) return;
      this.handleMessage(event.data);
    };

    socket.onerror = () => {
      if (this.socket !== socket || this.disposed) return;
      this.options.callbacks.onError?.("Companion relay socket error");
    };

    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      const wasAuthenticated = this.authenticated;
      this.socket = null;
      this.authenticated = false;
      this.stopHello();

      if (wasAuthenticated) {
        console.warn(
          "[companion-relay] closed",
          event.code,
          event.reason || "(no reason)",
          "wasClean=",
          event.wasClean
        );
      }

      if (this.disposed) {
        this.setStatus("closed");
        return;
      }

      if (this.fatal || RELAY_FATAL_CLOSE_CODES.has(event.code)) {
        this.fatal = true;
        this.setStatus("error");
        this.options.callbacks.onError?.(
          event.reason || `Companion relay rejected the connection (${event.code})`
        );
        return;
      }

      this.scheduleReconnect();
    };
  }

  publish(event: VisitTranscriptEvent, data: Record<string, unknown> = {}) {
    const envelope: RelayJsonEnvelope = {
      type: "json",
      payload: {
        kind: TRANSCRIPT_KIND,
        visitId: this.options.visitId,
        event,
        data,
        sender: WEB_SENDER,
        sentAt: Date.now(),
      },
    };
    this.sendOrQueue(envelope);
  }

  dispose() {
    this.disposed = true;
    this.fatal = true;
    this.outbox = [];
    this.clearReconnectTimer();
    this.stopHello();
    this.closeSocket();
    this.setStatus("closed");
  }

  private handleMessage(raw: unknown) {
    if (raw instanceof ArrayBuffer || raw instanceof Blob) {
      return;
    }
    if (typeof raw !== "string") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isObject(parsed) || typeof parsed.type !== "string") {
      return;
    }

    if (parsed.type === "authenticated") {
      this.authenticated = true;
      this.reconnectAttempt = 0;
      this.flushOutbox();
      this.setStatus("joined");
      this.startHello();
      this.options.callbacks.onReady();
      return;
    }

    if (parsed.type === "error") {
      const message =
        typeof parsed.message === "string" && parsed.message.trim()
          ? parsed.message.trim()
          : "Companion relay authentication failed";
      this.fatal = true;
      this.setStatus("error");
      this.options.callbacks.onError?.(message);
      this.closeSocket();
      return;
    }

    if (parsed.type !== "json") {
      return;
    }

    const payload = parsed.payload;
    if (!isVisitTranscriptPayload(payload)) return;
    if (payload.kind !== TRANSCRIPT_KIND) return;
    if (payload.sender === WEB_SENDER) return;
    if (payload.visitId !== this.options.visitId) return;

    this.options.callbacks.onFrame(payload);
  }

  private sendOrQueue(frame: unknown) {
    if (this.disposed || this.fatal) return;
    if (this.authenticated && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      return;
    }
    this.outbox.push(frame);
  }

  private flushOutbox() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    for (const frame of this.outbox) {
      this.socket.send(JSON.stringify(frame));
    }
    this.outbox = [];
  }

  private startHello() {
    this.stopHello();
    this.helloTimer = setInterval(() => {
      this.publish(TRANSCRIPT_EVENTS.hello);
    }, HELLO_INTERVAL_MS);
  }

  private stopHello() {
    if (this.helloTimer) {
      clearInterval(this.helloTimer);
      this.helloTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.disposed || this.fatal) return;
    if (this.reconnectAttempt >= RELAY_MAX_RECONNECT_ATTEMPTS) {
      this.setStatus("error");
      this.options.callbacks.onError?.("Companion relay reconnect attempts exhausted");
      return;
    }

    this.reconnectAttempt += 1;
    const delay = relayReconnectDelayMs(this.reconnectAttempt);
    this.setStatus("reconnecting");
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket() {
    const socket = this.socket;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, "cleanup");
    }
    this.socket = null;
    this.authenticated = false;
  }

  private setStatus(status: TranscriptRelayStatus) {
    this.options.callbacks.onStatus(status);
  }
}
