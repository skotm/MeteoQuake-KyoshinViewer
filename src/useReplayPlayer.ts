/**
 * useReplayPlayer.ts
 * ------------------------------------------------------------
 * バックフィルサーバーで生成したリプレイファイル(protocol.tsと同じ
 * バイナリ形式: ベースラインフレーム1個+差分フレームの連結)を読み込み、
 * 再生する。
 *
 * ファイル形式はリアルタイム配信(/v1/stream)のフレームをそのまま
 * 連結したものなので、デコード自体は realtimeProtocolClient.ts の
 * decodeIntensityDelta をそのまま使い回せる。
 *
 * 再生の考え方:
 *  - 1フレーム目(ベースライン)は全観測点の値を含む
 *  - 2フレーム目以降は「直前との差分」なので、ある時点の値を知るには
 *    先頭から currentIndex 番目までの差分を順に適用(累積)する必要がある
 *  - フレーム数が多い(数千)ケースを想定し、毎回先頭から再生し直すのは
 *    非効率なので、直前のindexからの差分だけを適用する(前進再生時)。
 *    巻き戻し(scrubで過去に戻る)の場合のみ、ベースラインから再計算する。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { decodeIntensityDelta, type IntensityDeltaMessage } from "./realtimeProtocolClient";

export interface ReplayState {
  loaded: boolean;
  fileName: string | null;
  frames: IntensityDeltaMessage[];
  currentIndex: number; // 0 = ベースラインフレームのみ適用した状態
  isPlaying: boolean;
  speed: number; // 再生速度倍率(1 = 等倍)
  values: Map<number, number>; // currentIndex時点での全観測点の値
  error: string | null;
}

const DEFAULT_SPEED = 4; // リプレイは早送りで見たいことが多いため、デフォルトを等倍より速くしておく

function parseReplayBuffer(buf: ArrayBuffer): IntensityDeltaMessage[] {
  const frames: IntensityDeltaMessage[] = [];
  let offset = 0;
  const view = new DataView(buf);

  while (offset < buf.byteLength) {
    if (buf.byteLength - offset < 7) {
      throw new Error(`フレームヘッダが不完全です(残り${buf.byteLength - offset}byte)`);
    }
    const entryCount = view.getUint16(offset + 5, true);
    const frameSize = 7 + entryCount * 4;
    if (offset + frameSize > buf.byteLength) {
      throw new Error(`フレーム長が不正です(offset=${offset}, frameSize=${frameSize}, total=${buf.byteLength})`);
    }
    const frameBuf = buf.slice(offset, offset + frameSize);
    frames.push(decodeIntensityDelta(frameBuf));
    offset += frameSize;
  }

  if (frames.length === 0) {
    throw new Error("フレームが1件もありません(空のファイル)");
  }

  return frames;
}

/** frames[0](ベースライン)からindex番目までの差分を適用した値を計算する */
function computeValuesAt(frames: IntensityDeltaMessage[], index: number): Map<number, number> {
  const values = new Map<number, number>();
  for (let i = 0; i <= index && i < frames.length; i++) {
    for (const entry of frames[i].entries) {
      if (entry.intensity === null) values.delete(entry.id);
      else values.set(entry.id, entry.intensity);
    }
  }
  return values;
}

export interface ReplayPlayer extends ReplayState {
  loadFile: (file: File) => Promise<void>;
  play: () => void;
  pause: () => void;
  seek: (index: number) => void;
  setSpeed: (speed: number) => void;
  close: () => void;
}

export function useReplayPlayer(): ReplayPlayer {
  const [state, setState] = useState<ReplayState>({
    loaded: false,
    fileName: null,
    frames: [],
    currentIndex: 0,
    isPlaying: false,
    speed: DEFAULT_SPEED,
    values: new Map(),
    error: null,
  });

  // 直前に適用した値(累積結果)をrefでも保持し、1コマ進める時に
  // 全フレーム再計算せず直前の状態から差分だけ足せるようにする。
  const valuesRef = useRef<Map<number, number>>(new Map());
  const framesRef = useRef<IntensityDeltaMessage[]>([]);
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFile = useCallback(async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const frames = parseReplayBuffer(buf);
      framesRef.current = frames;
      valuesRef.current = computeValuesAt(frames, 0);
      setState({
        loaded: true,
        fileName: file.name,
        frames,
        currentIndex: 0,
        isPlaying: false,
        speed: DEFAULT_SPEED,
        values: new Map(valuesRef.current),
        error: null,
      });
    } catch (e) {
      setState((prev) => ({ ...prev, loaded: false, error: String(e) }));
    }
  }, []);

  const seek = useCallback((index: number) => {
    const frames = framesRef.current;
    if (frames.length === 0) return;
    const clamped = Math.min(Math.max(index, 0), frames.length - 1);
    valuesRef.current = computeValuesAt(frames, clamped);
    setState((prev) => ({ ...prev, currentIndex: clamped, values: new Map(valuesRef.current) }));
  }, []);

  const play = useCallback(() => setState((prev) => ({ ...prev, isPlaying: true })), []);
  const pause = useCallback(() => setState((prev) => ({ ...prev, isPlaying: false })), []);
  const setSpeed = useCallback((speed: number) => setState((prev) => ({ ...prev, speed })), []);

  const close = useCallback(() => {
    framesRef.current = [];
    valuesRef.current = new Map();
    if (playTimerRef.current) clearTimeout(playTimerRef.current);
    setState({
      loaded: false,
      fileName: null,
      frames: [],
      currentIndex: 0,
      isPlaying: false,
      speed: DEFAULT_SPEED,
      values: new Map(),
      error: null,
    });
  }, []);

  // 再生タイマー: 各フレームの実際の観測間隔(dataTimeの差)を、speed倍率で
  // 圧縮/伸長した待ち時間だけ待ってから次のフレームへ進める。
  useEffect(() => {
    if (!state.isPlaying) return;
    const frames = framesRef.current;
    if (frames.length === 0 || state.currentIndex >= frames.length - 1) {
      setState((prev) => ({ ...prev, isPlaying: false }));
      return;
    }

    const current = frames[state.currentIndex];
    const next = frames[state.currentIndex + 1];
    const realIntervalMs = Math.max(0, next.dataTime.getTime() - current.dataTime.getTime());
    // 間隔が異常に長い(録画の谷間などで)場合、体感速度のため上限を設ける
    const cappedIntervalMs = Math.min(realIntervalMs, 5000);
    const waitMs = Math.max(16, cappedIntervalMs / state.speed);

    playTimerRef.current = setTimeout(() => {
      const nextIndex = state.currentIndex + 1;
      for (const entry of frames[nextIndex].entries) {
        if (entry.intensity === null) valuesRef.current.delete(entry.id);
        else valuesRef.current.set(entry.id, entry.intensity);
      }
      setState((prev) => ({ ...prev, currentIndex: nextIndex, values: new Map(valuesRef.current) }));
    }, waitMs);

    return () => {
      if (playTimerRef.current) clearTimeout(playTimerRef.current);
    };
  }, [state.isPlaying, state.currentIndex, state.speed]);

  return { ...state, loadFile, play, pause, seek, setSpeed, close };
}
