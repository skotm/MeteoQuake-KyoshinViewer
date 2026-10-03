// 緊急地震速報(EEW)が発表された時に、地図の視点を震源へ移動させるかどうかの判定。
//
// 移動するのは「そのEEW(同じeventId)の第一報」と、「アプリを開いた時点で既に発表
// されていたEEW」だけ。続報(同じeventIdで報番号だけが進むもの)では動かさない。
// どちらも「このセッションで初めて見たeventId」という同じ条件で判定できる
// (起動時のバックフィルで取り込まれたEEWも、新規に届いたEEWも、eews配列に初めて
// 現れた時点で『初めて見たeventId』になる)。
//
// 取消報、および震源の緯度経度がまだ無い報は対象外で、「見た」ことにもしない
// (後続の報で緯度経度が付いた時点で、その報が移動の対象になる)。

export type EewForFocus = {
  id?: string;
  eventId?: string | null;
  cancelled?: boolean;
  latitude?: number | null;
  longitude?: number | null;
};

export function eewFocusKey(eew: EewForFocus): string {
  return String(eew.eventId ?? eew.id ?? "");
}

// focusedIds(既に視点移動の対象にしたeventIdの集合)を更新しつつ、今回新たに視点移動の
// 対象になったEEWを返す。
export function pickEewsToFocus<T extends EewForFocus>(eews: T[] | null | undefined, focusedIds: Set<string>): T[] {
  const picked: T[] = [];
  for (const eew of eews || []) {
    if (eew.cancelled || eew.latitude == null || eew.longitude == null) continue;
    const key = eewFocusKey(eew);
    if (!key || focusedIds.has(key)) continue;
    focusedIds.add(key);
    picked.push(eew);
  }
  return picked;
}

// ── 揺れ検知(shakeDetection.ts)のイベント ──────────────────────────────
// 揺れ検知カードが出る(= 確定した)イベントを初めて見た時に、そのイベントの
// 検知位置(centerLat/centerLon)へ視点を移動するための判定。
//  - 移動するのは、確定済み(confirmed)で、位置があり、このセッションで初めて見たイベントID。
//    続報(同じイベントの観測点数増加)では動かさない。
//  - 大きな地震では、同じ地震が複数のイベントに分かれて次々に確定することがある。直前の
//    視点移動から SHAKE_FOCUS_COOLDOWN_MS 以内に確定したイベントは、動かさず「見た」
//    ことにする(クールダウンが明けた後で遅れて動くのを防ぐ)。
//  - 同時に複数が新規になった場合は、観測点数が最も多いイベントへ移動する。
export const SHAKE_FOCUS_COOLDOWN_MS = 60000;

export type ShakeEventForFocus = {
  id: number;
  confirmed?: boolean;
  pointCount?: number;
  centerLat?: number | null;
  centerLon?: number | null;
};

export function pickShakeEventToFocus<T extends ShakeEventForFocus>(
  events: T[] | null | undefined,
  focusedIds: Set<number>,
  nowMs: number,
  lastFocusAtMs: number | null,
): T | null {
  let best: T | null = null;
  for (const ev of events || []) {
    if (!ev.confirmed || ev.centerLat == null || ev.centerLon == null || focusedIds.has(ev.id)) continue;
    focusedIds.add(ev.id);
    if (!best || (ev.pointCount ?? 0) > (best.pointCount ?? 0)) best = ev;
  }
  if (best && lastFocusAtMs != null && nowMs - lastFocusAtMs < SHAKE_FOCUS_COOLDOWN_MS) return null;
  return best;
}
