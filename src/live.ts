import { useEffect, useRef } from "react";

const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const DEBOUNCE_MS = 250;

/**
 * Calls `onChange` whenever the plan changes on the server, and after
 * reconnecting or returning to the tab (changes may have been missed).
 */
export function useLiveUpdates(onChange: () => void) {
  const callback = useRef(onChange);
  callback.current = onChange;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let stopped = false;
    let backoff = 1000;
    let retryTimer: number | undefined;
    let debounceTimer: number | undefined;
    let connectedBefore = false;

    const fire = () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => callback.current(), DEBOUNCE_MS);
    };

    const connect = () => {
      if (stopped) return;
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`;
      const ws = new WebSocket(url);
      socket = ws;
      ws.onopen = () => {
        backoff = 1000;
        if (connectedBefore) fire();
        connectedBefore = true;
      };
      ws.onmessage = (event) => {
        if (event.data !== "pong") fire();
      };
      ws.onclose = () => {
        if (stopped || socket !== ws) return;
        retryTimer = window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      };
    };

    const ping = window.setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
    }, PING_MS);

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      fire();
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        window.clearTimeout(retryTimer);
        backoff = 1000;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    connect();

    return () => {
      stopped = true;
      window.clearInterval(ping);
      window.clearTimeout(retryTimer);
      window.clearTimeout(debounceTimer);
      document.removeEventListener("visibilitychange", onVisible);
      socket?.close();
    };
  }, []);
}
