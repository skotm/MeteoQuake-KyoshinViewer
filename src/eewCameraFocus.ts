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
// 揺れ検知では、確定したイベントを1つ選んで「追従」する。追従中は、イベントの観測点が
// 増えて画面の端からはみ出しそうになったら、視点を調整する(MapCanvas.jsx)。
//  - 追従先は、確定済み(confirmed)で観測点の位置(detections)があるイベント。
//  - 追従中のイベントが残っている間は、別のイベントが現れても乗り換えない
//    (大きな地震で同じ地震が複数のイベントに分かれても、視点がふらつかない)。
//  - 追従中のイベントが無くなった(統合されて消えた/期限切れ)時は、その時点で最も大きい
//    確定イベントに乗り換える。確定イベントが1つも無くなれば追従を終える。次に確定した
//    イベントは「最初の検知」として改めて視点移動の対象になる(以前は直前の移動から
//    60秒以内だと動かず、リプレイや検知テストのやり直しで視点が動かない原因になっていた)。
export type ShakeEventForFollow = {
  id: number;
  confirmed?: boolean;
  pointCount?: number;
  detections?: { lat: number; lon: number }[];
};

export function pickShakeFollowTarget<T extends ShakeEventForFollow>(
  events: T[] | null | undefined,
  followedId: number | null,
): { target: T | null; switched: boolean } {
  const confirmed = (events || []).filter(e => e.confirmed && Array.isArray(e.detections) && e.detections.length > 0);
  if (confirmed.length === 0) return { target: null, switched: followedId != null };
  const current = confirmed.find(e => e.id === followedId);
  if (current) return { target: current, switched: false };
  const target = confirmed.reduce((a, b) => ((b.pointCount ?? 0) > (a.pointCount ?? 0) ? b : a));
  return { target, switched: true };
}
