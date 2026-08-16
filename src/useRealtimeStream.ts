/**
 * useRealtimeStream.ts
 * ------------------------------------------------------------
 * リアルタイムタブ用のデータ取得フック。
 *  1. マウント時に GET {baseUrl}/v1/bootstrap で観測点メタデータ+初期値を取得
 *  2. WS {baseUrl}/v1/stream に接続し、以降は差分バイナリを受信
 *  3. 受信値は毎回の再レンダーを避けるため ref に蓄積し、一定間隔
 *     (UPDATE_THROTTLE_MS)でまとめてReact stateへ反映する
 *     (station-points更新と同様、setDataの頻度を抑える狙い)
 *  4. タブが非アクティブ(enabled=false)の間は接続を張らない
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { decodeIntensityDelta, type IntensityEntry } from "./realtimeProtocolClient";

export interface RealtimeStation {
  id: number;
  source: "kmoni" | "snet";
  station_code: string;
  name: string;
  lat: number;
  lon: number;
}

export interface RealtimeStreamState {
  status: "idle" | "connecting" | "open" | "closed" | "error";
  stations: RealtimeStation[];
  // id -> 計測震度相当値(データが無い/無効化された観測点はキーごと存在しない)
  values: Map<number, number>;
  serverTime: string | null;
  lastError: string | null;
}

const UPDATE_THROTTLE_MS = 500;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export function useRealtimeStream(baseUrl: string, enabled: boolean, token?: string): RealtimeStreamState {
  const [state, setState] = useState<RealtimeStreamState>({
    status: "idle",
    stations: [],
    values: new Map(),
    serverTime: null,
    lastError: null,
  });

  // 受信値の実体はrefで持ち、setStateは間引いて呼ぶ
  const valuesRef = useRef<Map<number, number>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dirtyRef = useRef(false);
  const stoppedRef = useRef(false);

  const flush = useCallback(() => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    // Mapを複製してstateに渡す(参照を変えないとReactが変化を検知できないため)
    setState((prev) => ({ ...prev, values: new Map(valuesRef.current) }));
  }, []);

  const applyEntries = useCallback((entries: IntensityEntry[]) => {
    for (const e of entries) {
      if (e.intensity === null) {
        valuesRef.current.delete(e.id);
      } else {
        valuesRef.current.set(e.id, e.intensity);
      }
    }
    dirtyRef.current = true;
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    stoppedRef.current = false;

    const httpBase = baseUrl.replace(/\/$/, "");
    const wsBase = httpBase.replace(/^http/, "ws");

    let cancelled = false;

    async function bootstrap() {
      setState((prev) => ({ ...prev, status: "connecting", lastError: null }));
      try {
        const res = await fetch(`${httpBase}/v1/bootstrap`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) throw new Error(`bootstrap failed: ${res.status}`);
        const data = await res.json();
        if (cancelled) return;

        valuesRef.current = new Map(
          (data.values as Array<{ id: number; intensity: number }>).map((v) => [v.id, v.intensity])
        );

        setState((prev) => ({
          ...prev,
          stations: data.stations ?? [],
          values: new Map(valuesRef.current),
          serverTime: data.serverTime ?? null,
        }));

        connectWs();
      } catch (err) {
        if (cancelled) return;
        setState((prev) => ({ ...prev, status: "error", lastError: String(err) }));
        scheduleReconnect();
      }
    }

    function connectWs() {
      if (cancelled) return;
      const streamUrl = new URL(`${wsBase}/v1/stream`);
      if (token) streamUrl.searchParams.set("token", token);
      const ws = new WebSocket(streamUrl.toString());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        if (!cancelled) setState((prev) => ({ ...prev, status: "open", lastError: null }));
      };

      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        try {
          const msg = decodeIntensityDelta(ev.data);
          applyEntries(msg.entries);
        } catch (err) {
          // 1メッセージのデコード失敗で接続全体を落とす必要は無いので、
          // ログだけ残して読み飛ばす
          console.error("[realtime] decode error", err);
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, status: "closed" }));
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onerrorの後にoncloseも呼ばれるので、再接続スケジューリングは
        // oncloseに一本化する(ここでは状態更新のみ)
        if (!cancelled) setState((prev) => ({ ...prev, status: "error" }));
      };
    }

    function scheduleReconnect() {
      if (cancelled || stoppedRef.current) return;
      const attempt = reconnectAttemptRef.current++;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      reconnectTimerRef.current = setTimeout(() => {
        // bootstrapからやり直す(長時間切断していた場合、差分だけでは
        // 状態を正しく復元できないため)
        bootstrap();
      }, delay);
    }

    bootstrap();
    flushTimerRef.current = setInterval(flush, UPDATE_THROTTLE_MS);

    return () => {
      cancelled = true;
      stoppedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
      setState({ status: "idle", stations: [], values: new Map(), serverTime: null, lastError: null });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, enabled, token]);

  return state;
}
